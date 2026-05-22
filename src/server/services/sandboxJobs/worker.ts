import debug from 'debug';

import type {
  SandboxJobErrorPayload,
  SandboxJobResultPayload,
  SandboxJobSelectItem,
} from '@/database/schemas';
import { SandboxJobModel } from '@/database/server/models/sandboxJob';
import type { LobeChatDatabase } from '@/database/type';

import { writeChildToolMessage } from './continuation';

const log = debug('lobe-server:service:sandbox-jobs');

const DEFAULT_CONCURRENCY_CAP = 1;
const DEFAULT_TICK_INTERVAL_MS = 500;
const DEFAULT_IDLE_BACKOFF_MAX_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_LOCK_TTL_SEC = 60;
const DEFAULT_GATEWAY_TIMEOUT_MS = 120_000;
const SYSTEM_WORKER_USER_ID = '__sandbox_job_worker_system__';
const E2B_GATEWAY_URL = process.env.E2B_GATEWAY_URL || 'http://127.0.0.1:8410/mcp/e2b-sandbox';

type AbortReason = 'claim_lost' | 'timeout' | 'worker_stopped';

interface GatewayError {
  [key: string]: unknown;
  message?: string;
}

interface GatewayContentBlock {
  [key: string]: unknown;
  text?: string;
}

interface GatewayResult {
  [key: string]: unknown;
  content?: GatewayContentBlock[];
  sandboxSessionId?: string;
  session_id?: string;
  sessionId?: string;
}

interface GatewayResponsePayload {
  [key: string]: unknown;
  error?: GatewayError;
  result?: GatewayResult;
}

interface SandboxJobWorkerGlobal {
  sandboxJobWorker?: SandboxJobWorker;
}

const globalForSandboxJobWorker = globalThis as unknown as SandboxJobWorkerGlobal;

const normalizeConcurrencyCap = (concurrencyCap: number) => Math.max(1, Math.floor(concurrencyCap));

const delay = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

const generateWorkerId = () => {
  const randomPart = Math.random().toString(36).slice(2, 12);
  return `c${Date.now().toString(36)}${randomPart}`;
};

const getStringArg = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  return typeof value === 'string' ? value : '';
};

export const buildSandboxGatewayCode = (apiName: string, args: Record<string, unknown>): string => {
  if (apiName === 'execCode' || apiName === 'executeCode') {
    return getStringArg(args, 'code') || getStringArg(args, 'script');
  }

  if (apiName === 'execScript') {
    return (
      getStringArg(args, 'code') || getStringArg(args, 'script') || getStringArg(args, 'command')
    );
  }

  if (apiName === 'runCommand') {
    const command = getStringArg(args, 'command');
    if (!command) return '';

    return `import subprocess; r = subprocess.run(${JSON.stringify(command)}, shell=True, capture_output=True, text=True); print(r.stdout); print(r.stderr) if r.stderr else None`;
  }

  return (
    getStringArg(args, 'code') ||
    getStringArg(args, 'script') ||
    getStringArg(args, 'command') ||
    JSON.stringify(args)
  );
};

const parseGatewayResponse = async (response: Response): Promise<GatewayResponsePayload> => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text) as GatewayResponsePayload;
  } catch {
    return { result: { content: [{ text }] } };
  }
};

const extractGatewayText = (payload: GatewayResponsePayload) =>
  payload.result?.content?.[0]?.text || '';

const extractSandboxSessionId = (job: SandboxJobSelectItem, payload: GatewayResponsePayload) => {
  const result = payload.result;
  const value = result?.sandboxSessionId || result?.sessionId || result?.session_id;

  return typeof value === 'string' ? value : job.topicId;
};

const createTimeoutErrorPayload = (timeoutMs: number): SandboxJobErrorPayload => ({
  message: `Sandbox job timed out after ${timeoutMs}ms`,
  type: 'timeout',
});

export class SandboxJobWorker {
  private readonly abortReasons = new Map<string, AbortReason>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly concurrencyCap: number;
  private readonly db: LobeChatDatabase;
  private readonly inFlightExecutions = new Set<Promise<void>>();

  private running = false;
  private stopController = new AbortController();
  private stopping = false;
  private tickLoopPromise?: Promise<void>;
  private workerId?: string;

  constructor(db: LobeChatDatabase, concurrencyCap: number = DEFAULT_CONCURRENCY_CAP) {
    this.db = db;
    this.concurrencyCap = normalizeConcurrencyCap(concurrencyCap);
  }

  static async ensureRunning(
    db: LobeChatDatabase,
    concurrencyCap: number = DEFAULT_CONCURRENCY_CAP,
  ): Promise<SandboxJobWorker> {
    const existing = globalForSandboxJobWorker.sandboxJobWorker;
    if (existing?.isRunning) {
      log('SandboxJobWorker already running');
      return existing;
    }

    const worker = existing ?? new SandboxJobWorker(db, concurrencyCap);
    globalForSandboxJobWorker.sandboxJobWorker = worker;
    await worker.start();

    return worker;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get id(): string | undefined {
    return this.workerId;
  }

  async start(): Promise<void> {
    if (this.running) {
      log('SandboxJobWorker already running, skipping');
      return;
    }

    this.workerId = generateWorkerId();
    this.stopping = false;
    this.stopController = new AbortController();
    this.running = true;

    log('SandboxJobWorker starting workerId=%s concurrency=%d', this.workerId, this.concurrencyCap);

    this.tickLoopPromise = this.tickLoop().catch((error) => {
      console.error('[SandboxJobWorker] tick loop failed:', error);
    });

    log('SandboxJobWorker started workerId=%s', this.workerId);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.tickLoopPromise) return;

    log(
      'SandboxJobWorker stopping workerId=%s inFlight=%d',
      this.workerId,
      this.inFlightExecutions.size,
    );

    this.stopping = true;
    this.stopController.abort();

    for (const [jobId, controller] of this.activeControllers) {
      this.abortReasons.set(jobId, 'worker_stopped');
      controller.abort();
    }

    await this.tickLoopPromise;
    await Promise.allSettled(this.inFlightExecutions);

    this.running = false;
    this.stopping = false;
    this.tickLoopPromise = undefined;
    this.workerId = undefined;
    this.abortReasons.clear();
    this.activeControllers.clear();

    log('SandboxJobWorker stopped');
  }

  async tickLoop(): Promise<void> {
    let idleBackoffMs = DEFAULT_TICK_INTERVAL_MS;

    while (!this.stopping) {
      let didWork = false;

      try {
        const recoveredCount = await this.recoverStaleJobsAcrossUsers();
        didWork ||= recoveredCount > 0;

        while (this.inFlightExecutions.size < this.concurrencyCap) {
          const scheduled = await this.scheduleNextJob();
          if (!scheduled) break;
          didWork = true;
        }
      } catch (error) {
        console.error('[SandboxJobWorker] tick failed:', error);
      }

      idleBackoffMs = didWork
        ? DEFAULT_TICK_INTERVAL_MS
        : Math.min(idleBackoffMs * 2, DEFAULT_IDLE_BACKOFF_MAX_MS);

      await delay(didWork ? DEFAULT_TICK_INTERVAL_MS : idleBackoffMs, this.stopController.signal);
    }
  }

  async pickAndExecute(): Promise<SandboxJobSelectItem | null> {
    const job = await this.claimNextJob();
    if (!job) return null;

    await this.executeJob(job);
    return job;
  }

  /**
   * Wraps a terminal mark (markSuccess/markError/markTimeout) and writes the
   * child tool message so the user sees the result on return — even if the
   * browser was closed during execution.
   *
   * If the mark returns null (job already terminal — race with another worker
   * or stop+restart), we skip the child message write to avoid duplicating it.
   */
  private async finalizeJob(
    job: SandboxJobSelectItem,
    finalize: (model: SandboxJobModel) => Promise<SandboxJobSelectItem | null>,
  ): Promise<void> {
    const updated = await finalize(this.getUserModel(job.userId));
    if (!updated) {
      log('finalizeJob: job already terminal, skipping child message write jobId=%s', job.id);
      return;
    }

    try {
      await writeChildToolMessage(this.db, updated);
    } catch (error) {
      console.error('[SandboxJobWorker] writeChildToolMessage failed:', error);
    }
  }

  async executeJob(job: SandboxJobSelectItem): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      this.abortReasons.set(job.id, 'timeout');
      controller.abort();
    }, DEFAULT_GATEWAY_TIMEOUT_MS);

    this.activeControllers.set(job.id, controller);

    const heartbeatPromise = this.heartbeatLoop(job.id, job.userId, this.getWorkerId(), controller);

    try {
      const args = job.args as Record<string, unknown>;
      const code = buildSandboxGatewayCode(job.apiName, args);

      if (!code) {
        await this.finalizeJob(job, (model) =>
          model.markError(job.id, {
            message: 'No code provided',
            type: 'validation_error',
          }),
        );
        return;
      }

      log(
        'executeJob start jobId=%s userId=%s api=%s topicId=%s',
        job.id,
        job.userId,
        job.apiName,
        job.topicId,
      );

      const response = await fetch(E2B_GATEWAY_URL, {
        body: JSON.stringify({
          id: Date.now(),
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: {
              code,
              install_packages: args.packages || args.install_packages,
              session_id: job.topicId,
            },
            name: 'execute_code',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      });

      const payload = await parseGatewayResponse(response);

      if (!response.ok) {
        await this.finalizeJob(job, (model) =>
          model.markError(job.id, {
            body: payload,
            message: `E2B gateway returned ${response.status}`,
            type: 'gateway_http_error',
          }),
        );
        log('executeJob gateway http error jobId=%s status=%d', job.id, response.status);
        return;
      }

      if (payload.error) {
        await this.finalizeJob(job, (model) =>
          model.markError(job.id, {
            body: payload.error,
            message: (payload.error as any)?.message || 'E2B gateway error',
            type: 'gateway_error',
          }),
        );
        log(
          'executeJob gateway error jobId=%s message=%s',
          job.id,
          (payload.error as any)?.message,
        );
        return;
      }

      const text = extractGatewayText(payload);
      const resultPayload: SandboxJobResultPayload = {
        content: text,
        result: { output: text, success: true },
        state: payload.result || {},
      };

      await this.finalizeJob(job, (model) =>
        model.markSuccess(job.id, resultPayload, extractSandboxSessionId(job, payload)),
      );

      log('executeJob success jobId=%s', job.id);
    } catch (error) {
      const abortReason = this.abortReasons.get(job.id);

      if (abortReason === 'claim_lost' || abortReason === 'worker_stopped') {
        log('executeJob aborted without terminal state jobId=%s reason=%s', job.id, abortReason);
        return;
      }

      if (abortReason === 'timeout') {
        await this.finalizeJob(job, (model) =>
          model.markError(job.id, createTimeoutErrorPayload(DEFAULT_GATEWAY_TIMEOUT_MS)),
        );
        log('executeJob timeout jobId=%s', job.id);
        return;
      }

      const err = error as Error;
      await this.finalizeJob(job, (model) =>
        model.markError(job.id, {
          message: err.message,
          type: err.name || 'gateway_exception',
        }),
      );
      log('executeJob exception jobId=%s error=%O', job.id, error);
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(job.id);
      this.abortReasons.delete(job.id);
      controller.abort();
      await heartbeatPromise;
    }
  }

  async heartbeatLoop(
    jobId: string,
    userId: string,
    workerId: string,
    controller: AbortController,
  ): Promise<void> {
    while (!controller.signal.aborted) {
      await delay(DEFAULT_HEARTBEAT_INTERVAL_MS, controller.signal);
      if (controller.signal.aborted) return;

      const alive = await this.getUserModel(userId).heartbeat(
        jobId,
        workerId,
        DEFAULT_LOCK_TTL_SEC,
      );
      if (alive) {
        log('heartbeat ok jobId=%s workerId=%s', jobId, workerId);
        continue;
      }

      this.abortReasons.set(jobId, 'claim_lost');
      controller.abort();
      log('heartbeat lost jobId=%s workerId=%s', jobId, workerId);
      return;
    }
  }

  async recoverStaleJobsAcrossUsers(): Promise<number> {
    const recovered = await this.getSystemModel().recoverStaleJobs(DEFAULT_LOCK_TTL_SEC);

    if (recovered.length > 0) {
      log(
        'recoverStaleJobs recovered=%d ids=%o',
        recovered.length,
        recovered.map((job) => job.id),
      );
    }

    return recovered.length;
  }

  private async claimNextJob(): Promise<SandboxJobSelectItem | null> {
    const job = await this.getSystemModel().claimNext(this.getWorkerId(), DEFAULT_LOCK_TTL_SEC);

    if (job) {
      log('claimNext jobId=%s userId=%s workerId=%s', job.id, job.userId, this.workerId);
    }

    return job;
  }

  private getSystemModel() {
    return new SandboxJobModel(this.db, SYSTEM_WORKER_USER_ID);
  }

  private getUserModel(userId: string) {
    return new SandboxJobModel(this.db, userId);
  }

  private getWorkerId() {
    if (!this.workerId) {
      this.workerId = generateWorkerId();
    }

    return this.workerId;
  }

  private async scheduleNextJob(): Promise<boolean> {
    const job = await this.claimNextJob();
    if (!job) return false;

    const execution = this.executeJob(job)
      .catch((error) => {
        console.error('[SandboxJobWorker] execution failed:', error);
      })
      .finally(() => {
        this.inFlightExecutions.delete(execution);
      });

    this.inFlightExecutions.add(execution);
    return true;
  }
}

export const getSandboxJobWorker = () => globalForSandboxJobWorker.sandboxJobWorker;

export const createSandboxJobWorker = (
  db: LobeChatDatabase,
  concurrencyCap: number = DEFAULT_CONCURRENCY_CAP,
) => {
  const existing = globalForSandboxJobWorker.sandboxJobWorker;
  if (existing) return existing;

  const worker = new SandboxJobWorker(db, concurrencyCap);
  globalForSandboxJobWorker.sandboxJobWorker = worker;
  return worker;
};
