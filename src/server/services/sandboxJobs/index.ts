import { getServerDB } from '@/database/core/db-adaptor';
import type { LobeChatDatabase } from '@/database/type';

import { SandboxJobWorker } from './worker';

export { SandboxJobWorker } from './worker';

export const ensureRunning = async (db?: LobeChatDatabase) => {
  const serverDB = db ?? (await getServerDB());
  return SandboxJobWorker.ensureRunning(serverDB);
};
