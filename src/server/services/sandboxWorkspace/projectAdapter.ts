import type { LobeChatDatabase } from '@lobechat/database';
import debug from 'debug';

const log = debug('lobe-server:sandbox-project-adapter');

export interface HydratableProjectWorkspaceFile {
  byteSize: number;
  currentFileId: string;
  currentRevision: number;
  dataGuardStatus: 'unmasked' | 'scrubbed';
  kind: 'text' | 'document';
  mimeType: string;
  path: string;
  readOnly: boolean;
  s3Key: string;
  sha256: string;
  workspaceFileId: string;
}

export type SandboxProjectSyncResult =
  | {
      addedLines: number;
      agentId: string;
      outcome: 'updated' | 'created';
      path: string;
      prevRevision: number | null;
      removedLines: number;
      revision: number;
      workspaceFileId: string;
    }
  | {
      addedLines: number;
      agentId: string;
      baseRevision: number | null;
      diffPreview: string;
      outcome: 'proposal_created';
      proposalId: string;
      proposalType: 'edit' | 'create_pinned';
      reason: string;
      removedLines: number;
      targetPath: string;
      workspaceFileId: string | null;
    }
  | {
      message: string;
      outcome: 'fallback_to_topic';
      reason:
        | 'workspace_disabled'
        | 'data_guard_blocked'
        | 'binary_or_disallowed_ext'
        | 'too_large'
        | 'revision_conflict'
        | 'protected_readonly_doc'
        | 'quota_exceeded';
    };

export interface ListHydratableProjectFilesParams {
  agentId: string;
  dataGuardProtected: boolean;
  serverDB: LobeChatDatabase;
  userId: string;
}

export interface ApplySandboxProjectFileSyncParams {
  agentId: string;
  baseRevision?: number | null;
  bytes: Uint8Array;
  dataGuardProtected: boolean;
  messageId?: string | null;
  path: string;
  serverDB: LobeChatDatabase;
  sha256: string;
  topicId: string;
  userId: string;
}

export interface ProjectWorkspaceSandboxBridge {
  applySandboxProjectFileSync: (
    params: ApplySandboxProjectFileSyncParams,
  ) => Promise<SandboxProjectSyncResult>;
  listHydratableProjectFiles: (
    params: ListHydratableProjectFilesParams,
  ) => Promise<HydratableProjectWorkspaceFile[]>;
}

const WORKSPACE_DISABLED_RESULT: SandboxProjectSyncResult = {
  message: 'Рабочее пространство проекта выключено',
  outcome: 'fallback_to_topic',
  reason: 'workspace_disabled',
};

let testOverride: Partial<ProjectWorkspaceSandboxBridge> | null = null;

export const setProjectWorkspaceBridgeForTests = (
  mock: Partial<ProjectWorkspaceSandboxBridge> | null,
): void => {
  testOverride = mock;
};

const isWorkspaceFeatureEnabled = (): boolean => {
  if (process.env.ARCKEP_WORKSPACE_ENABLED === '1') return true;
  if (
    process.env.ARCKEP_WORKSPACE_ENABLED === '0' ||
    process.env.ARCKEP_WORKSPACE_ENABLED === 'false'
  ) {
    return false;
  }
  return testOverride !== null;
};

const resolveProjectWorkspaceBridge =
  async (): Promise<Partial<ProjectWorkspaceSandboxBridge> | null> => {
    if (!isWorkspaceFeatureEnabled()) return null;

    if (testOverride) return testOverride;

    const globalBridge = (globalThis as Record<string, unknown>)
      .__arckepProjectWorkspaceSandboxBridge as Partial<ProjectWorkspaceSandboxBridge> | undefined;
    if (globalBridge && typeof globalBridge === 'object') {
      return globalBridge;
    }

    try {
      const rel = ['..', 'projectWorkspace', 'sandboxBridge'].join('/');
      const mod = (await import(
        /* webpackIgnore: true */ rel
      )) as Partial<ProjectWorkspaceSandboxBridge>;
      return mod;
    } catch (error) {
      log('projectWorkspace/sandboxBridge is not available, degrading gracefully: %O', error);
      return null;
    }
  };

export async function listHydratableProjectFiles(
  params: ListHydratableProjectFilesParams,
): Promise<HydratableProjectWorkspaceFile[]> {
  const bridge = await resolveProjectWorkspaceBridge();
  if (!bridge?.listHydratableProjectFiles) return [];

  try {
    return await bridge.listHydratableProjectFiles(params);
  } catch (error) {
    log('listHydratableProjectFiles failed, returning empty Zone 2 list: %O', error);
    return [];
  }
}

export async function applySandboxProjectFileSync(
  params: ApplySandboxProjectFileSyncParams,
): Promise<SandboxProjectSyncResult> {
  const bridge = await resolveProjectWorkspaceBridge();
  if (!bridge?.applySandboxProjectFileSync) {
    return WORKSPACE_DISABLED_RESULT;
  }

  return bridge.applySandboxProjectFileSync(params);
}
