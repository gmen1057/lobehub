import { toolsClient } from '@/libs/trpc/client';
import {
  type CallToolResult,
  type ExecInSandboxInput,
  type ExportAndUploadFileInput,
  type ExportAndUploadFileResult,
} from '@/server/routers/tools/market';

const TERMINAL_STATES = new Set(['success', 'error', 'timeout', 'cancelled']);

const POLL_INITIAL_DELAY_MS = 1_000;
const POLL_MAX_DELAY_MS = 30_000;
const POLL_MAX_ELAPSED_MS = 30 * 60_000; // 30 min hard ceiling — matches sandbox_jobs.expires_at default
const ENQUEUE_DETECT_TIMEOUT_MS = 10_000; // server-side enqueue should be near-instant; bail after 10s

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const buildErrorResult = (message: string, name: string, body?: unknown): CallToolResult => ({
  error: { message, name },
  result: body ?? null,
  sessionExpiredAndRecreated: false,
  success: false,
});

const buildSuccessResultFromPayload = (resultPayload: unknown): CallToolResult => {
  // Worker writes { content, result, state } in resultPayload. Surface text via result.output
  // for parity with the legacy execInSandbox sync handler.
  if (resultPayload && typeof resultPayload === 'object') {
    const payload = resultPayload as Record<string, unknown>;
    const innerResult = payload.result as Record<string, unknown> | undefined;

    if (innerResult && typeof innerResult === 'object') {
      return {
        result: innerResult,
        sessionExpiredAndRecreated: false,
        success: true,
      };
    }

    const content = typeof payload.content === 'string' ? payload.content : '';
    return {
      result: { output: content, success: true },
      sessionExpiredAndRecreated: false,
      success: true,
    };
  }

  return {
    result: { output: '', success: true },
    sessionExpiredAndRecreated: false,
    success: true,
  };
};

class CloudSandboxService {
  /**
   * Call a cloud sandbox tool via the durable async runner.
   *
   * Server-side enqueue in MessageService.updateMessage (Block C) creates the
   * sandbox_jobs row atomically with messages.tools[] commit. This method
   * looks up the existing job by tool_call_id and polls until terminal state.
   *
   * Resilience:
   * - If no job is found within ENQUEUE_DETECT_TIMEOUT_MS, treats it as
   *   "execution lost" and returns an error (server-side enqueue should be
   *   near-instant; absence after 10s indicates a real failure).
   * - Polling uses exponential backoff (1s → 30s) with hard ceiling of 30 min,
   *   matching sandbox_jobs.expires_at default.
   *
   * @param toolName - kept for legacy compat; resolution by tool_call_id only
   * @param params - kept for legacy compat; args persisted by Block C enqueue
   * @param context - { toolCallId required, topicId, userId optional }
   */
  async callTool(
    toolName: string,
    params: Record<string, any>,
    context: { toolCallId?: string; topicId: string; userId?: string },
  ): Promise<CallToolResult> {
    if (!context.toolCallId) {
      // Legacy callers without tool_call_id (e.g. dev tooling) still get the sync path.
      const input: ExecInSandboxInput = {
        params,
        toolName,
        topicId: context.topicId,
        userId: context.userId,
      };
      return toolsClient.market.execInSandbox.mutate(input);
    }

    const { toolCallId } = context;
    const startedAt = Date.now();

    // Phase 1 — wait for server-side enqueue to land (near-instant, but tolerate up to 10s).
    const job = await this.waitForEnqueue(toolCallId, ENQUEUE_DETECT_TIMEOUT_MS);
    if (!job) {
      return buildErrorResult(
        'Sandbox execution lost — server did not enqueue this tool call',
        'ExecutionLost',
      );
    }

    // Phase 2 — if already terminal (server-side worker finished before client got here), short-circuit.
    if (TERMINAL_STATES.has(job.state)) {
      return this.toCallToolResult(job);
    }

    // Phase 3 — poll until terminal with exponential backoff.
    let delay = POLL_INITIAL_DELAY_MS;
    while (true) {
      await sleep(delay);

      const fresh = await toolsClient.market.findSandboxJobByToolCallId.query({ toolCallId });
      if (!fresh) {
        // Lost the job — should never happen post-enqueue, but guard against it.
        return buildErrorResult('Sandbox job vanished during execution', 'JobMissing');
      }

      if (TERMINAL_STATES.has(fresh.state)) {
        return this.toCallToolResult(fresh);
      }

      if (Date.now() - startedAt > POLL_MAX_ELAPSED_MS) {
        return buildErrorResult(
          `Sandbox polling exceeded ${POLL_MAX_ELAPSED_MS / 60_000} minutes`,
          'PollTimeout',
        );
      }

      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }
  }

  /**
   * Export a file from sandbox and upload to S3, then create a persistent file record.
   * This path remains synchronous — exportAndUploadFile finishes in <2s and is not
   * subject to the same browser-close failure mode as long sandbox executions.
   */
  async exportAndUploadFile(
    path: string,
    filename: string,
    topicId: string,
  ): Promise<ExportAndUploadFileResult> {
    const input: ExportAndUploadFileInput = {
      filename,
      path,
      topicId,
    };

    return toolsClient.market.exportAndUploadFile.mutate(input);
  }

  private async waitForEnqueue(toolCallId: string, timeoutMs: number) {
    const startedAt = Date.now();
    let attempt = 0;

    while (Date.now() - startedAt < timeoutMs) {
      const job = await toolsClient.market.findSandboxJobByToolCallId.query({ toolCallId });
      if (job) return job;

      attempt += 1;
      // Quick polls early (250ms, 500ms), then 1s steady-state.
      const wait = Math.min(250 * 2 ** Math.min(attempt - 1, 2), 1_000);
      await sleep(wait);
    }

    return null;
  }

  private toCallToolResult(job: {
    errorPayload: unknown;
    resultPayload: unknown;
    state: string;
  }): CallToolResult {
    if (job.state === 'success') {
      return buildSuccessResultFromPayload(job.resultPayload);
    }

    const errorPayload = job.errorPayload as {
      body?: unknown;
      message?: string;
      type?: string;
    } | null;
    const message = errorPayload?.message || `Sandbox job ended in state=${job.state}`;
    const name = errorPayload?.type || job.state;

    return buildErrorResult(message, name, errorPayload?.body ?? null);
  }
}

export const cloudSandboxService = new CloudSandboxService();
