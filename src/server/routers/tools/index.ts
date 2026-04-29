import { publicProcedure, router } from '@/libs/trpc/lambda';

import { documentsRouter } from './documents';
import { klavisRouter } from './klavis';
import { marketRouter } from './market';
import { mcpRouter } from './mcp';
import { searchRouter } from './search';

export const toolsRouter = router({
  documents: documentsRouter,
  healthcheck: publicProcedure.query(() => "i'm live!"),
  klavis: klavisRouter,
  market: marketRouter,
  mcp: mcpRouter,
  search: searchRouter,
});

export type ToolsRouter = typeof toolsRouter;
