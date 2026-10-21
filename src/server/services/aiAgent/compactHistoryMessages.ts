/**
 * arckep (21.10.2026): сжатие раздутой истории темы перед отправкой в LLM (в базе сообщения не меняются).
 *
 * 1. Перекрытые версии `<lobeArtifact identifier="…">…</lobeArtifact>`: если в истории ассистент позже
 *    вывел новую полную версию артефакта с тем же `identifier` (например, переверстал HTML-письмо на 48 КБ),
 *    прежние полные тела с тем же `identifier` заменяются короткой заглушкой внутри тега. Самая свежая
 *    полная версия каждого `identifier` остаётся целиком (теги со ссылкой `src="…"` без тела её не перекрывают).
 * 2. Тяжёлые выводы инструментов (`role = 'tool'`, > 4 000 знаков) и длинные JSON-аргументы вызовов
 *    (`assistant.tools[].arguments`, > 4 000 знаков — например, 20-килобайтные скрипты песочницы) старше
 *    последних RECENT_UNCOMPACTED_USER_TURNS сообщений человека в истории сокращаются с сохранением начала,
 *    конца и валидного JSON в `arguments`.
 */

export const RECENT_UNCOMPACTED_USER_TURNS = 3;
export const MIN_ARTIFACT_BODY_TO_COMPACT = 800;
export const MAX_OLD_TOOL_CONTENT_CHARS = 4000;
export const MAX_OLD_TOOL_ARGUMENTS_CHARS = 4000;
const TOOL_CONTENT_HEAD_CHARS = 1200;
const TOOL_CONTENT_TAIL_CHARS = 400;
const TOOL_ARG_STRING_LIMIT = 1500;
const TOOL_ARG_HEAD_CHARS = 600;
const TOOL_ARG_TAIL_CHARS = 200;

const ARTIFACT_BLOCK_RE = /(<lobeArtifact\b([^>]*)(?<!\/)>)([\s\S]*?)(<\/lobeArtifact>)/g;
const IDENTIFIER_ATTR_RE = /\bidentifier\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

interface ParsedArtifactBlock {
  body: string;
  closeTag: string;
  end: number;
  identifier: string;
  openTag: string;
  start: number;
}

const findInlineArtifactBlocks = (text: string): ParsedArtifactBlock[] => {
  if (!text.includes('<lobeArtifact')) return [];
  const blocks: ParsedArtifactBlock[] = [];
  for (const match of text.matchAll(ARTIFACT_BLOCK_RE)) {
    const openTag = match[1];
    const attrs = match[2] ?? '';
    const body = match[3] ?? '';
    const closeTag = match[4];
    if (body.trim().length < MIN_ARTIFACT_BODY_TO_COMPACT) continue;
    const idMatch = IDENTIFIER_ATTR_RE.exec(attrs);
    const identifier = (idMatch?.[1] ?? idMatch?.[2] ?? '').trim();
    if (!identifier) continue;
    const start = match.index ?? 0;
    blocks.push({
      body,
      closeTag,
      end: start + match[0].length,
      identifier,
      openTag,
      start,
    });
  }
  return blocks;
};

const compactStringValue = (value: string, head: number, tail: number, label: string): string =>
  `${value.slice(0, head)}\n…[${label} (${value.length} знаков) из прежнего шага сокращён]…\n${value.slice(-tail)}`;

const compactToolArgumentsJson = (rawArgs: string): string => {
  if (rawArgs.length <= MAX_OLD_TOOL_ARGUMENTS_CHARS) return rawArgs;
  try {
    const parsed = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== 'object') return rawArgs;

    let changed = false;
    const shrink = (val: unknown): unknown => {
      if (typeof val === 'string' && val.length > TOOL_ARG_STRING_LIMIT) {
        changed = true;
        return compactStringValue(val, TOOL_ARG_HEAD_CHARS, TOOL_ARG_TAIL_CHARS, 'параметр вызова');
      }
      if (Array.isArray(val)) return val.map(shrink);
      if (val && typeof val === 'object') {
        return Object.fromEntries(
          Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, shrink(v)]),
        );
      }
      return val;
    };

    const compacted = shrink(parsed);
    return changed ? JSON.stringify(compacted) : rawArgs;
  } catch {
    return rawArgs;
  }
};

export const compactHistoryMessages = <T extends Record<string, any>>(messages: T[]): T[] => {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  // 1. Находим самую последнюю полную inline-версию каждого identifier артефакта
  const latestArtifactOccurrence = new Map<string, { blockIndex: number; msgIndex: number }>();
  const msgBlocks = new Map<number, ParsedArtifactBlock[]>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || typeof msg.content !== 'string') continue;
    const blocks = findInlineArtifactBlocks(msg.content);
    if (blocks.length === 0) continue;
    msgBlocks.set(i, blocks);
    blocks.forEach((b, blockIndex) => {
      latestArtifactOccurrence.set(b.identifier, { blockIndex, msgIndex: i });
    });
  }

  // 2. Определяем границу последних RECENT_UNCOMPACTED_USER_TURNS сообщений человека в истории
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'user') userIndices.push(i);
  }
  const recentCutoffIndex =
    userIndices.length > RECENT_UNCOMPACTED_USER_TURNS
      ? userIndices[userIndices.length - RECENT_UNCOMPACTED_USER_TURNS]
      : 0;

  return messages.map((msg, msgIndex) => {
    if (!msg || typeof msg !== 'object') return msg;
    let nextMsg = msg;

    // Сжимаем перекрытые более новой inline-версией артефакты (на любой глубине истории)
    const blocks = msgBlocks.get(msgIndex);
    if (blocks && typeof nextMsg.content === 'string') {
      const superseded = blocks.filter((b, blockIndex) => {
        const latest = latestArtifactOccurrence.get(b.identifier);
        return latest && (latest.msgIndex !== msgIndex || latest.blockIndex !== blockIndex);
      });
      if (superseded.length > 0) {
        let cursor = 0;
        let rebuilt = '';
        for (const b of superseded) {
          rebuilt += nextMsg.content.slice(cursor, b.start);
          rebuilt += `${b.openTag}\n<!-- Предыдущая версия макета (${b.body.length} знаков) опущена: актуальная версия с тем же identifier приведена ниже в истории диалога -->\n${b.closeTag}`;
          cursor = b.end;
        }
        rebuilt += nextMsg.content.slice(cursor);
        nextMsg = { ...nextMsg, content: rebuilt };
      }
    }

    // Старые шаги инструментов (до последних RECENT_UNCOMPACTED_USER_TURNS сообщений человека)
    if (msgIndex < recentCutoffIndex) {
      if (
        nextMsg.role === 'tool' &&
        typeof nextMsg.content === 'string' &&
        nextMsg.content.length > MAX_OLD_TOOL_CONTENT_CHARS
      ) {
        nextMsg = {
          ...nextMsg,
          content: compactStringValue(
            nextMsg.content,
            TOOL_CONTENT_HEAD_CHARS,
            TOOL_CONTENT_TAIL_CHARS,
            'вывод инструмента',
          ),
        };
      }

      if (
        nextMsg.role === 'assistant' &&
        Array.isArray(nextMsg.tools) &&
        nextMsg.tools.length > 0
      ) {
        let toolsChanged = false;
        const nextTools = nextMsg.tools.map((tool: any) => {
          if (!tool || typeof tool.arguments !== 'string') return tool;
          const compactedArgs = compactToolArgumentsJson(tool.arguments);
          if (compactedArgs !== tool.arguments) {
            toolsChanged = true;
            return { ...tool, arguments: compactedArgs };
          }
          return tool;
        });
        if (toolsChanged) {
          nextMsg = { ...nextMsg, tools: nextTools };
        }
      }
    }

    return nextMsg;
  });
};
