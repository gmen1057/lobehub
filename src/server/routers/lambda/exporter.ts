import { z } from 'zod';

import { DrizzleMigrationModel } from '@/database/models/drizzleMigration';
import { MessageModel } from '@/database/models/message';
import { SessionModel } from '@/database/models/session';
import { DataExporterRepos } from '@/database/repositories/dataExporter';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { generatePdfFromMarkdown } from '@/server/services/documents/renderers/pdf';
import { type ExportDatabaseData } from '@/types/export';

const exportProcedure = authedProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const dataExporterRepos = new DataExporterRepos(ctx.serverDB, ctx.userId);
  const drizzleMigration = new DrizzleMigrationModel(ctx.serverDB);
  const messageModel = new MessageModel(ctx.serverDB, ctx.userId);
  const sessionModel = new SessionModel(ctx.serverDB, ctx.userId);

  return opts.next({
    ctx: { dataExporterRepos, drizzleMigration, messageModel, sessionModel },
  });
});

export const exporterRouter = router({
  exportData: exportProcedure.mutation(async ({ ctx }): Promise<ExportDatabaseData> => {
    const data = await ctx.dataExporterRepos.export(5);
    const schemaHash = await ctx.drizzleMigration.getLatestMigrationHash();
    return { data, schemaHash };
  }),

  exportPdf: exportProcedure
    .input(
      z.object({
        content: z.string(),
        sessionId: z.string(),
        title: z.string().optional(),
        topicId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { content, title } = input;
      const pdfBuffer = await generatePdfFromMarkdown(content, title);
      return {
        filename: `${title}.pdf`,
        pdf: pdfBuffer.toString('base64'),
      };
    }),
});
