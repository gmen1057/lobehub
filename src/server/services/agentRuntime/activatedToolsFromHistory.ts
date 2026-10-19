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

interface HistoryMessageLike {
  content?: unknown;
  plugin?: { identifier?: string | null } | null;
  pluginState?: { activatedTools?: unknown } | null;
  role?: string;
}

/** Набор инструментов операции в той части, что нужна восстановлению (подходит и серверному типу). */
interface SeedToolSetLike {
  enabledToolIds?: string[];
  manifestMap?: Record<string, LobeToolManifest>;
}

/**
 * Идентификаторы инструментов, подключённых шагами активатора в истории темы, без повторов, в порядке
 * первого подключения. Та же выборка, что и в браузере: сообщение роли `tool` активатора и
 * `pluginState.activatedTools[].identifier`.
 */
export const collectActivatedToolIdsFromMessages = (
  messages: ReadonlyArray<HistoryMessageLike> | undefined,
): string[] => {
  const ids = new Set<string>();

  for (const message of messages ?? []) {
    if (message?.role !== 'tool') continue;
    const activator = message.plugin?.identifier;
    if (!activator || !ACTIVATOR_IDENTIFIERS.has(activator)) continue;

    const activated = message.pluginState?.activatedTools;
    if (!Array.isArray(activated)) continue;

    for (const tool of activated as Array<{ identifier?: unknown }>) {
      if (typeof tool?.identifier === 'string' && tool.identifier) ids.add(tool.identifier);
    }
  }

  return [...ids];
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
