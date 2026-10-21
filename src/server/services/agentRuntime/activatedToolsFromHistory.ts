import { LobeActivatorIdentifier } from '@lobechat/builtin-tool-activator';
import type { ActivatedStepTool, LobeToolManifest } from '@lobechat/context-engine';

/**
 * arckep (19.10.2026): подключённое остаётся подключённым в пределах темы.
 *
 * Тяжёлые инструменты в серверном пути грузятся по требованию: модель подключает их шагом
 * `activateTools`, и они живут в `state.activatedStepTools` ровно одной операции. Следующее сообщение
 * темы — новая операция, и без восстановления модель заново платила бы за шаг подключения (полная
 * переписка + промах кэша, потому что меняется список функций). Браузерный чат собирает подключённое
 * из истории (selectActivatedToolIdsFromMessages) — здесь то же самое для серверной операции.
 */

/** Инструменты-активаторы, чьи ответы несут `pluginState.activatedTools` (старое имя — `lobe-tools`). */
const ACTIVATOR_IDENTIFIERS = new Set<string>([LobeActivatorIdentifier, 'lobe-tools']);

/**
 * arckep (21.10.2026): сколько последних ходов человека (включая текущий запрос в конце initialMessages,
 * то есть 3 завершённых хода + текущий) инструмент держится подключённым без новых вызовов. Если за
 * последние 3 хода человек перешёл к другой задаче и инструмент ни разу не подключался и не вызывался,
 * его тяжёлая схема автоматически отцепляется.
 */
export const RECENT_ACTIVE_TOOL_USER_MESSAGES = 4;

interface HistoryMessageLike {
  content?: unknown;
  plugin?: { identifier?: string | null } | null;
  pluginState?: { activatedTools?: unknown } | null;
  role?: string;
  tools?: ReadonlyArray<{ identifier?: string | null }> | null;
}

/** Набор инструментов операции в той части, что нужна восстановлению (подходит и серверному типу). */
interface SeedToolSetLike {
  enabledToolIds?: string[];
  manifestMap?: Record<string, LobeToolManifest>;
}

const extractActivatedFromToolMessage = (message: HistoryMessageLike | undefined): string[] => {
  if (message?.role !== 'tool') return [];
  const activator = message.plugin?.identifier;
  if (!activator || !ACTIVATOR_IDENTIFIERS.has(activator)) return [];

  const activated = message.pluginState?.activatedTools;
  if (!Array.isArray(activated)) return [];

  const result: string[] = [];
  for (const tool of activated as Array<{ identifier?: unknown }>) {
    if (typeof tool?.identifier === 'string' && tool.identifier) result.push(tool.identifier);
  }
  return result;
};

/**
 * Идентификаторы инструментов, подключённых шагами активатора в истории темы, без повторов, в порядке
 * первого подключения. Если в истории больше RECENT_ACTIVE_TOOL_USER_MESSAGES сообщений человека,
 * остаются только инструменты, которые подключались или вызывались в окне последних ходов.
 */
export const collectActivatedToolIdsFromMessages = (
  messages: ReadonlyArray<HistoryMessageLike> | undefined,
): string[] => {
  const list = messages ?? [];
  const ids = new Set<string>();

  for (const message of list) {
    for (const id of extractActivatedFromToolMessage(message)) {
      ids.add(id);
    }
  }

  if (ids.size === 0) return [];

  const userIndices: number[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]?.role === 'user') userIndices.push(i);
  }

  if (userIndices.length <= RECENT_ACTIVE_TOOL_USER_MESSAGES) {
    return [...ids];
  }

  const recentStart = userIndices[userIndices.length - RECENT_ACTIVE_TOOL_USER_MESSAGES];
  const recentActive = new Set<string>();
  for (let i = recentStart; i < list.length; i++) {
    const msg = list[i];
    for (const id of extractActivatedFromToolMessage(msg)) {
      recentActive.add(id);
    }
    if (
      msg?.role === 'tool' &&
      typeof msg.plugin?.identifier === 'string' &&
      msg.plugin.identifier
    ) {
      recentActive.add(msg.plugin.identifier);
    }
    if (msg?.role === 'assistant' && Array.isArray(msg.tools)) {
      for (const tool of msg.tools) {
        if (typeof tool?.identifier === 'string' && tool.identifier) {
          recentActive.add(tool.identifier);
        }
      }
    }
  }

  return [...ids].filter((id) => recentActive.has(id));
};

/**
 * Записи `activatedStepTools` для новой операции из истории темы. Остаются только инструменты с
 * манифестом в наборе операции: отключённые человеком, выключенная память и удалённые подключения
 * манифеста не имеют и не вернутся. Уже включённые сразу (`enabledToolIds`) не дублируются.
 * Форма записи — та же, что пишет RuntimeExecutors после шага activateTools.
 */
export const seedActivatedStepToolsFromHistory = (
  messages: ReadonlyArray<HistoryMessageLike> | undefined,
  toolSet: SeedToolSetLike | undefined,
): ActivatedStepTool[] => {
  if (!toolSet?.manifestMap) return [];

  const alreadyEnabled = new Set(toolSet.enabledToolIds ?? []);
  const seeded: ActivatedStepTool[] = [];

  for (const id of collectActivatedToolIdsFromMessages(messages)) {
    if (alreadyEnabled.has(id)) continue;

    const manifest = toolSet.manifestMap[id];
    if (!manifest) continue;

    seeded.push({ activatedAtStep: 0, id, manifest, source: 'discovery' });
  }

  return seeded;
};
