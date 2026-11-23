import { AsyncLocalStorage } from 'node:async_hooks';

import type { LobeChatDatabase } from '@lobechat/database';
import { safeParseJSON } from '@lobechat/utils';

import type { ImageContent, ToolCallContent } from '@/libs/mcp';

import {
  type ArckepSandboxSyncReport,
  commitSandboxSync,
  type CommitSandboxSyncResult,
  extractAndStripArckepSync,
  type SandboxSyncStorage,
} from './commitSync';
import {
  type ArckepSandboxBridgeEnvelope,
  buildSandboxManifest,
  type SandboxS3Presigner,
} from './manifest';

export interface SandboxBridgeContext {
  agentId?: string | null;
  dataGuardProtected?: boolean;
  messageId?: string | null;
  parentMessageId?: string | null;
  presigner?: SandboxS3Presigner | null;
  s3?: SandboxSyncStorage;
  serverDB?: LobeChatDatabase;
  topicId?: string;
  userId?: string;
}

interface ActiveBridgeScope {
  context: SandboxBridgeContext;
  receiptTrailers: string[];
}

const sandboxBridgeStorage = new AsyncLocalStorage<ActiveBridgeScope>();

let testBridgeDepsOverride: {
  presigner?: SandboxS3Presigner | null;
  s3?: SandboxSyncStorage;
} | null = null;

export const setSandboxBridgeDepsForTests = (
  deps: { presigner?: SandboxS3Presigner | null; s3?: SandboxSyncStorage } | null,
): void => {
  testBridgeDepsOverride = deps;
};

export const runWithSandboxBridgeScope = async <T>(
  context: SandboxBridgeContext,
  fn: () => Promise<T>,
): Promise<{ result: T; trailer: string }> => {
  const scope: ActiveBridgeScope = {
    context,
    receiptTrailers: [],
  };
  const result = await sandboxBridgeStorage.run(scope, fn);
  const trailer = scope.receiptTrailers.filter(Boolean).join('\n');
  return { result, trailer };
};

export const getActiveSandboxBridgeContext = (): SandboxBridgeContext | undefined =>
  sandboxBridgeStorage.getStore()?.context;

export const hasActiveSandboxBridgeScope = (): boolean =>
  sandboxBridgeStorage.getStore() !== undefined;

export const appendSandboxBridgeTrailer = (trailer: string): void => {
  if (!trailer) return;
  const store = sandboxBridgeStorage.getStore();
  if (store) {
    store.receiptTrailers.push(trailer);
  }
};

export const appendTrailerAfterTruncation = (content: string, trailer: string): string => {
  if (!trailer) return content;
  if (!content) return trailer;
  return `${content}\n\n${trailer}`;
};

/**
 * Unconditionally strips any client/model-supplied `_arckep_bridge` field from tool arguments
 * (anti-spoofing protection before injecting server-generated bridge envelope).
 */
export const sanitizeBridgeArgumentsObject = (
  rawArgs: Record<string, unknown>,
): Record<string, unknown> => {
  const cleaned = { ...rawArgs };
  delete cleaned._arckep_bridge;
  return cleaned;
};

export const sanitizeBridgeArgumentsString = (
  argsStr: string | undefined,
): {
  cleanedArgsStr: string;
  parsedArgs: Record<string, unknown>;
} => {
  const parsed = safeParseJSON<Record<string, unknown>>(argsStr);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { cleanedArgsStr: argsStr || '{}', parsedArgs: {} };
  }
  if ('_arckep_bridge' in parsed) {
    const cleaned = sanitizeBridgeArgumentsObject(parsed);
    return { cleanedArgsStr: JSON.stringify(cleaned), parsedArgs: cleaned };
  }
  return { cleanedArgsStr: argsStr || '{}', parsedArgs: { ...parsed } };
};

export interface PreparedSandboxBridgeSession {
  argsObject: Record<string, unknown>;
  argsStr: string;
  callUuid: string;
  commitFromSyncReport: (syncReport: ArckepSandboxSyncReport) => Promise<CommitSandboxSyncResult>;
  effectiveAgentId?: string;
  effectiveDataGuard: boolean;
  envelope: ArckepSandboxBridgeEnvelope | null;
  remotion: boolean;
  slotKeyMap: Map<number, string>;
}

export async function prepareSandboxBridgeSession(params: {
  apiName: string;
  argsObject?: Record<string, unknown>;
  argsStr?: string;
  context?: SandboxBridgeContext;
}): Promise<PreparedSandboxBridgeSession> {
  const baseParsed = params.argsObject
    ? sanitizeBridgeArgumentsObject(params.argsObject)
    : sanitizeBridgeArgumentsString(params.argsStr).parsedArgs;

  const { apiName } = params;
  const ctx = params.context ?? getActiveSandboxBridgeContext();
  const remotion = baseParsed.template === 'remotion';

  if (apiName === 'kill_session' || !ctx?.serverDB || !ctx.userId || !ctx.topicId) {
    const cleanedArgsStr = JSON.stringify(baseParsed);
    return {
      argsObject: baseParsed,
      argsStr: cleanedArgsStr,
      callUuid: '',
      commitFromSyncReport: async () => ({
        markerLines: [],
        mediaBlocks: [],
        noticeLines: [],
        receiptFooter: '',
      }),
      effectiveAgentId: ctx?.agentId || undefined,
      effectiveDataGuard: Boolean(ctx?.dataGuardProtected),
      envelope: null,
      remotion,
      slotKeyMap: new Map(),
    };
  }

  const explicitOutputFile =
    apiName === 'execute_and_get_file' && typeof baseParsed.output_file === 'string'
      ? baseParsed.output_file
      : null;
  const includeUploadSlots = apiName === 'execute_code' || apiName === 'execute_and_get_file';

  const manifest = await buildSandboxManifest({
    agentId: ctx.agentId,
    dataGuardProtected: ctx.dataGuardProtected,
    explicitOutputFile,
    includeUploadSlots,
    presigner: ctx.presigner !== undefined ? ctx.presigner : testBridgeDepsOverride?.presigner,
    remotion,
    serverDB: ctx.serverDB,
    topicId: ctx.topicId,
    userId: ctx.userId,
  });

  const argsWithEnvelope: Record<string, unknown> = manifest.topicOwned
    ? {
        ...baseParsed,
        _arckep_bridge: manifest.envelope,
      }
    : baseParsed;

  return {
    argsObject: argsWithEnvelope,
    argsStr: JSON.stringify(argsWithEnvelope),
    callUuid: manifest.callUuid,
    commitFromSyncReport: async (syncReport) =>
      commitSandboxSync({
        callUuid: manifest.callUuid,
        effectiveAgentId: manifest.effectiveAgentId,
        effectiveDataGuard: manifest.effectiveDataGuard,
        messageId: ctx.messageId ?? ctx.parentMessageId ?? null,
        remotion,
        s3: ctx.s3 ?? testBridgeDepsOverride?.s3,
        serverDB: ctx.serverDB!,
        slotKeyMap: manifest.slotKeyMap,
        syncReport,
        topicId: ctx.topicId!,
        userId: ctx.userId!,
      }),
    effectiveAgentId: manifest.effectiveAgentId,
    effectiveDataGuard: manifest.effectiveDataGuard,
    envelope: manifest.topicOwned ? manifest.envelope : null,
    remotion,
    slotKeyMap: manifest.slotKeyMap,
  };
}

/**
 * Strips `_arckepSync` from MCP `ToolCallContent[]` blocks and executes `commitSandboxSync`
 * before `processContentBlocks` / `contentBlocksToString` runs.
 */
export async function stripAndCommitMcpBlocks(
  blocks: ToolCallContent[],
  session: PreparedSandboxBridgeSession,
): Promise<{
  cleanedBlocks: ToolCallContent[];
  mediaBlocks: ImageContent[];
  receiptFooter: string;
}> {
  const cleanedBlocks: ToolCallContent[] = [];
  const mediaBlocks: ImageContent[] = [];
  const footers: string[] = [];

  for (const block of blocks) {
    if (block.type !== 'text') {
      cleanedBlocks.push(block);
      continue;
    }

    const { cleanedText, syncReport } = extractAndStripArckepSync(block.text);
    if (cleanedText || blocks.length === 1) {
      cleanedBlocks.push({ ...block, text: cleanedText });
    }

    if (syncReport) {
      const committed = await session.commitFromSyncReport(syncReport);
      if (committed.mediaBlocks.length > 0) {
        mediaBlocks.push(...committed.mediaBlocks);
      }
      if (committed.receiptFooter) {
        footers.push(committed.receiptFooter);
      }
    }
  }

  return {
    cleanedBlocks,
    mediaBlocks,
    receiptFooter: footers.join('\n'),
  };
}
