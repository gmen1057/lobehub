import { LobeActivatorManifest } from '@lobechat/builtin-tool-activator';
import { AgentBuilderManifest } from '@lobechat/builtin-tool-agent-builder';
import { AgentDocumentsManifest } from '@lobechat/builtin-tool-agent-documents';
import { AgentManagementManifest } from '@lobechat/builtin-tool-agent-management';
import { ArckepBotManifest } from '@lobechat/builtin-tool-arckep-bot';
import { ArckepLayoutManifest } from '@lobechat/builtin-tool-arckep-layout';
import { ArckepSitesManifest } from '@lobechat/builtin-tool-arckep-sites';
import { ArckepStudioManifest } from '@lobechat/builtin-tool-arckep-studio';
import { BriefManifest } from '@lobechat/builtin-tool-brief';
import { CalculatorManifest } from '@lobechat/builtin-tool-calculator';
import { CloudSandboxManifest } from '@lobechat/builtin-tool-cloud-sandbox';
import { CredsManifest } from '@lobechat/builtin-tool-creds';
import { CronManifest } from '@lobechat/builtin-tool-cron';
import { DocumentsIdentifier, DocumentsManifest } from '@lobechat/builtin-tool-documents';
import { GroupAgentBuilderManifest } from '@lobechat/builtin-tool-group-agent-builder';
import { GroupManagementManifest } from '@lobechat/builtin-tool-group-management';
import { GTDManifest } from '@lobechat/builtin-tool-gtd';
import { KnowledgeBaseManifest } from '@lobechat/builtin-tool-knowledge-base';
import { LocalSystemManifest } from '@lobechat/builtin-tool-local-system';
import { MemoryManifest } from '@lobechat/builtin-tool-memory';
import { MessageManifest } from '@lobechat/builtin-tool-message';
import { NotebookManifest } from '@lobechat/builtin-tool-notebook';
import { PageAgentManifest } from '@lobechat/builtin-tool-page-agent';
import { RemoteDeviceManifest } from '@lobechat/builtin-tool-remote-device';
import { SkillStoreManifest } from '@lobechat/builtin-tool-skill-store';
import {
  ArckepConnectorsManifest,
  ArckepSkillsManifest,
  SkillsManifest,
} from '@lobechat/builtin-tool-skills';
import { TaskManifest } from '@lobechat/builtin-tool-task';
import { TopicReferenceManifest } from '@lobechat/builtin-tool-topic-reference';
import { UserInteractionManifest } from '@lobechat/builtin-tool-user-interaction';
import { WebBrowsingManifest } from '@lobechat/builtin-tool-web-browsing';
import { WebOnboardingManifest } from '@lobechat/builtin-tool-web-onboarding';
import { isDesktop, RECOMMENDED_SKILLS, RecommendedSkillType } from '@lobechat/const';
import { type LobeBuiltinTool } from '@lobechat/types';

// arckep: env flag to soft-disable lobe-documents (replaced by sandbox + arckep_tools helper).
// Default: false on prod (kept opt-in). Code stays for one release for quick revert.
const ARCKEP_LOBE_DOCUMENTS_ENABLED = process.env.ARCKEP_LOBE_DOCUMENTS_ENABLED === 'true';

export const defaultToolIds = [
  LobeActivatorManifest.identifier,
  SkillsManifest.identifier,
  SkillStoreManifest.identifier,
  WebBrowsingManifest.identifier,
  KnowledgeBaseManifest.identifier,
  MemoryManifest.identifier,
  LocalSystemManifest.identifier,
  TopicReferenceManifest.identifier,
  AgentDocumentsManifest.identifier,
  GTDManifest.identifier,
  ...(ARCKEP_LOBE_DOCUMENTS_ENABLED ? [DocumentsIdentifier] : []),
];

/**
 * Tool IDs that are always enabled regardless of user selection.
 * These are core system tools that the agent needs to function properly.
 */
export const alwaysOnToolIds = [
  LobeActivatorManifest.identifier,
  SkillsManifest.identifier,
  SkillStoreManifest.identifier,
];

/**
 * Tool IDs to exclude from defaults when in manual skill-activate mode.
 * These are the tool/skill discovery tools that should be disabled when user wants precise control.
 * Other default tools (sandbox, web browsing, etc.) remain available if enabled externally.
 */
export const manualModeExcludeToolIds = [
  LobeActivatorManifest.identifier,
  SkillStoreManifest.identifier,
];

/**
 * arckep: heavy tools that the regular web chat does NOT pre-load, even when the agent has them
 * enabled. Every request paid for their full schemas + system roles (Gemini countTokens,
 * 2026-10-13: memory ~8.0K tokens, message ~5.4K, arckep-sites ~4.6K, cron ~2.3K, creds ~2.0K,
 * arckep-bot ~2.0K, calculator ~3.3K, notebook ~1.3K); the median first message of a topic carried
 * ~47K input tokens. They stay listed in <available_tools> and the model loads them on demand with
 * lobe-activator `activateTools` (isExplicitActivation bypasses the enable rules). All of them are
 * discoverable; page-agent and the builder tools are not, so they stay pre-loaded. Memory recall is
 * injected by UserMemoryInjector regardless of the memory tool. Builtin agents, tools picked for the
 * message and the server agent path (bots, cron) are untouched.
 */
export const arckepLazyToolIds = [
  MemoryManifest.identifier,
  MessageManifest.identifier,
  ArckepSitesManifest.identifier,
  CronManifest.identifier,
  CredsManifest.identifier,
  ArckepBotManifest.identifier,
  ArckepStudioManifest.identifier,
  CalculatorManifest.identifier,
  NotebookManifest.identifier,
  AgentDocumentsManifest.identifier,
];

/**
 * arckep (план chat-next-redesign, F6, 18.10.2026): подключения чата студии `mcp-arckep-studio-*`
 * (image-studio, mcp_service/chat_connectors.py) — инструменты публичного MCP Arckep по областям
 * (картинки, видео, Higgsfield, 3D, озвучка, презентации, другие модели, баланс). Их манифесты —
 * до 18 тыс. символов у Higgsfield — грузятся так же по требованию: в <available_tools> одна строка на
 * область, схемы приходят после activateTools. Заменяют встроенный arckep-studio.
 */
export const ARCKEP_STUDIO_CONNECTOR_PREFIX = 'mcp-arckep-studio-';
export const isArckepLazyToolId = (id: string): boolean =>
  arckepLazyToolIds.includes(id) || id.startsWith(ARCKEP_STUDIO_CONNECTOR_PREFIX);

/**
 * arckep (19.10.2026, серверный путь; 21.10.2026 — включая песочницу E2B): подключения MCP человека (`mcp-*`)
 * грузятся по требованию — схемы их инструментов уходили в каждое сообщение. Статистика за 60 дней: Wordstat
 * вызывали 1 раз (у 284 помощников), песочницу E2B — 89 раз от 4 человек при включении у 283 помощников.
 * Сюда добавлять только подключения, которые должны быть под рукой с первого сообщения без activateTools.
 */
export const ARCKEP_MCP_CONNECTOR_PREFIX = 'mcp-';
/** Подключение песочницы E2B (шлюз коннекторов, execute_code / read_file). */
export const ARCKEP_E2B_CONNECTOR_ID = 'mcp-arckep-e2b-sandbox';
export const ARCKEP_EAGER_MCP_TOOL_IDS: readonly string[] = [];
/**
 * arckep (19.10.2026, этап 3 «свои инструменты»): свои подключения людей — `umcp-` + 12 знаков [a-z0-9], их
 * выдаёт бэкенд студии. Префикс `mcp-arckep-` у них запрещён: каталог движка — свежие строки `mcp-arckep-*`
 * всех людей, чужая строка с этим префиксом попала бы в каталог каждому. Вызов идёт на шлюз
 * (`USER_MCP_GATEWAY_URL`), а не по адресу из строки базы. Грузятся по требованию, как остальные `mcp-*`.
 */
export const ARCKEP_USER_MCP_PREFIX = 'umcp-';
export const isArckepUserMcpId = (id: string): boolean => /^umcp-[a-z0-9]{12}$/.test(id);

export const isArckepLazyMcpConnectorId = (id: string): boolean =>
  (id.startsWith(ARCKEP_MCP_CONNECTOR_PREFIX) && !ARCKEP_EAGER_MCP_TOOL_IDS.includes(id)) ||
  id.startsWith(ARCKEP_USER_MCP_PREFIX);

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): платные запуски студии, которые в теме со «своим» инструментом человека
 * (`umcp-*`) не выполняются без подтверждения человеком. У подключений студии `mcp-arckep-studio-*` — имена
 * `create_*`, `revise_*`, `replicate_*`, `chat_completion`, `decide`; у встроенной «Студии» — только платные
 * `createImage` и `createSpeech` (оценка, чтение результата, список моделей и баланс денег не тратят).
 */
export const isArckepPaidStudioTool = (identifier: string, apiName: string): boolean => {
  if (identifier.startsWith(ARCKEP_STUDIO_CONNECTOR_PREFIX)) {
    return (
      apiName.startsWith('create_') ||
      apiName.startsWith('revise_') ||
      apiName.startsWith('replicate_') ||
      apiName === 'chat_completion' ||
      apiName === 'decide'
    );
  }
  if (identifier === ArckepStudioManifest.identifier) {
    return apiName === 'createImage' || apiName === 'createSpeech';
  }
  return false;
};

/**
 * arckep (19.10.2026, этап 3, п. 3.Д): инструменты, которые открывают адрес, названный моделью. В теме с чужим
 * инструментом это канал вывода данных беседы: чужой сервер просит открыть адрес злоумышленника с данными в
 * запросе. Такие вызовы тоже ждут подтверждения (поиск — нет): `web_fetch` у `mcp-arckep-studio-web`, чтение
 * страниц встроенным `lobe-web-browsing` и импорт навыка по ссылке `arckep-skills.saveSkillFromUrl`.
 */
export const isArckepPageOpeningTool = (identifier: string, apiName: string): boolean =>
  (identifier === `${ARCKEP_STUDIO_CONNECTOR_PREFIX}web` && apiName === 'web_fetch') ||
  (identifier === WebBrowsingManifest.identifier &&
    (apiName === 'crawlSinglePage' || apiName === 'crawlMultiPages')) ||
  (identifier === ArckepSkillsManifest.identifier && apiName === 'saveSkillFromUrl');

/** Метка перед JSON запроса подтверждения в ответе инструмента (читает экран студии): `ARCKEP_CONFIRM {json}`. */
export const ARCKEP_CONFIRM_MARKER = 'ARCKEP_CONFIRM';

export const builtinTools: LobeBuiltinTool[] = [
  {
    discoverable: false,
    hidden: true,
    identifier: LobeActivatorManifest.identifier,
    manifest: LobeActivatorManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: SkillsManifest.identifier,
    manifest: SkillsManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: SkillStoreManifest.identifier,
    manifest: SkillStoreManifest,
    type: 'builtin',
  },
  {
    discoverable: isDesktop,
    hidden: true,
    identifier: LocalSystemManifest.identifier,
    manifest: LocalSystemManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: MemoryManifest.identifier,
    manifest: MemoryManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: WebBrowsingManifest.identifier,
    manifest: WebBrowsingManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: CloudSandboxManifest.identifier,
    manifest: CloudSandboxManifest,
    type: 'builtin',
  },
  {
    // arckep: hide when ARCKEP_LOBE_DOCUMENTS_ENABLED!=true (replaced by sandbox + arckep_tools).
    discoverable: ARCKEP_LOBE_DOCUMENTS_ENABLED,
    hidden: !ARCKEP_LOBE_DOCUMENTS_ENABLED,
    identifier: DocumentsIdentifier,
    manifest: DocumentsManifest,
    type: 'builtin',
  },
  {
    identifier: CredsManifest.identifier,
    manifest: CredsManifest,
    type: 'builtin',
  },
  {
    identifier: CronManifest.identifier,
    manifest: CronManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: KnowledgeBaseManifest.identifier,
    manifest: KnowledgeBaseManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: PageAgentManifest.identifier,
    manifest: PageAgentManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: AgentBuilderManifest.identifier,
    manifest: AgentBuilderManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: AgentDocumentsManifest.identifier,
    manifest: AgentDocumentsManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: GroupAgentBuilderManifest.identifier,
    manifest: GroupAgentBuilderManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: GroupManagementManifest.identifier,
    manifest: GroupManagementManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: AgentManagementManifest.identifier,
    manifest: AgentManagementManifest,
    type: 'builtin',
  },
  {
    identifier: GTDManifest.identifier,
    manifest: GTDManifest,
    type: 'builtin',
  },
  {
    identifier: NotebookManifest.identifier,
    manifest: NotebookManifest,
    type: 'builtin',
  },
  {
    identifier: CalculatorManifest.identifier,
    manifest: CalculatorManifest,
    type: 'builtin',
  },
  {
    identifier: ArckepSitesManifest.identifier,
    manifest: ArckepSitesManifest,
    type: 'builtin',
  },
  {
    identifier: ArckepBotManifest.identifier,
    manifest: ArckepBotManifest,
    type: 'builtin',
  },
  {
    // arckep (19.10.2026): «Мои навыки» — помощник сам сохраняет навык человека; грузится по требованию
    // (только серверный путь движка без интерфейса, в браузерном списке инструментов его нет)
    discoverable: false,
    hidden: true,
    identifier: ArckepSkillsManifest.identifier,
    manifest: ArckepSkillsManifest,
    type: 'builtin',
  },
  {
    // arckep (19.10.2026, этап 3): поиск подключений для модели; по требованию, только серверный путь движка
    discoverable: false,
    hidden: true,
    identifier: ArckepConnectorsManifest.identifier,
    manifest: ArckepConnectorsManifest,
    type: 'builtin',
  },
  {
    // arckep (19.10.2026): сверка письма с макетом PDF и правки артефакта кусками. Не в списке для подключения:
    // execAgent включает инструмент сам, когда в теме есть PDF или HTML-артефакт (схема ≈ 0,5 тыс. токенов)
    discoverable: false,
    hidden: true,
    identifier: ArckepLayoutManifest.identifier,
    manifest: ArckepLayoutManifest,
    type: 'builtin',
  },
  {
    identifier: ArckepStudioManifest.identifier,
    manifest: ArckepStudioManifest,
    type: 'builtin',
  },
  {
    identifier: MessageManifest.identifier,
    manifest: MessageManifest,
    type: 'builtin',
  },
  {
    hidden: true,
    identifier: RemoteDeviceManifest.identifier,
    manifest: RemoteDeviceManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: TopicReferenceManifest.identifier,
    manifest: TopicReferenceManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: WebOnboardingManifest.identifier,
    manifest: WebOnboardingManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: UserInteractionManifest.identifier,
    manifest: UserInteractionManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: TaskManifest.identifier,
    manifest: TaskManifest,
    type: 'builtin',
  },
  {
    discoverable: false,
    hidden: true,
    identifier: BriefManifest.identifier,
    manifest: BriefManifest,
    type: 'builtin',
  },
];

const recommendedBuiltinIds = new Set(
  RECOMMENDED_SKILLS.filter((s) => s.type === RecommendedSkillType.Builtin).map((s) => s.id),
);
const defaultBuiltinIds = new Set(defaultToolIds);

export const defaultUninstalledBuiltinTools = builtinTools
  .filter(
    (t) =>
      !t.hidden && !recommendedBuiltinIds.has(t.identifier) && !defaultBuiltinIds.has(t.identifier),
  )
  .map((t) => t.identifier);
