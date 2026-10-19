import { ArckepLayoutIdentifier } from '@lobechat/builtin-tool-arckep-layout';
import type { LobeChatDatabase } from '@lobechat/database';
import { files, messagePlugins, messages, messagesFiles } from '@lobechat/database/schemas';
import { type ChatStreamPayload, consumeStreamUntilDone } from '@lobechat/model-runtime';
import { nanoid } from '@lobechat/utils';
import debug from 'debug';
import { and, desc, eq, like } from 'drizzle-orm';

import { FileModel } from '@/database/models/file';
import {
  reasoningCallParams,
  resolveReasoningProfile,
  snapReasoningLevel,
} from '@/server/modules/AgentRuntime/reasoningLevels';
import { findModelExtendParams } from '@/server/modules/AgentRuntime/serverModelParams';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { FileService } from '@/server/services/file';

import { fileAddress } from '../aiAgent/fileAddress';
import { modelHasVision } from '../aiAgent/modelVision';
import { isPdfMime, pdfPrepareOptions, PdfPrepareService } from '../aiAgent/pdfPrepare';
import { renderLayout } from './render';
import { type LayoutServiceDeps, MAX_FILE_BYTES } from './service';

const log = debug('lobe-server:arckep-layout:deps');

/**
 * arckep (19.10.2026): рабочая сборка зависимостей сверки с макетом — база движка, хранилище файлов человека,
 * бэкенд студии (отрисовка) и вызов модели хода. Всё ограничено человеком, от имени которого идёт инструмент:
 * чужие сообщения и файлы не читаются, номер человека в студии берётся из его аккаунта.
 */
export const createLayoutDeps = (
  db: LobeChatDatabase,
  userId: string,
  resolveStudioUserId: () => Promise<number>,
): LayoutServiceDeps => {
  // хранилище файлов поднимается только когда нужно: не всякий вызов инструмента дойдёт до файлов
  let fileServiceInstance: FileService | undefined;
  const fileService = () => (fileServiceInstance ??= new FileService(db, userId));
  const fileModel = () => new FileModel(db, userId);
  let prepInstance: PdfPrepareService | undefined;
  const prep = () => (prepInstance ??= PdfPrepareService.forUser(db, userId));

  return {
    address: fileAddress,

    askEditor: async ({ model, parentMessageId, parts, provider, system, topicId }) => {
      // списание — как у обычного хода: шлюз бэкенда списывает с человека и пишет трату в эту тему
      const runtime = await initModelRuntimeFromDB(db, userId, provider, {
        assistantMessageId: parentMessageId,
        topicId,
      });
      // ступень рассуждений низкая, если модель её знает (правщику нужна скорость, а не глубина)
      const profile = resolveReasoningProfile(
        model,
        provider,
        await findModelExtendParams(model, provider),
      );
      const level = profile && snapReasoningLevel('low', profile.levels);
      const reasoning = profile && level ? reasoningCallParams(profile, level) : {};

      let text = '';
      let failure: { message?: unknown } | undefined;
      let usage: unknown;
      const response = await runtime.chat(
        {
          messages: [
            { content: system, role: 'system' },
            { content: parts, role: 'user' },
          ],
          model,
          stream: true,
          ...reasoning,
        } as unknown as ChatStreamPayload,
        {
          callback: {
            onCompletion: async (data) => {
              usage = data.usage;
            },
            // у моделей Gemini 3 текст может приходить частями содержимого, а не обычным текстом (как в call_llm)
            onContentPart: async (part) => {
              if (part.partType === 'text' && part.content) text += part.content;
            },
            onError: async (error) => {
              failure = error as { message?: unknown };
            },
            onText: async (chunk) => {
              text += chunk;
            },
          },
          metadata: { topicId },
          user: userId,
        },
      );
      await consumeStreamUntilDone(response);
      log(
        'editor answered topic=%s model=%s chars=%d usage=%o',
        topicId,
        model,
        text.length,
        usage,
      );
      if (failure) {
        throw new Error(
          typeof failure.message === 'string' ? failure.message : JSON.stringify(failure),
        );
      }
      return text;
    },

    // ответы ассистента и результаты самого инструмента сверки: в них стоит тег с последней версией (результат
    // checkLayout/editArtifact содержит готовый тег — его учитываем и тогда, когда модель забыла повторить тег в ответе)
    artifactMessages: async (topicId) => {
      const own = and(
        eq(messages.userId, userId),
        eq(messages.topicId, topicId),
        like(messages.content, '%<lobeArtifact%'),
      );
      const [answers, toolResults] = await Promise.all([
        db
          .select({ at: messages.createdAt, content: messages.content, id: messages.id })
          .from(messages)
          .where(and(own, eq(messages.role, 'assistant'))),
        db
          .select({ at: messages.createdAt, content: messages.content, id: messages.id })
          .from(messages)
          .innerJoin(messagePlugins, eq(messagePlugins.id, messages.id))
          .where(
            and(
              own,
              eq(messages.role, 'tool'),
              eq(messagePlugins.identifier, ArckepLayoutIdentifier),
            ),
          ),
      ]);
      return [...answers, ...toolResults]
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .map(({ content, id }) => ({ content, id }));
    },

    modelHasVision,

    prepRecord: async (fileId) => {
      const known = (await prep().peek([fileId])).get(fileId);
      if (known?.layout || known?.status === 'done') return known;
      return (await prep().waitFor(fileId, pdfPrepareOptions().waitMs)).record;
    },

    readChatFileText: async (fileId) => {
      const file = await fileModel().findById(fileId);
      if (!file || file.size > MAX_FILE_BYTES) return undefined;
      const bytes = await fileService().getFileByteArray(file.url);
      if (bytes.byteLength > MAX_FILE_BYTES) return undefined;
      return Buffer.from(bytes).toString('utf8');
    },

    readStorage: (key) => fileService().getFileByteArray(key),

    render: (params) => renderLayout(params),

    saveHtml: async (html, name) => {
      const saved = await fileService().uploadFromBuffer(
        Buffer.from(html, 'utf8'),
        'text/plain; charset=utf-8',
        `files/${userId}/${nanoid()}/${name}`,
      );
      return { address: fileAddress(saved.fileId), fileId: saved.fileId };
    },

    studioUserId: resolveStudioUserId,

    topicPdfs: async (topicId) => {
      const rows = await db
        .select({ fileType: files.fileType, id: files.id, name: files.name })
        .from(messagesFiles)
        .innerJoin(messages, eq(messages.id, messagesFiles.messageId))
        .innerJoin(files, eq(files.id, messagesFiles.fileId))
        .where(
          and(
            eq(messages.userId, userId),
            eq(messages.topicId, topicId),
            eq(messages.role, 'user'),
            eq(files.userId, userId),
          ),
        )
        .orderBy(desc(messages.createdAt));
      const seen = new Set<string>();
      return rows
        .filter((row) => isPdfMime(row.fileType, row.name))
        .filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)))
        .map(({ id, name }) => ({ id, name }));
    },

    turnModel: async (parentMessageId) => {
      if (!parentMessageId) return undefined;
      const [row] = await db
        .select({ model: messages.model, provider: messages.provider })
        .from(messages)
        .where(and(eq(messages.id, parentMessageId), eq(messages.userId, userId)))
        .limit(1);
      return row?.model && row.provider ? { model: row.model, provider: row.provider } : undefined;
    },
  };
};
