import { fork } from 'node:child_process';
import path from 'node:path';

export const provisioningProcess = (input: {
  socket: string;
  studioUserId: number;
  holdCredential: boolean;
  failCredential?: boolean;
}) => {
  const child = fork(path.join(import.meta.dirname, 'provisioningWorker.ts'), {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const messages: Array<Record<string, unknown>> = [];
  let errors = '';
  child.stderr?.on('data', (data) => {
    errors += data.toString();
  });
  child.stdout?.resume();
  child.on('message', (message) => {
    const record = message as Record<string, unknown>;
    messages.push(record);
    if (record.type === 'ready') child.send(input);
  });
  const waitFor = async (type: string) => {
    const existing = messages.find((message) => message.type === type);
    if (existing) return existing;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      const onMessage = (message: unknown) => {
        const record = message as Record<string, unknown>;
        if (record.type === type) {
          cleanup();
          resolve(record);
        } else if (record.type === 'failure') {
          cleanup();
          reject(new Error(String(record.message)));
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error(`Worker exited before ${type}: ${errors}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Worker timed out waiting for ${type}: ${JSON.stringify(messages)} ${errors}`),
        );
      }, 5000);
      child.on('message', onMessage);
      child.on('exit', onExit);
      if (child.exitCode !== null) onExit();
    });
  };
  return {
    waitFor,
    release: () => child.send({ type: 'release' }),
    close: () => {
      if (child.exitCode === null) child.kill();
    },
  };
};
