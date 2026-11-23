import { createHash } from 'node:crypto';

import type { LobeChatDatabase } from '@lobechat/database';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';

import { agents, projectWorkspaceFiles } from '@/database/schemas';

export const DATA_GUARD_MASKED_WORKSPACE_CONTENT =
  '[Содержимое незащищённого файла проекта скрыто в защищённом режиме]';
export const DATA_GUARD_MASKED_TOOL_ARGUMENTS = '{"masked":"[Data Guard]"}';

const WORKSPACE_IDENTIFIER = 'arckep-workspace';
const WORKSPACE_ID_MD5_TOKEN = `MD5HASH_${createHash('md5').update(WORKSPACE_IDENTIFIER).digest('hex').slice(0, 12)}`;
const SEARCH_KB_API = 'searchKnowledgeBase';
const SEARCH_KB_MD5_TOKEN = `MD5HASH_${createHash('md5').update(SEARCH_KB_API).digest('hex').slice(0, 12)}`;

const WORKSPACE_TOOL_APIS = new Set([
  'listProjectFiles',
  'searchProjectFiles',
  'readProjectFile',
  'patchProjectFile',
  'writeProjectFile',
  'writeProjectFilePart',
  'deleteProjectFile',
]);

export interface WorkspaceDataGuardState {
  dataGuardCommercial: boolean;
  dataGuardProtected: boolean;
  dataGuardProtectedSince: string | null;
  projectDataGuardEnabled: boolean;
  unmaskedActiveCount: number;
  workspaceDataGuardReady: boolean;
}

const isSensitiveWorkspaceOrSearchToolName = (rawName: unknown): boolean => {
  if (!rawName || typeof rawName !== 'string') return false;

  // Never mask readKnowledge (scrubbed chat attachments rely on readKnowledge)
  if (
    rawName === 'readKnowledge' ||
    rawName.endsWith('____readKnowledge') ||
    rawName.includes('____readKnowledge____') ||
    rawName.endsWith('.readKnowledge') ||
    rawName.endsWith('/readKnowledge')
  ) {
    return false;
  }

  for (const prefix of [WORKSPACE_IDENTIFIER, WORKSPACE_ID_MD5_TOKEN]) {
    if (
      rawName === prefix ||
      rawName.startsWith(`${prefix}____`) ||
      rawName.startsWith(`${prefix}.`) ||
      rawName.startsWith(`${prefix}/`) ||
      rawName.startsWith(`${prefix}__`)
    ) {
      return true;
    }
  }

  for (const wsApi of WORKSPACE_TOOL_APIS) {
    if (
      (rawName.includes(WORKSPACE_IDENTIFIER) || rawName.includes(WORKSPACE_ID_MD5_TOKEN)) &&
      rawName.includes(wsApi)
    ) {
      return true;
    }
  }

  if (
    rawName === SEARCH_KB_API ||
    rawName.includes(`____${SEARCH_KB_API}`) ||
    rawName.includes(`.${SEARCH_KB_API}`) ||
    rawName.includes(`/${SEARCH_KB_API}`) ||
    rawName.includes(`__${SEARCH_KB_API}`) ||
    rawName.includes(`____${SEARCH_KB_MD5_TOKEN}`)
  ) {
    return true;
  }

  return false;
};

const isSensitiveWorkspaceOrSearchPayload = (
  identifier: unknown,
  apiName: unknown,
  fallbackName?: unknown,
): boolean => {
  if (apiName === 'readKnowledge') return false;
  if (identifier === WORKSPACE_IDENTIFIER || identifier === WORKSPACE_ID_MD5_TOKEN) return true;
  if (apiName === SEARCH_KB_API || apiName === SEARCH_KB_MD5_TOKEN) return true;
  if (typeof apiName === 'string' && WORKSPACE_TOOL_APIS.has(apiName) && !identifier) return true;
  return isSensitiveWorkspaceOrSearchToolName(fallbackName);
};

export async function computeWorkspaceDataGuardState(params: {
  agentChatConfig?: Record<string, unknown> | null;
  agentId?: string | null;
  db?: LobeChatDatabase | null;
  requestDataGuardProtected?: boolean;
  userId?: string | null;
}): Promise<WorkspaceDataGuardState> {
  const { agentId, db, requestDataGuardProtected, userId } = params;
  const hasSelect = Boolean(db && typeof (db as any).select === 'function');

  let chatConfig = params.agentChatConfig;
  if (chatConfig === undefined && hasSelect && userId && agentId && agentId !== 'inbox') {
    const rows = await db!
      .select({ chatConfig: agents.chatConfig })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
      .limit(1);
    chatConfig = (rows[0]?.chatConfig as Record<string, unknown> | null | undefined) ?? null;
  }

  const projectDataGuardEnabled = Boolean(chatConfig?.dataGuardProtected);
  const dataGuardCommercial = Boolean(chatConfig?.dataGuardCommercial);
  const dataGuardProtectedSince =
    typeof chatConfig?.dataGuardProtectedSince === 'string' &&
    chatConfig.dataGuardProtectedSince.length > 0
      ? chatConfig.dataGuardProtectedSince
      : null;
  const dataGuardProtected = Boolean(
    projectDataGuardEnabled || chatConfig?.deepseekDataGuardProtected || requestDataGuardProtected,
  );

  if (!projectDataGuardEnabled) {
    return {
      dataGuardCommercial,
      dataGuardProtected,
      dataGuardProtectedSince,
      projectDataGuardEnabled: false,
      unmaskedActiveCount: 0,
      workspaceDataGuardReady: false,
    };
  }

  let unmaskedActiveCount = 0;
  if (agentId && agentId !== 'inbox' && userId && hasSelect) {
    const [countRow] = await db!
      .select({ count: sql<number>`count(*)::int` })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.userId, userId),
          eq(projectWorkspaceFiles.agentId, agentId),
          isNull(projectWorkspaceFiles.deletedAt),
          ne(projectWorkspaceFiles.loadMode, 'disabled'),
          ne(projectWorkspaceFiles.dataGuardStatus, 'scrubbed'),
        ),
      );
    unmaskedActiveCount = Number(countRow?.count ?? 0);
  }

  const workspaceDataGuardReady = Boolean(
    projectDataGuardEnabled && agentId && agentId !== 'inbox' && unmaskedActiveCount === 0,
  );

  return {
    dataGuardCommercial,
    dataGuardProtected,
    dataGuardProtectedSince,
    projectDataGuardEnabled,
    unmaskedActiveCount,
    workspaceDataGuardReady,
  };
}

export function maskUnmaskedWorkspaceHistoryForSummarizer<T extends Record<string, any>>(
  messages: T[],
): T[] {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const maskedCallIds = new Set<string>();
  const maskedMsgIds = new Set<string>();

  const collectFromItem = (item: any) => {
    if (!item || typeof item !== 'object') return;

    if (Array.isArray(item.tools)) {
      for (const tool of item.tools) {
        if (!tool || typeof tool !== 'object') continue;
        if (isSensitiveWorkspaceOrSearchPayload(tool.identifier, tool.apiName, tool.name)) {
          if (typeof tool.id === 'string' && tool.id) {
            maskedCallIds.add(tool.id);
          }
          if (typeof tool.result?.id === 'string' && tool.result.id) {
            maskedMsgIds.add(tool.result.id);
          }
        }
      }
    }

    if (Array.isArray(item.tool_calls)) {
      for (const tc of item.tool_calls) {
        if (!tc || typeof tc !== 'object') continue;
        if (
          isSensitiveWorkspaceOrSearchToolName(tc.function?.name ?? tc.name) &&
          typeof tc.id === 'string' &&
          tc.id
        ) {
          maskedCallIds.add(tc.id);
        }
      }
    }

    if (
      item.role === 'tool' &&
      (isSensitiveWorkspaceOrSearchPayload(
        item.plugin?.identifier,
        item.plugin?.apiName,
        item.name,
      ) ||
        (typeof item.tool_call_id === 'string' && maskedCallIds.has(item.tool_call_id)))
    ) {
      if (typeof item.id === 'string' && item.id) {
        maskedMsgIds.add(item.id);
      }
      if (typeof item.tool_call_id === 'string' && item.tool_call_id) {
        maskedCallIds.add(item.tool_call_id);
      }
    }

    for (const key of ['children', 'members', 'tasks']) {
      if (Array.isArray(item[key])) {
        for (const child of item[key]) collectFromItem(child);
      }
    }
  };

  for (const msg of messages) {
    collectFromItem(msg);
  }
  // Second pass in case a tool message appeared before its linked reference
  for (const msg of messages) {
    collectFromItem(msg);
  }

  const transformMessage = (msg: any): any => {
    if (!msg || typeof msg !== 'object') return msg;

    let changed = false;
    let nextContent = msg.content;
    let nextPlugin = msg.plugin;
    let nextTools = msg.tools;
    let nextToolCalls = msg.tool_calls;
    let nextChildren = msg.children;

    const isExplicitReadKnowledge =
      msg.plugin?.apiName === 'readKnowledge' ||
      msg.name === 'readKnowledge' ||
      (typeof msg.name === 'string' &&
        (msg.name.endsWith('____readKnowledge') || msg.name.includes('____readKnowledge____')));

    const isToolOrConvertedMsg =
      msg.role === 'tool' ||
      (typeof msg.id === 'string' && maskedMsgIds.has(msg.id)) ||
      (typeof msg.tool_call_id === 'string' && maskedCallIds.has(msg.tool_call_id));

    if (!isExplicitReadKnowledge && isToolOrConvertedMsg) {
      const shouldMaskToolMsg =
        (typeof msg.id === 'string' && maskedMsgIds.has(msg.id)) ||
        (typeof msg.tool_call_id === 'string' && maskedCallIds.has(msg.tool_call_id)) ||
        isSensitiveWorkspaceOrSearchPayload(msg.plugin?.identifier, msg.plugin?.apiName, msg.name);

      if (shouldMaskToolMsg) {
        if (nextContent !== DATA_GUARD_MASKED_WORKSPACE_CONTENT) {
          nextContent = DATA_GUARD_MASKED_WORKSPACE_CONTENT;
          changed = true;
        }
        if (
          nextPlugin &&
          typeof nextPlugin === 'object' &&
          typeof nextPlugin.arguments === 'string' &&
          nextPlugin.arguments !== DATA_GUARD_MASKED_TOOL_ARGUMENTS
        ) {
          nextPlugin = { ...nextPlugin, arguments: DATA_GUARD_MASKED_TOOL_ARGUMENTS };
          changed = true;
        }
      }
    }

    if (Array.isArray(msg.tools)) {
      let toolsModified = false;
      const mappedTools = msg.tools.map((tool: any) => {
        if (!tool || typeof tool !== 'object') return tool;
        const sensitive =
          tool.apiName !== 'readKnowledge' &&
          ((typeof tool.id === 'string' && maskedCallIds.has(tool.id)) ||
            isSensitiveWorkspaceOrSearchPayload(tool.identifier, tool.apiName, tool.name));
        if (!sensitive) return tool;

        let toolChanged = false;
        let updatedTool = tool;
        if (tool.arguments !== DATA_GUARD_MASKED_TOOL_ARGUMENTS) {
          updatedTool = { ...updatedTool, arguments: DATA_GUARD_MASKED_TOOL_ARGUMENTS };
          toolChanged = true;
        }
        if (
          tool.result &&
          typeof tool.result === 'object' &&
          tool.result.content !== DATA_GUARD_MASKED_WORKSPACE_CONTENT
        ) {
          updatedTool = {
            ...updatedTool,
            result: { ...tool.result, content: DATA_GUARD_MASKED_WORKSPACE_CONTENT },
          };
          toolChanged = true;
        }
        if (toolChanged) toolsModified = true;
        return updatedTool;
      });

      if (toolsModified) {
        nextTools = mappedTools;
        changed = true;
      }
    }

    if (Array.isArray(msg.tool_calls)) {
      let callsModified = false;
      const mappedCalls = msg.tool_calls.map((tc: any) => {
        if (!tc || typeof tc !== 'object') return tc;
        const sensitive =
          (typeof tc.id === 'string' && maskedCallIds.has(tc.id)) ||
          isSensitiveWorkspaceOrSearchToolName(tc.function?.name ?? tc.name);
        if (!sensitive) return tc;

        let tcChanged = false;
        let updatedTc = tc;
        if (
          tc.function &&
          typeof tc.function === 'object' &&
          tc.function.arguments !== DATA_GUARD_MASKED_TOOL_ARGUMENTS
        ) {
          updatedTc = {
            ...updatedTc,
            function: { ...tc.function, arguments: DATA_GUARD_MASKED_TOOL_ARGUMENTS },
          };
          tcChanged = true;
        }
        if (typeof tc.arguments === 'string' && tc.arguments !== DATA_GUARD_MASKED_TOOL_ARGUMENTS) {
          updatedTc = { ...updatedTc, arguments: DATA_GUARD_MASKED_TOOL_ARGUMENTS };
          tcChanged = true;
        }
        if (tcChanged) callsModified = true;
        return updatedTc;
      });

      if (callsModified) {
        nextToolCalls = mappedCalls;
        changed = true;
      }
    }

    if (Array.isArray(msg.children)) {
      let childrenModified = false;
      const mappedChildren = msg.children.map((child: any) => {
        const nextChild = transformMessage(child);
        if (nextChild !== child) childrenModified = true;
        return nextChild;
      });
      if (childrenModified) {
        nextChildren = mappedChildren;
        changed = true;
      }
    }

    if (!changed) return msg;
    return {
      ...msg,
      ...(nextContent !== msg.content ? { content: nextContent } : {}),
      ...(nextPlugin !== msg.plugin ? { plugin: nextPlugin } : {}),
      ...(nextTools !== msg.tools ? { tools: nextTools } : {}),
      ...(nextToolCalls !== msg.tool_calls ? { tool_calls: nextToolCalls } : {}),
      ...(nextChildren !== msg.children ? { children: nextChildren } : {}),
    };
  };

  return messages.map((msg) => transformMessage(msg));
}
