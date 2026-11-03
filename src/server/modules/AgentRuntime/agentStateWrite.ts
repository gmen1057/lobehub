import type { AgentState } from '@lobechat/agent-runtime';

/** Late progress is retained, but it must never restart an interrupted operation. */
export const preserveInterruption = (previous: AgentState | undefined, next: AgentState) => {
  if (previous?.interruption?.reason === 'user_cancelled') {
    next.status = 'interrupted';
    next.interruption = previous.interruption;
  }
};

// State, history and metadata share one Redis transaction. In particular, Stop
// cannot land between a state read and a late worker's unconditional SETEX.
export const WRITE_AGENT_STATE = `
local previousJson = redis.call('GET', KEYS[1])
local previous = previousJson and cjson.decode(previousJson) or nil
local previousStatus = redis.call('HGET', KEYS[2], 'status') or (previous and previous.status)
local cancelledAt = redis.call('HGET', KEYS[2], 'cancelledAt') or ''
local state
local serialized
if ARGV[1] == 'interrupt' then
  if not previous or previousStatus == 'done' or previousStatus == 'error' or cancelledAt ~= '' or
    (previousStatus == 'interrupted' and not (previous.interruption and previous.interruption.canResume == true)) then
    return false
  end
  state = previous
  state.status = 'interrupted'
  cancelledAt = ARGV[4]
  redis.call('HSET', KEYS[2], 'cancelledAt', cancelledAt)
  serialized = previousJson
else
  state = cjson.decode(ARGV[2])
  state.status = ARGV[7]
  if cancelledAt ~= '' then state.status = 'interrupted' end
  -- Never re-encode the whole state with cjson: it turns empty arrays into objects.
  local prefix = string.sub(ARGV[2], 1, -2)
  serialized = prefix .. (ARGV[2] == '{}' and '' or ',') .. '"status":' .. cjson.encode(state.status) .. '}'
end
redis.call('SETEX', KEYS[1], ARGV[3], serialized)
redis.call('HMSET', KEYS[2], 'lastActiveAt', ARGV[4], 'status', state.status,
  'totalCost', type(state.cost) == 'table' and state.cost.total or 0, 'totalSteps', state.stepCount or 0)
redis.call('EXPIRE', KEYS[2], ARGV[3])
if ARGV[1] == 'interrupt' then
  -- Commit the control event with the status. A crash before the coordinator's
  -- normal UI end event must not leave a paid request running without a signal.
  redis.call('XADD', KEYS[5], 'MAXLEN', '~', '1000', '*',
    'type', 'operation_interrupted', 'stepIndex', state.stepCount or 0,
    'operationId', ARGV[8], 'data', '{}', 'timestamp', ARGV[9])
  redis.call('EXPIRE', KEYS[5], ARGV[3])
end
if ARGV[5] ~= '' then
  local step = string.sub(ARGV[5], 1, -2) .. ',"status":' .. cjson.encode(state.status) .. '}'
  redis.call('LPUSH', KEYS[3], step)
  redis.call('LTRIM', KEYS[3], 0, 199)
  redis.call('EXPIRE', KEYS[3], ARGV[3])
end
if ARGV[6] ~= '' then
  redis.call('LPUSH', KEYS[4], ARGV[6])
  redis.call('LTRIM', KEYS[4], 0, 199)
  redis.call('EXPIRE', KEYS[4], ARGV[3])
end
return {serialized, state.status, ARGV[4], cancelledAt}
`;

// Metadata is the authoritative status, including cancellation of an older JSON
// snapshot. Read both atomically so a worker never observes mismatched versions.
export const READ_AGENT_STATE = `
local state = redis.call('GET', KEYS[1])
if not state then return false end
return {state, redis.call('HGET', KEYS[2], 'status') or '', redis.call('HGET', KEYS[2], 'lastActiveAt') or '', redis.call('HGET', KEYS[2], 'cancelledAt') or ''}
`;

export const decodeAgentState = (result: unknown): AgentState | null => {
  if (!Array.isArray(result)) return null;
  const state = JSON.parse(result[0]) as AgentState;
  if (result[1]) state.status = result[1];
  if (state.status === 'interrupted' && result[2]) state.lastModified = result[2];
  if (result[3])
    state.interruption = {
      canResume: false,
      interruptedAt: result[3],
      reason: 'user_cancelled',
    };
  return state;
};
