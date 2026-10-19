import { isSvgFileName, isSvgMime } from '@lobechat/utils/isVisionImage';
import debug from 'debug';

import { BaseProcessor } from '../base/BaseProcessor';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    toolResultImages?: {
      candidates: number;
      inserted: number;
      messages: number;
    };
  }
}

const log = debug('context-engine:processor:ToolResultImagesProcessor');

/** arckep (19.10.2026): больше картинок из результатов инструментов за один запрос к модели не шлём. */
export const TOOL_RESULT_IMAGES_LIMIT = 4;

/** Картинка из блока `{type: 'image'}` результата MCP-инструмента, уже загруженная в хранилище. */
export interface ToolResultImage {
  /** Запись файла в хранилище (ставит processContentBlocks) — по ней берётся подписанная ссылка */
  fileId?: string;
  mimeType?: string;
  /** Постоянный адрес файла на сайте (`${APP_URL}/f/:id`); провайдеру моделей он не годится */
  url: string;
}

export interface ToolResultImagesConfig {
  /** Умеет ли модель видеть картинки; не передана — картинки не добавляются */
  isCanUseVision?: (model: string, provider: string) => boolean | undefined;
  /** Предел картинок за запрос (самые свежие), по умолчанию 4 */
  maxImages?: number;
  model: string;
  provider: string;
  /**
   * Адрес картинки, доступный провайдеру моделей (подписанная ссылка хранилища).
   * `undefined` или ошибка — картинка пропускается: в тексте tool-сообщения ссылка остаётся.
   */
  resolveImageUrl: (image: ToolResultImage) => Promise<string | undefined>;
}

const isHttpUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//i.test(value);

/**
 * Картинки из pluginState tool-сообщения (`{content: [{type: 'image', data: <адрес>, mimeType, fileId}]}`).
 * Сырой base64 и data-URI не берём никогда: в контекст модели он попадать не должен. SVG — не растровая
 * картинка, провайдеры отвечают на него 400.
 */
export const extractToolResultImages = (pluginState: unknown): ToolResultImage[] => {
  const blocks = (pluginState as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(blocks)) return [];

  const images: ToolResultImage[] = [];
  for (const block of blocks) {
    if (!block || block.type !== 'image' || !isHttpUrl(block.data)) continue;

    const mimeType = typeof block.mimeType === 'string' ? block.mimeType : undefined;
    if (isSvgMime(mimeType)) continue;
    if (isSvgFileName(block.data.split(/[?#]/)[0])) continue;

    images.push({
      fileId: typeof block.fileId === 'string' ? block.fileId : undefined,
      mimeType,
      url: block.data,
    });
  }
  return images;
};

/** `identifier.apiName` для подписи: из plugin сообщения, иначе из имени вызова `identifier____apiName`. */
const toolLabel = (message: any, callNames: Map<string, string>): string => {
  if (message.plugin?.identifier && message.plugin?.apiName) {
    return `${message.plugin.identifier}.${message.plugin.apiName}`;
  }

  const name: string | undefined = message.name || callNames.get(message.tool_call_id);
  if (!name) return 'tool';

  const [identifier, apiName] = name.split('____');
  return apiName ? `${identifier}.${apiName}` : name;
};

interface Candidate {
  image: ToolResultImage;
  /** Индекс tool-сообщения, из которого картинка */
  index: number;
  label: string;
  /** Индекс последнего tool-сообщения в подряд идущей группе — сюда вставляется user-сообщение */
  runEnd: number;
}

/**
 * Tool Result Images Processor
 *
 * arckep (19.10.2026): инструмент может вернуть картинку (Figma `get_screenshot`, скриншот страницы...).
 * Провайдеры моделей принимают в tool-сообщении только текст, поэтому текст остаётся как есть (в нём
 * ссылка на файл), а модели со зрением картинки ТЕКУЩЕГО хода (после последнего user-сообщения)
 * передаются сразу после группы tool-сообщений отдельным user-сообщением:
 * «Images returned by tool <identifier>.<apiName> (already shown to the user; look at them to answer):»
 * + image_url. Не больше 4 картинок за запрос (самые свежие); картинки прошлых ходов — только ссылкой
 * в тексте их tool-сообщений; модель без зрения — ничего не добавляется.
 *
 * Стоит ПОСЛЕ ToolMessageReorder (порядок «assistant → его tool-сообщения» уже окончательный, требования
 * Anthropic/OpenAI/Gemini к парам tool_use/tool_result не нарушаются) и ДО MessageCleanup.
 */
export class ToolResultImagesProcessor extends BaseProcessor {
  readonly name = 'ToolResultImagesProcessor';

  constructor(
    private config: ToolResultImagesConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected async doProcess(context: PipelineContext): Promise<PipelineContext> {
    const clonedContext = this.cloneContext(context);
    const { isCanUseVision, model, provider, resolveImageUrl } = this.config;
    const limit = Math.max(0, this.config.maxImages ?? TOOL_RESULT_IMAGES_LIMIT);

    if (limit === 0 || !isCanUseVision?.(model, provider)) {
      return this.markAsExecuted(clonedContext);
    }

    const messages = clonedContext.messages;

    // Ход начинается с последнего user-сообщения; без него (бот, cron) текущий ход — вся переписка.
    let turnStart = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        turnStart = i + 1;
        break;
      }
    }

    const callNames = new Map<string, string>();
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
      for (const call of message.tool_calls) {
        if (call?.id && call.function?.name) callNames.set(call.id, call.function.name);
      }
    }

    const candidates: Candidate[] = [];
    for (let i = turnStart; i < messages.length; i++) {
      const message = messages[i];
      if (message.role !== 'tool') continue;

      const images = extractToolResultImages(message.pluginState);
      if (images.length === 0) continue;

      let runEnd = i;
      while (runEnd + 1 < messages.length && messages[runEnd + 1].role === 'tool') runEnd++;

      const label = toolLabel(message, callNames);
      for (const image of images) candidates.push({ image, index: i, label, runEnd });
    }

    // Один и тот же файл — один раз (остаётся самое позднее упоминание); потом самые свежие.
    const seen = new Set<string>();
    const unique: Candidate[] = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const key = candidates[i].image.fileId || candidates[i].image.url;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.unshift(candidates[i]);
    }
    const selected = unique.slice(-limit);

    const resolved = await Promise.all(
      selected.map(async (candidate) => {
        try {
          return await resolveImageUrl(candidate.image);
        } catch (error) {
          log.extend('error')(
            `Cannot resolve tool image ${candidate.image.fileId || candidate.image.url}: ${error}`,
          );
          return undefined;
        }
      }),
    );

    // runEnd → части сообщения: на каждый tool-ответ с картинками — подпись и его картинки.
    const insertions = new Map<number, any[]>();
    let inserted = 0;
    let lastHeader: { index: number; label: string } | undefined;
    selected.forEach((candidate, i) => {
      const url = resolved[i];
      if (!url) return;

      const parts = insertions.get(candidate.runEnd) ?? [];
      if (lastHeader?.index !== candidate.index || !parts.length) {
        parts.push({
          text: `Images returned by tool ${candidate.label} (already shown to the user; look at them to answer):`,
          type: 'text',
        });
        lastHeader = { index: candidate.index, label: candidate.label };
      }
      parts.push({ image_url: { detail: 'auto', url }, type: 'image_url' });
      insertions.set(candidate.runEnd, parts);
      inserted++;
    });

    if (insertions.size > 0) {
      // Снизу вверх, чтобы индексы выше по списку не сдвигались.
      for (const runEnd of [...insertions.keys()].sort((a, b) => b - a)) {
        messages.splice(runEnd + 1, 0, { content: insertions.get(runEnd) ?? [], role: 'user' });
      }
    }

    clonedContext.metadata.toolResultImages = {
      candidates: candidates.length,
      inserted,
      messages: insertions.size,
    };

    log(
      `Tool result images: ${candidates.length} candidates, ${inserted} inserted in ${insertions.size} user message(s)`,
    );

    return this.markAsExecuted(clonedContext);
  }
}
