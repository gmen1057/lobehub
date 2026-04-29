import { TRPCError } from '@trpc/server';

import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { DocumentsService, generateDocumentInputSchema } from '@/server/services/documents';

const documentsProcedure = authedProcedure.use(serverDatabase).use(async ({ ctx, next }) => {
  return next({
    ctx: {
      documentsService: new DocumentsService(ctx.serverDB, ctx.userId),
    },
  });
});

export const documentsRouter = router({
  generateDocument: documentsProcedure
    .input(generateDocumentInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.documentsService.generateDocument(input);
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('[documents:generateDocument]', error);
        throw new TRPCError({
          cause: error,
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to generate document',
        });
      }
    }),
});
