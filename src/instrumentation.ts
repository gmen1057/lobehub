export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ ensureServerUndiciDispatcher }, { initEngineSlotStateFromDisk }] = await Promise.all([
      import('./server/modules/ModelRuntime/undiciDispatcher'),
      import('./server/services/sandboxJobs/slotState'),
    ]);
    ensureServerUndiciDispatcher();
    initEngineSlotStateFromDisk();
  }

  // In local development, write debug logs to logs/server.log
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./libs/debug-file-logger');
  }

  const skipBackgroundAutostart = process.env.ARCKEP_SKIP_BACKGROUND_AUTOSTART === '1';

  // Auto-start GatewayManager for non-Vercel environments so that
  // persistent bots (e.g. Discord gateway, WeChat long-polling) reconnect after server restart.
  // NOTE: On slot drain/shutdown we intentionally NEVER call GatewayManager.stop(), because
  // TelegramWebhookClient.stop() invokes Telegram deleteWebhook and would break the active slot.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    !process.env.VERCEL_ENV &&
    process.env.DATABASE_URL &&
    !skipBackgroundAutostart
  ) {
    const { GatewayService } = await import('./server/services/gateway');
    const service = new GatewayService();
    service.ensureRunning().catch((err) => {
      console.error('[Instrumentation] Failed to auto-start GatewayManager:', err);
    });
  }

  // Auto-start SandboxJobWorker separately so gateway startup failures do not block
  // durable sandbox job execution in the standalone Node.js server.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    !process.env.VERCEL_ENV &&
    process.env.DATABASE_URL &&
    !skipBackgroundAutostart
  ) {
    const { ensureRunning: ensureSandboxWorker } = await import('./server/services/sandboxJobs');
    ensureSandboxWorker().catch((err) => {
      console.error('[Instrumentation] sandbox worker:', err);
    });
  }

  if (process.env.NODE_ENV !== 'production' && !process.env.ENABLE_TELEMETRY_IN_DEV) {
    return;
  }

  const shouldEnable = process.env.ENABLE_TELEMETRY && process.env.NEXT_RUNTIME === 'nodejs';
  if (!shouldEnable) {
    return;
  }

  await import('./instrumentation.node');
}
