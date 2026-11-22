import fs from 'node:fs';

interface EngineSlotGlobalState {
  __arckepEngineSlotState?: {
    draining: boolean;
  };
}

const globalForEngineSlot = globalThis as unknown as EngineSlotGlobalState;

export const resolveConfiguredSlotName = (): string =>
  (process.env.SLOT_NAME || process.env.LOBECHAT_SLOT || '').trim();

export const resolveEngineStateFilePath = (): string =>
  (
    process.env.ENGINE_STATE_FILE ||
    process.env.LOBECHAT_STATE_FILE ||
    process.env.ROUTER_STATE_FILE ||
    '/var/lib/lobechat-engine/state.json'
  ).trim();

/**
 * Determines whether this process must start in `draining = true` mode (`SandboxJobWorker` paused).
 *
 * When `SLOT_NAME` (or `LOBECHAT_SLOT`) is set (`blue` / `green` from `.slot.env`), the slot
 * ONLY starts active if `/var/lib/lobechat-engine/state.json` exists and explicitly names this
 * slot as `activeSlot`. Unverified deploy candidates, restarted draining slots, and non-active
 * slots after reboot all start paused in `draining = true` until `POST /arckep/engine-slot/undrain`.
 */
export const shouldSlotStartDraining = (): boolean => {
  const slotName = resolveConfiguredSlotName();
  if (!slotName) return false;

  const statePath = resolveEngineStateFilePath();
  if (!statePath) return true;

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as { activeSlot?: unknown };
    return parsed?.activeSlot !== slotName;
  } catch {
    return true;
  }
};

const getOrInitSlotState = () => {
  if (!globalForEngineSlot.__arckepEngineSlotState) {
    globalForEngineSlot.__arckepEngineSlotState = {
      draining: shouldSlotStartDraining(),
    };
  }
  return globalForEngineSlot.__arckepEngineSlotState;
};

export const isEngineSlotDraining = (): boolean => getOrInitSlotState().draining;

export const setEngineSlotDraining = (draining: boolean): void => {
  getOrInitSlotState().draining = draining;
};

export const initEngineSlotStateFromDisk = (): boolean => {
  const draining = shouldSlotStartDraining();
  globalForEngineSlot.__arckepEngineSlotState = { draining };
  return draining;
};

export const resetEngineSlotStateForTests = (): void => {
  delete globalForEngineSlot.__arckepEngineSlotState;
};
