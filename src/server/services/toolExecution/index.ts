import { ARCKEP_STUDIO_CONNECTOR_PREFIX } from '@lobechat/builtin-tools';
import { type ChatToolPayload } from '@lobechat/types';
import { safeParseJSON } from '@lobechat/utils';
import debug from 'debug';

import { PluginModel } from '@/database/models/plugin';
import { type CloudMCPParams, type ToolCallContent } from '@/libs/mcp';
import { contentBlocksToString } from '@/server/services/mcp/contentProcessor';
import {
  DEFAULT_TOOL_RESULT_MAX_LENGTH,
  truncateToolResult,
} from '@/server/utils/truncateToolResult';

import { DiscoverService } from '../discover';
import { type MCPService } from '../mcp';
import { type BuiltinToolsExecutor } from './builtin';
import { classifyToolError } from './errorClassification';
import {
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolExecutionResultResponse,
} from './types';

const log = debug('lobe-server:tool-execution-service');

/**
 * Куда ходят подключения студии mcp-arckep-studio-* (F6): публичный MCP Arckep на этой же машине
 * (служба image-studio-public-mcp). Адрес задаёт сервер, не манифест подключения.
 */
const ARCKEP_STUDIO_MCP_URL = process.env.ARCKEP_STUDIO_MCP_URL || 'http://127.0.0.1:8422/mcp';

interface ToolExecutionServiceDeps {
  builtinToolsExecutor: BuiltinToolsExecutor;
  mcpService: MCPService;
}

const normalizeExecutionError = (error: unknown, fallbackMessage: string) => {
  const normalized = classifyToolError(error || fallbackMessage);
  const message = fallbackMessage || normalized.message;

  if (error && typeof error === 'object') {
    if (error instanceof Error) {
      return {
        code: normalized.code,
        kind: normalized.kind,
        message: error.message || message,
        name: error.name,
      };
    }

    const plainError = error as Record<string, unknown>;

    return {
      ...plainError,
      code: (plainError.code as string | undefined) || normalized.code,
      kind: normalized.kind,
      message: (plainError.message as string | undefined) || message,
    };
  }

  if (typeof error === 'string') {
    return { code: normalized.code, kind: normalized.kind, message: error };
  }

  return { code: normalized.code, kind: normalized.kind, message };
};

export class ToolExecutionService {
  private builtinToolsExecutor: BuiltinToolsExecutor;
  private mcpService: MCPService;

  constructor({ mcpService, builtinToolsExecutor }: ToolExecutionServiceDeps) {
    this.builtinToolsExecutor = builtinToolsExecutor;
    this.mcpService = mcpService;
  }

  async executeTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResultResponse> {
    const { identifier, apiName, type } = payload;

    log('Executing tool: %s:%s (type: %s)', identifier, apiName, type);

    const startTime = Date.now();
    try {
      const typeStr = type as string;
      let data: ToolExecutionResult;
      switch (typeStr) {
        case 'mcp': {
          data = await this.executeMCPTool(payload, context);
          break;
        }

        case 'builtin':
        default: {
          data = await this.builtinToolsExecutor.execute(payload, context);
          break;
        }
      }

      const executionTime = Date.now() - startTime;

      // Truncate result content to prevent context overflow
      // Use agent-specific config if provided, otherwise use default
      // Source readers already return bounded pages with exact cursors. Cutting a page
      // again would silently skip source characters on the next read.
      const truncatedContent =
        (identifier === 'lobe-knowledge-base' && apiName === 'readKnowledge') ||
        (identifier === 'lobe-topic-reference' && apiName === 'getTopicContext')
          ? data.content
          : truncateToolResult(data.content, context.toolResultMaxLength);

      // Log if content was truncated
      if (truncatedContent !== data.content) {
        const maxLength = context.toolResultMaxLength ?? DEFAULT_TOOL_RESULT_MAX_LENGTH;
        log(
          'Tool result truncated for %s:%s - original: %d chars, truncated: %d chars (limit: %d)',
          identifier,
          apiName,
          data.content.length,
          truncatedContent.length,
          maxLength,
        );
      }

      if (!data.success) {
        return {
          ...data,
          content: truncatedContent,
          error: normalizeExecutionError(data.error, data.content),
          executionTime,
        };
      }

      return {
        ...data,
        content: truncatedContent,
        executionTime,
      };

      // Handle MCP and other types (default, standalone, markdown, mcp)
    } catch (error) {
      const executionTime = Date.now() - startTime;
      log('Error executing tool %s:%s: %O', identifier, apiName, error);
      const errorMessage = (error as Error).message;

      return {
        content: truncateToolResult(errorMessage),
        error: normalizeExecutionError(error, errorMessage),
        executionTime,
        success: false,
      };
    }
  }

  /**
   * arckep (план chat-next-redesign, F5, 18.10.2026). Браузерный путь (src/services/mcp.ts) подмешивает
   * данные доступа подключения (settings: X-MCP-Host, пароль и т. д.) в заголовки http-подключения или
   * окружение stdio, а серверный брал только manifest.mcpParams — из нового чата PostgreSQL, MySQL,
   * ClickHouse, amoCRM и Bitrix24 отвечали «не указан хост». Шлюз коннекторов узнаёт человека по
   * X-Arckep-User (как в браузерной песочнице, routers/tools/market.ts): квоты Wordstat и E2B — по людям.
   * Значения настроек в журнал не пишутся. Для stdio-подключений настройки не подмешиваются (это было бы
   * окружение подпроцесса на сервере), для http — только заголовки X-* без управляющих символов.
   */
  private async withUserConnectionParams(
    identifier: string,
    mcpParams: any,
    context: ToolExecutionContext,
  ): Promise<any> {
    if (!context.serverDB || !context.userId) return mcpParams;
    // Только сетевые подключения: для stdio настройки человека стали бы окружением подпроцесса на
    // сервере (LD_PRELOAD, NODE_OPTIONS, PATH…) — этого не делаем, у студии все подключения по http.
    if (mcpParams?.type !== 'http' && mcpParams?.type !== 'sse') return mcpParams;
    // Подключения студии mcp-arckep-studio-* (план chat-next-redesign, F6; решение владельца 18.10.2026 —
    // без ключей у людей): доверенный путь к MCP Arckep. Вместо ключа человека — служебный токен студии
    // (ARCKEP_INTERNAL_TOKEN, иначе LOBECHAT_BACKEND_KEY = INTERNAL_API_KEY студии) и номер человека;
    // API работает от его имени по скрытому ключу «Чат Arckep». Настройки такого подключения не читаются:
    // человеку в нём нечего заполнять, а чужие заголовки в доверенный запрос не нужны.
    const trusted = identifier.startsWith(ARCKEP_STUDIO_CONNECTOR_PREFIX);
    const settings: Record<string, string> = {};
    let arckepUserId: number | null = null;
    try {
      if (!trusted) {
        const plugin = await new PluginModel(context.serverDB, context.userId).findById(identifier);
        const raw = (plugin?.settings ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(raw)) {
          // Заголовки шлюза X-MCP-*: имя — только латиница, цифры, дефис и подчёркивание; значение — одна
          // строка без управляющих символов; служебные заголовки транспорта не переопределяются.
          if (!/^X-[\w-]{1,60}$/i.test(key)) continue;
          if (['x-arckep-user', 'x-mcp-user-id'].includes(key.toLowerCase())) continue;
          if (value === undefined || value === null || value === '') continue;
          const text = String(value)
            .replaceAll(/[\r\n\0]/g, '')
            .slice(0, 2000);
          if (text) settings[key] = text;
        }
      }
      try {
        const { resolveArckepUserId } = await import('./serverRuntimes/arckepStudio');
        arckepUserId = await resolveArckepUserId(context.serverDB, context.userId);
      } catch {
        arckepUserId = null; // аккаунт не из студии — шлюз получит запрос без номера человека
      }
    } catch (error) {
      log('MCP connection settings lookup failed for %s: %O', identifier, error);
      if (!trusted) return mcpParams;
    }
    if (trusted) {
      const token = process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;
      // Ошибка уходит модели текстом (executeMCPTool), а не в API без доступа: там был бы голый 401.
      if (!token) throw new Error('Подключение студии не настроено: нет служебного токена');
      if (!arckepUserId) throw new Error('Подключение студии доступно только аккаунтам студии Arckep');
      log('MCP connection %s: trusted, arckep user %s', identifier, arckepUserId);
      // Адрес и заголовки — только серверные: манифест (в том числе свой плагин человека с таким же
      // префиксом) не решает, куда уйдёт служебный токен. Номер человека тоже выведен сервером, так что
      // чужой манифест с этим префиксом даёт ровно то же, что подключение из каталога.
      return {
        headers: { 'Authorization': `Bearer ${token}`, 'X-Arckep-User': String(arckepUserId) },
        type: 'http',
        url: ARCKEP_STUDIO_MCP_URL,
      };
    }
    log(
      'MCP connection %s: %d setting(s), arckep user %s',
      identifier,
      Object.keys(settings).length,
      arckepUserId ?? '-',
    );
    return {
      ...mcpParams,
      headers: {
        ...mcpParams.headers,
        ...settings,
        ...(arckepUserId ? { 'X-Arckep-User': String(arckepUserId) } : {}),
      },
    };
  }

  private async executeMCPTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: args } = payload;

    log('Executing MCP tool: %s:%s', identifier, apiName);

    // Get the manifest from context
    const manifest = context.toolManifestMap[identifier];
    if (!manifest) {
      log('Manifest not found for MCP tool: %s', identifier);
      return {
        content: `Manifest not found for tool: ${identifier}`,
        error: {
          code: 'MANIFEST_NOT_FOUND',
          message: `Manifest not found for tool: ${identifier}`,
        },
        success: false,
      };
    }

    // Extract MCP params from manifest (stored in customParams.mcp in LobeTool)
    const mcpParams = (manifest as any).mcpParams;
    if (!mcpParams) {
      log('MCP configuration not found in manifest for: %s ', identifier);
      return {
        content: `MCP configuration not found for tool: ${identifier}, please tell user TRY TO REINSTALL THE MCP PLUGIN`,
        error: {
          code: 'MCP_CONFIG_NOT_FOUND',
          message: `MCP configuration not found for tool: ${identifier}`,
        },
        success: false,
      };
    }

    log(
      'Calling MCP service with params for: %s:%s (type: %s)',
      identifier,
      apiName,
      mcpParams.type,
    );

    try {
      // Check if this is a cloud MCP endpoint
      if (mcpParams.type === 'cloud') {
        return await this.executeCloudMCPTool(payload, context, mcpParams);
      }

      // For stdio/http/sse types, use standard MCP service
      const result = await this.mcpService.callTool({
        argsStr: args,
        clientParams: await this.withUserConnectionParams(identifier, mcpParams, context),
        toolName: apiName,
      });

      log('MCP tool execution successful for: %s:%s', identifier, apiName);

      return {
        content: typeof result === 'string' ? result : JSON.stringify(result),
        state: typeof result === 'object' ? result : undefined,
        success: true,
      };
    } catch (error) {
      log('MCP tool execution failed for %s:%s: %O', identifier, apiName, error);
      return {
        content: (error as Error).message,
        error: {
          code: 'MCP_EXECUTION_ERROR',
          message: (error as Error).message,
        },
        success: false,
      };
    }
  }

  private async executeCloudMCPTool(
    payload: ChatToolPayload,
    context: ToolExecutionContext,

    _mcpParams: CloudMCPParams,
  ): Promise<ToolExecutionResult> {
    const { identifier, apiName, arguments: args } = payload;

    log('Executing Cloud MCP tool: %s:%s via cloud gateway', identifier, apiName);

    try {
      // Create DiscoverService with user context
      const discoverService = new DiscoverService({
        userInfo: context.userId ? { userId: context.userId } : undefined,
      });

      // Parse arguments
      const apiParams = safeParseJSON(args) || {};

      // Call cloud MCP endpoint via Market API
      // Returns CloudGatewayResponse: { content: ToolCallContent[], isError?: boolean }
      const cloudResult = await discoverService.callCloudMcpEndpoint({
        apiParams,
        identifier,
        toolName: apiName,
      });

      const cloudResultContent = (cloudResult?.content ?? []) as ToolCallContent[];

      // Convert content blocks to string (same as market router does)
      const content = contentBlocksToString(cloudResultContent);
      const state = { ...cloudResult, content: cloudResultContent };

      log('Cloud MCP tool execution successful for: %s:%s', identifier, apiName);

      return {
        content,
        state,
        success: !cloudResult?.isError,
      };
    } catch (error) {
      log('Cloud MCP tool execution failed for %s:%s: %O', identifier, apiName, error);
      return {
        content: (error as Error).message,
        error: {
          code: 'CLOUD_MCP_EXECUTION_ERROR',
          message: (error as Error).message,
        },
        success: false,
      };
    }
  }
}

export * from './types';
