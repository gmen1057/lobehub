/* eslint-disable unicorn/text-encoding-identifier-case */
import type { LobeChatDatabase } from '@lobechat/database';
import { idGenerator } from '@lobechat/database';
import { decodeSourceText, encodeSourceText } from '@lobechat/file-loaders';
import { and, eq, inArray, isNotNull, isNull, like, or, sql } from 'drizzle-orm';
import { sha256 } from 'js-sha256';

import {
  agentDocuments,
  agents,
  agentsFiles,
  agentsKnowledgeBases,
  documents,
  fileChunks,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  projectFileRevisions,
  projectWorkspaceFiles,
} from '@/database/schemas';
import { FileService } from '@/server/services/file';

import type { WorkspaceLoadMode } from './paths';
import { isAutoProtectedPath, normalizeWorkspacePath, resolveEffectiveProtection } from './paths';
import { countTextLines } from './proposals';
import {
  estimateWorkspaceTokens,
  extractWorkspaceBasenameAndExt,
  HARD_MAX_PINNED_CHARS,
  HARD_MAX_PINNED_TOKENS,
  isAllowedWorkspaceDocumentPath,
  isAllowedWorkspaceTextPath,
  isWorkspaceEnabled,
  MAX_WORKSPACE_DOCUMENT_BYTES,
  MAX_WORKSPACE_TEXT_BYTES,
  resolveCanonicalDocumentMimeType,
  resolveCanonicalTextMimeType,
} from './validator';

export type BackfillFileServiceLike = Pick<
  FileService,
  'deleteFile' | 'getFileByteArray' | 'uploadBuffer'
>;

export interface BackfillWorkspaceOptions {
  agentId?: string;
  dryRun?: boolean;
  fileServiceFactory?: (userId: string) => BackfillFileServiceLike;
  finalizeCutover?: boolean;
  userId?: string;
}

export interface BackfillWorkspaceSummary {
  agentDocumentsMigrated: number;
  agentsFilesMigrated: number;
  dryRun: boolean;
  finalizeCutover: boolean;
  knowledgeBaseFilesMigrated: number;
  knowledgeBasesClaimed: number;
  skippedReasons: string[];
  systemRolesMigrated: number;
}

const isNonSystemAgent = (agent: { slug: string | null; virtual: boolean | null }): boolean =>
  agent.virtual !== true && agent.slug !== 'inbox';

const stripControlChars = (value: string): string => {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f) continue;
    out += ch;
  }
  return out;
};

const sanitizeMigratedPathCandidate = (rawName: string, fallbackName: string): string => {
  const cleaned = stripControlChars(rawName.normalize('NFC'))
    .replaceAll('\\', '/')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/[<>:"|?*]/g, '_')
    .split('/')
    .map((seg) => seg.trim().replace(/\.+$/, ''))
    .filter((seg) => seg && seg !== '.' && seg !== '..' && seg.toLowerCase() !== '.git')
    .slice(0, 5)
    .map((seg) => (seg.length > 90 ? seg.slice(0, 90).trim() : seg))
    .join('/');

  try {
    return normalizeWorkspacePath(cleaned || fallbackName);
  } catch {
    return fallbackName;
  }
};

const pickUniqueWorkspacePath = (desiredPath: string, usedPathsLower: Set<string>): string => {
  if (!usedPathsLower.has(desiredPath.toLowerCase())) {
    usedPathsLower.add(desiredPath.toLowerCase());
    return desiredPath;
  }

  const slashIdx = desiredPath.lastIndexOf('/');
  const dirPrefix = slashIdx >= 0 ? `${desiredPath.slice(0, slashIdx + 1)}` : '';
  const basename = slashIdx >= 0 ? desiredPath.slice(slashIdx + 1) : desiredPath;
  const dotIdx = basename.lastIndexOf('.');
  const stem = dotIdx > 0 ? basename.slice(0, dotIdx) : basename;
  const ext = dotIdx > 0 ? basename.slice(dotIdx) : '';

  for (let counter = 2; counter <= 1000; counter++) {
    const candidate = `${dirPrefix}${stem} (${counter})${ext}`;
    if (!usedPathsLower.has(candidate.toLowerCase())) {
      try {
        const normalized = normalizeWorkspacePath(candidate);
        if (!usedPathsLower.has(normalized.toLowerCase())) {
          usedPathsLower.add(normalized.toLowerCase());
          return normalized;
        }
      } catch {
        // try next
      }
    }
  }

  const fallback = `${dirPrefix}${stem}-${Date.now()}${ext}`;
  usedPathsLower.add(fallback.toLowerCase());
  return fallback;
};

/**
 * Idempotent two-pass backfill migrating legacy `agents.system_role`, single-agent project KBs,
 * `agent_documents`, and `agents_files` into `project_workspace_files` (`M-2`, `M-6`, `R2-2`).
 */
export async function backfillProjectWorkspaces(
  db: LobeChatDatabase,
  opts: BackfillWorkspaceOptions = {},
): Promise<BackfillWorkspaceSummary> {
  const dryRun = Boolean(opts.dryRun);
  const finalizeCutover = opts.finalizeCutover ?? isWorkspaceEnabled();
  const serviceCache = new Map<string, BackfillFileServiceLike>();
  const getStorage = (userId: string): BackfillFileServiceLike => {
    let svc = serviceCache.get(userId);
    if (!svc) {
      svc = opts.fileServiceFactory ? opts.fileServiceFactory(userId) : new FileService(db, userId);
      serviceCache.set(userId, svc);
    }
    return svc;
  };

  const summary: BackfillWorkspaceSummary = {
    agentDocumentsMigrated: 0,
    agentsFilesMigrated: 0,
    dryRun,
    finalizeCutover,
    knowledgeBaseFilesMigrated: 0,
    knowledgeBasesClaimed: 0,
    skippedReasons: [],
    systemRolesMigrated: 0,
  };

  // Track used lower(path) and pinned budgets per agent across passes
  const agentUsedPaths = new Map<string, Set<string>>();
  const agentPinnedState = new Map<string, { chars: number; tokens: number }>();

  const loadAgentState = async (userId: string, agentId: string) => {
    if (agentUsedPaths.has(agentId) && agentPinnedState.has(agentId)) {
      return {
        pinned: agentPinnedState.get(agentId)!,
        usedPaths: agentUsedPaths.get(agentId)!,
      };
    }

    const existing = await db
      .select()
      .from(projectWorkspaceFiles)
      .where(
        and(eq(projectWorkspaceFiles.userId, userId), eq(projectWorkspaceFiles.agentId, agentId)),
      );

    const usedPaths = new Set<string>(existing.map((r) => r.path.toLowerCase()));
    let chars = 0;
    let tokens = 0;

    const pinnedDocIds = existing
      .filter((r) => r.deletedAt === null && r.loadMode === 'always' && r.currentDocumentId)
      .map((r) => r.currentDocumentId!) as string[];

    const docMap = new Map<string, string>();
    if (pinnedDocIds.length > 0) {
      const docs = await db
        .select({ content: documents.content, id: documents.id })
        .from(documents)
        .where(inArray(documents.id, pinnedDocIds));
      for (const d of docs) docMap.set(d.id, d.content ?? '');
    }

    for (const r of existing) {
      if (r.deletedAt === null && r.loadMode === 'always' && r.kind === 'text') {
        const content = r.currentDocumentId ? (docMap.get(r.currentDocumentId) ?? '') : '';
        chars += r.charCount ?? content.length;
        tokens += estimateWorkspaceTokens(content);
      }
    }

    agentUsedPaths.set(agentId, usedPaths);
    const pinned = { chars, tokens };
    agentPinnedState.set(agentId, pinned);
    return { pinned, usedPaths };
  };

  // =========================================================================
  // PASS 1: Non-system agents with non-empty `agents.system_role` -> AGENTS.md
  // =========================================================================
  const agentsWithRole = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      systemRole: agents.systemRole,
      title: agents.title,
      userId: agents.userId,
      virtual: agents.virtual,
    })
    .from(agents)
    .where(
      and(
        isNotNull(agents.systemRole),
        opts.userId ? eq(agents.userId, opts.userId) : undefined,
        opts.agentId ? eq(agents.id, opts.agentId) : undefined,
      ),
    );

  for (const agent of agentsWithRole) {
    if (!isNonSystemAgent(agent)) continue;
    const rawRole = agent.systemRole ?? '';
    if (rawRole.trim() === '') {
      if (finalizeCutover && !dryRun) {
        await db
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
      }
      continue;
    }

    const { pinned, usedPaths } = await loadAgentState(agent.userId, agent.id);

    if (usedPaths.has('agents.md')) {
      if (finalizeCutover && !dryRun) {
        await db
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
      }
      continue;
    }

    const encoded = encodeSourceText(rawRole, 'utf-8', 'LF');
    if (encoded.byteLength > MAX_WORKSPACE_TEXT_BYTES) {
      summary.skippedReasons.push(`agent:${agent.id}:system_role_exceeds_2mib`);
      continue;
    }

    const canonicalText = rawRole.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    const charCount = canonicalText.length;
    const lineCount = countTextLines(canonicalText);
    const estTokens = estimateWorkspaceTokens(canonicalText);
    const contentHash = sha256(encoded);

    if (charCount > HARD_MAX_PINNED_CHARS || estTokens > HARD_MAX_PINNED_TOKENS) {
      console.warn(
        `[backfillProjectWorkspaces] Agent ${agent.id} system_role (${charCount} chars, ${estTokens} tokens) exceeds soft/hard pinned budget; migrating without truncation`,
      );
    }

    if (dryRun) {
      usedPaths.add('agents.md');
      pinned.chars += charCount;
      pinned.tokens += estTokens;
      summary.systemRolesMigrated++;
      continue;
    }

    const wsFileId = crypto.randomUUID();
    const s3Key = `files/${agent.userId}/project-workspace/${agent.id}/${wsFileId}/r1-${contentHash.slice(0, 12)}.bin`;
    await getStorage(agent.userId).uploadBuffer(s3Key, Buffer.from(encoded), 'text/markdown', true);

    await db.transaction(async (tx) => {
      const [already] = await tx
        .select({ id: projectWorkspaceFiles.id })
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.agentId, agent.id),
            sql`lower(${projectWorkspaceFiles.path}) = 'agents.md'`,
          ),
        )
        .limit(1);

      if (already) {
        if (finalizeCutover) {
          await tx
            .update(agents)
            .set({ systemRole: null, updatedAt: new Date() })
            .where(eq(agents.id, agent.id));
        }
        return;
      }

      const fileId = idGenerator('files');
      const docId = idGenerator('documents', 16);

      await tx.insert(files).values({
        fileHash: null,
        fileType: 'text/markdown',
        id: fileId,
        metadata: {
          charCount,
          contentSha256: contentHash,
          encoding: 'utf-8',
          estimatedTokens: estTokens,
          lineCount,
          lineEnding: 'LF',
          workspacePath: 'AGENTS.md',
        },
        name: 'AGENTS.md',
        size: encoded.byteLength,
        url: s3Key,
        userId: agent.userId,
      });

      await tx.insert(documents).values({
        content: canonicalText,
        fileId,
        fileType: 'text/markdown',
        filename: 'AGENTS.md',
        id: docId,
        metadata: {
          encoding: 'utf-8',
          estimatedTokens: estTokens,
          lineEnding: 'LF',
          workspacePath: 'AGENTS.md',
        },
        source: s3Key,
        sourceType: 'file',
        title: 'AGENTS.md',
        totalCharCount: charCount,
        totalLineCount: lineCount,
        userId: agent.userId,
      });

      const [ins] = await tx
        .insert(projectWorkspaceFiles)
        .values({
          agentId: agent.id,
          byteSize: encoded.byteLength,
          charCount,
          contentSha256: contentHash,
          createdBy: 'migration',
          currentDocumentId: docId,
          currentFileId: fileId,
          currentRevision: 1,
          dataGuardStatus: 'unmasked',
          encoding: 'utf-8',
          id: wsFileId,
          isProtected: true,
          kind: 'text',
          lineCount,
          lineEnding: 'LF',
          loadMode: 'always',
          loadPriority: 0,
          mimeType: 'text/markdown',
          path: 'AGENTS.md',
          ragEnabled: false,
          updatedBy: 'migration',
          userId: agent.userId,
        })
        .onConflictDoNothing()
        .returning();

      if (ins) {
        await tx.insert(projectFileRevisions).values({
          agentId: agent.id,
          authorType: 'migration',
          byteSize: encoded.byteLength,
          changeNote: 'Migrated from agents.system_role',
          charCount,
          contentSha256: contentHash,
          diffStats: { addedLines: lineCount, removedLines: 0 },
          documentId: docId,
          encoding: 'utf-8',
          fileId,
          lineCount,
          lineEnding: 'LF',
          revision: 1,
          userId: agent.userId,
          workspaceFileId: ins.id,
        });
        summary.systemRolesMigrated++;
      }

      if (finalizeCutover) {
        await tx
          .update(agents)
          .set({ systemRole: null, updatedAt: new Date() })
          .where(eq(agents.id, agent.id));
      }
    });

    usedPaths.add('agents.md');
    pinned.chars += charCount;
    pinned.tokens += estTokens;
  }

  // =========================================================================
  // PASS 2: Single-agent Knowledge Bases named `Файлы проекта «%»` (M-2)
  // =========================================================================
  const candidateKbs = await db
    .select()
    .from(knowledgeBases)
    .where(
      and(
        or(
          like(knowledgeBases.name, 'Файлы проекта «%'),
          eq(knowledgeBases.type, 'project_workspace'),
        ),
        opts.userId ? eq(knowledgeBases.userId, opts.userId) : undefined,
      ),
    );

  for (const kb of candidateKbs) {
    const links = await db
      .select({
        agentId: agentsKnowledgeBases.agentId,
        slug: agents.slug,
        virtual: agents.virtual,
      })
      .from(agentsKnowledgeBases)
      .innerJoin(agents, eq(agents.id, agentsKnowledgeBases.agentId))
      .where(eq(agentsKnowledgeBases.knowledgeBaseId, kb.id));

    if (links.length !== 1) {
      summary.skippedReasons.push(`kb:${kb.id}:linked_to_${links.length}_agents`);
      continue;
    }

    const link = links[0]!;
    if (!isNonSystemAgent(link)) {
      summary.skippedReasons.push(`kb:${kb.id}:system_agent`);
      continue;
    }
    if (opts.agentId && link.agentId !== opts.agentId) continue;

    const targetAgentId = link.agentId;
    const { usedPaths } = await loadAgentState(kb.userId, targetAgentId);

    const existingSettings =
      kb.settings && typeof kb.settings === 'object'
        ? (kb.settings as Record<string, unknown>)
        : {};

    if (
      finalizeCutover &&
      (kb.type !== 'project_workspace' || existingSettings.managedByAgentId !== targetAgentId)
    ) {
      if (!dryRun) {
        await db
          .update(knowledgeBases)
          .set({
            settings: { ...existingSettings, managedByAgentId: targetAgentId },
            type: 'project_workspace',
            updatedAt: new Date(),
          })
          .where(eq(knowledgeBases.id, kb.id));
      }
      summary.knowledgeBasesClaimed++;
    }

    const kbFileEntries = await db
      .select({ file: files })
      .from(knowledgeBaseFiles)
      .innerJoin(files, eq(files.id, knowledgeBaseFiles.fileId))
      .where(eq(knowledgeBaseFiles.knowledgeBaseId, kb.id));

    for (const { file } of kbFileEntries) {
      const [alreadyImported] = await db
        .select({ id: projectWorkspaceFiles.id })
        .from(projectWorkspaceFiles)
        .where(
          and(
            eq(projectWorkspaceFiles.agentId, targetAgentId),
            eq(projectWorkspaceFiles.currentFileId, file.id),
          ),
        )
        .limit(1);

      if (alreadyImported) continue;

      const baseCandidate = sanitizeMigratedPathCandidate(file.name, 'document.pdf');
      const canBeText =
        isAllowedWorkspaceTextPath(baseCandidate) && file.size <= MAX_WORKSPACE_TEXT_BYTES;
      const canBeDoc =
        isAllowedWorkspaceDocumentPath(baseCandidate) && file.size <= MAX_WORKSPACE_DOCUMENT_BYTES;

      if (!canBeText && !canBeDoc) {
        summary.skippedReasons.push(`kb_file:${file.id}:unsupported_ext_or_size`);
        continue;
      }

      const uniquePath = pickUniqueWorkspacePath(baseCandidate, usedPaths);
      if (dryRun) {
        summary.knowledgeBaseFilesMigrated++;
        continue;
      }

      let kind: 'document' | 'text' = canBeText ? 'text' : 'document';
      let docId: string | null = null;
      let charCount: number | null = null;
      let lineCount: number | null = null;
      let encoding: string | null = null;
      let lineEnding: string | null = null;
      let contentHash =
        file.fileHash && /^[0-9a-f]{64}$/i.test(file.fileHash)
          ? file.fileHash.toLowerCase()
          : sha256(`${file.id}:${file.size}:${file.url}`);

      if (kind === 'text') {
        const [existingDoc] = await db
          .select()
          .from(documents)
          .where(and(eq(documents.fileId, file.id), eq(documents.userId, kb.userId)))
          .limit(1);

        if (existingDoc && typeof existingDoc.content === 'string') {
          docId = existingDoc.id;
          charCount = existingDoc.content.length;
          lineCount = countTextLines(existingDoc.content);
          encoding = 'utf-8';
          lineEnding = 'LF';
          contentHash = sha256(existingDoc.content);
        } else {
          try {
            const bytes = await getStorage(kb.userId).getFileByteArray(file.url);
            const decoded =
              bytes.byteLength === 0
                ? { encoding: 'utf-8' as const, lineEnding: 'LF' as const, text: '' }
                : decodeSourceText(bytes);
            contentHash = sha256(bytes);
            charCount = decoded.text.length;
            lineCount = countTextLines(decoded.text);
            encoding = decoded.encoding;
            lineEnding = decoded.lineEnding;
            docId = idGenerator('documents', 16);
            const { basename } = extractWorkspaceBasenameAndExt(uniquePath);

            await db.insert(documents).values({
              content: decoded.text,
              fileId: file.id,
              fileType: resolveCanonicalTextMimeType(uniquePath),
              filename: uniquePath,
              id: docId,
              metadata: {
                encoding,
                estimatedTokens: estimateWorkspaceTokens(decoded.text),
                lineEnding,
                workspacePath: uniquePath,
              },
              source: file.url,
              sourceType: 'file',
              title: basename,
              totalCharCount: charCount,
              totalLineCount: lineCount,
              userId: kb.userId,
            });
          } catch {
            if (!canBeDoc) {
              summary.skippedReasons.push(`kb_file:${file.id}:unreadable_text`);
              continue;
            }
            kind = 'document';
          }
        }
      }

      const mimeType =
        kind === 'text'
          ? resolveCanonicalTextMimeType(uniquePath)
          : file.fileType || resolveCanonicalDocumentMimeType(uniquePath);

      await db.transaction(async (tx) => {
        const [ins] = await tx
          .insert(projectWorkspaceFiles)
          .values({
            agentId: targetAgentId,
            byteSize: file.size,
            charCount,
            contentSha256: contentHash,
            createdBy: 'migration',
            currentDocumentId: docId,
            currentFileId: file.id,
            currentRevision: 1,
            dataGuardStatus: 'unmasked',
            encoding,
            isProtected: resolveEffectiveProtection(uniquePath, 'on_demand', false),
            kind,
            lineCount,
            lineEnding,
            loadMode: 'on_demand',
            loadPriority: 100,
            mimeType,
            path: uniquePath,
            ragEnabled: true,
            updatedBy: 'migration',
            userId: kb.userId,
          })
          .onConflictDoNothing()
          .returning();

        if (ins) {
          await tx.insert(projectFileRevisions).values({
            agentId: targetAgentId,
            authorType: 'migration',
            byteSize: file.size,
            changeNote: 'Migrated from project knowledge base',
            charCount,
            contentSha256: contentHash,
            diffStats: lineCount !== null ? { addedLines: lineCount, removedLines: 0 } : null,
            documentId: docId,
            encoding,
            fileId: file.id,
            lineCount,
            lineEnding,
            revision: 1,
            userId: kb.userId,
            workspaceFileId: ins.id,
          });
          summary.knowledgeBaseFilesMigrated++;
        }
      });
    }
  }

  // =========================================================================
  // PASS 3: Active `agent_documents` (`deleted_at IS NULL`) -> workspace text
  // =========================================================================
  const activeAgentDocs = await db
    .select({
      agent: { id: agents.id, slug: agents.slug, virtual: agents.virtual },
      agentDoc: agentDocuments,
      doc: documents,
    })
    .from(agentDocuments)
    .innerJoin(documents, eq(documents.id, agentDocuments.documentId))
    .innerJoin(agents, eq(agents.id, agentDocuments.agentId))
    .where(
      and(
        isNull(agentDocuments.deletedAt),
        opts.userId ? eq(agentDocuments.userId, opts.userId) : undefined,
        opts.agentId ? eq(agentDocuments.agentId, opts.agentId) : undefined,
      ),
    );

  for (const { agent, agentDoc, doc } of activeAgentDocs) {
    if (!isNonSystemAgent(agent)) continue;

    const [alreadyDoc] = await db
      .select({ id: projectWorkspaceFiles.id })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.agentId, agent.id),
          eq(projectWorkspaceFiles.currentDocumentId, doc.id),
        ),
      )
      .limit(1);
    if (alreadyDoc) continue;

    const content = doc.content ?? '';
    const encoded = encodeSourceText(content, 'utf-8', 'LF');
    if (encoded.byteLength > MAX_WORKSPACE_TEXT_BYTES) {
      summary.skippedReasons.push(`agent_doc:${agentDoc.id}:exceeds_2mib`);
      continue;
    }

    const { pinned, usedPaths } = await loadAgentState(agentDoc.userId, agent.id);
    const rawCandidate = doc.filename || (doc.title ? `${doc.title}.md` : 'document.md');
    let basePath = sanitizeMigratedPathCandidate(rawCandidate, 'document.md');
    if (!isAllowedWorkspaceTextPath(basePath)) {
      basePath = `${basePath}.md`;
    }
    const uniquePath = pickUniqueWorkspacePath(basePath, usedPaths);

    const charCount = content.length;
    const lineCount = countTextLines(content);
    const estTokens = estimateWorkspaceTokens(content);
    const contentHash = sha256(encoded);

    let loadMode: WorkspaceLoadMode = 'on_demand';
    if (agentDoc.policyLoad === 'disabled') {
      loadMode = 'disabled';
    } else if (agentDoc.policyLoad === 'always') {
      if (
        pinned.chars + charCount <= HARD_MAX_PINNED_CHARS &&
        pinned.tokens + estTokens <= HARD_MAX_PINNED_TOKENS
      ) {
        loadMode = 'always';
        pinned.chars += charCount;
        pinned.tokens += estTokens;
      } else {
        loadMode =
          isAutoProtectedPath(uniquePath) && uniquePath.toLowerCase() === 'agents.md'
            ? 'disabled'
            : 'on_demand';
      }
    }

    if (dryRun) {
      summary.agentDocumentsMigrated++;
      continue;
    }

    const wsFileId = crypto.randomUUID();
    const mimeType = resolveCanonicalTextMimeType(uniquePath);
    const s3Key = `files/${agentDoc.userId}/project-workspace/${agent.id}/${wsFileId}/r1-${contentHash.slice(0, 12)}.bin`;
    await getStorage(agentDoc.userId).uploadBuffer(s3Key, Buffer.from(encoded), mimeType, true);

    await db.transaction(async (tx) => {
      const fileId = idGenerator('files');
      const { basename } = extractWorkspaceBasenameAndExt(uniquePath);

      await tx.insert(files).values({
        fileHash: null,
        fileType: mimeType,
        id: fileId,
        metadata: {
          charCount,
          contentSha256: contentHash,
          encoding: 'utf-8',
          estimatedTokens: estTokens,
          lineCount,
          lineEnding: 'LF',
          workspacePath: uniquePath,
        },
        name: basename,
        size: encoded.byteLength,
        url: s3Key,
        userId: agentDoc.userId,
      });

      const [ins] = await tx
        .insert(projectWorkspaceFiles)
        .values({
          agentId: agent.id,
          byteSize: encoded.byteLength,
          charCount,
          contentSha256: contentHash,
          createdBy: 'migration',
          currentDocumentId: doc.id,
          currentFileId: fileId,
          currentRevision: 1,
          dataGuardStatus: 'unmasked',
          encoding: 'utf-8',
          id: wsFileId,
          isProtected: resolveEffectiveProtection(uniquePath, loadMode, false),
          kind: 'text',
          lineCount,
          lineEnding: 'LF',
          loadMode,
          loadPriority: loadMode === 'always' ? 50 : 100,
          mimeType,
          path: uniquePath,
          ragEnabled: false,
          updatedBy: 'migration',
          userId: agentDoc.userId,
        })
        .onConflictDoNothing()
        .returning();

      if (ins) {
        await tx.insert(projectFileRevisions).values({
          agentId: agent.id,
          authorType: 'migration',
          byteSize: encoded.byteLength,
          changeNote: 'Migrated from agent_documents',
          charCount,
          contentSha256: contentHash,
          diffStats: { addedLines: lineCount, removedLines: 0 },
          documentId: doc.id,
          encoding: 'utf-8',
          fileId,
          lineCount,
          lineEnding: 'LF',
          revision: 1,
          userId: agentDoc.userId,
          workspaceFileId: ins.id,
        });
        summary.agentDocumentsMigrated++;
      }
    });
  }

  // =========================================================================
  // PASS 4: Active `agents_files` (`enabled = true`) -> workspace + disable
  // =========================================================================
  const activeAgentFiles = await db
    .select({
      af: agentsFiles,
      agent: { id: agents.id, slug: agents.slug, title: agents.title, virtual: agents.virtual },
      file: files,
    })
    .from(agentsFiles)
    .innerJoin(files, eq(files.id, agentsFiles.fileId))
    .innerJoin(agents, eq(agents.id, agentsFiles.agentId))
    .where(
      and(
        eq(agentsFiles.enabled, true),
        opts.userId ? eq(agentsFiles.userId, opts.userId) : undefined,
        opts.agentId ? eq(agentsFiles.agentId, opts.agentId) : undefined,
      ),
    );

  for (const { af, agent, file } of activeAgentFiles) {
    if (!isNonSystemAgent(agent)) continue;

    const [alreadyImported] = await db
      .select({ id: projectWorkspaceFiles.id, ragEnabled: projectWorkspaceFiles.ragEnabled })
      .from(projectWorkspaceFiles)
      .where(
        and(
          eq(projectWorkspaceFiles.agentId, agent.id),
          eq(projectWorkspaceFiles.currentFileId, file.id),
        ),
      )
      .limit(1);

    if (alreadyImported) {
      if (finalizeCutover && !dryRun) {
        await db.transaction(async (tx) => {
          if (alreadyImported.ragEnabled) {
            const [existingManagedKb] = await tx
              .select({ id: knowledgeBases.id })
              .from(knowledgeBases)
              .where(
                and(
                  eq(knowledgeBases.userId, af.userId),
                  eq(knowledgeBases.type, 'project_workspace'),
                  sql`${knowledgeBases.settings}->>'managedByAgentId' = ${agent.id}`,
                ),
              )
              .limit(1);

            const kbId = existingManagedKb?.id ?? idGenerator('knowledgeBases');
            if (!existingManagedKb) {
              await tx.insert(knowledgeBases).values({
                id: kbId,
                name: `Файлы проекта «${agent.title?.trim() || 'Проект'}»`,
                settings: { managedByAgentId: agent.id },
                type: 'project_workspace',
                userId: af.userId,
              });
            }

            await tx
              .insert(agentsKnowledgeBases)
              .values({
                agentId: agent.id,
                enabled: true,
                knowledgeBaseId: kbId,
                userId: af.userId,
              })
              .onConflictDoNothing();

            await tx
              .insert(knowledgeBaseFiles)
              .values({
                fileId: file.id,
                knowledgeBaseId: kbId,
                userId: af.userId,
              })
              .onConflictDoNothing();
          }

          await tx
            .update(agentsFiles)
            .set({ enabled: false, updatedAt: new Date() })
            .where(
              and(
                eq(agentsFiles.agentId, af.agentId),
                eq(agentsFiles.fileId, af.fileId),
                eq(agentsFiles.userId, af.userId),
              ),
            );
        });
      }
      continue;
    }

    const baseCandidate = sanitizeMigratedPathCandidate(file.name, 'attachment.txt');
    const canBeText =
      isAllowedWorkspaceTextPath(baseCandidate) && file.size <= MAX_WORKSPACE_TEXT_BYTES;
    const canBeDoc =
      isAllowedWorkspaceDocumentPath(baseCandidate) && file.size <= MAX_WORKSPACE_DOCUMENT_BYTES;

    if (!canBeText && !canBeDoc) {
      summary.skippedReasons.push(`agents_file:${file.id}:unsupported_ext_or_size`);
      continue;
    }

    const { usedPaths } = await loadAgentState(af.userId, agent.id);
    const uniquePath = pickUniqueWorkspacePath(baseCandidate, usedPaths);

    if (dryRun) {
      summary.agentsFilesMigrated++;
      continue;
    }

    let kind: 'document' | 'text' = canBeText ? 'text' : 'document';
    let docId: string | null = null;
    let charCount: number | null = null;
    let lineCount: number | null = null;
    let encoding: string | null = null;
    let lineEnding: string | null = null;
    let contentHash =
      file.fileHash && /^[0-9a-f]{64}$/i.test(file.fileHash)
        ? file.fileHash.toLowerCase()
        : sha256(`${file.id}:${file.size}:${file.url}`);

    if (kind === 'text') {
      const [existingDoc] = await db
        .select()
        .from(documents)
        .where(and(eq(documents.fileId, file.id), eq(documents.userId, af.userId)))
        .limit(1);

      if (existingDoc && typeof existingDoc.content === 'string') {
        docId = existingDoc.id;
        charCount = existingDoc.content.length;
        lineCount = countTextLines(existingDoc.content);
        encoding = 'utf-8';
        lineEnding = 'LF';
        contentHash = sha256(existingDoc.content);
      } else {
        try {
          const bytes = await getStorage(af.userId).getFileByteArray(file.url);
          const decoded =
            bytes.byteLength === 0
              ? { encoding: 'utf-8' as const, lineEnding: 'LF' as const, text: '' }
              : decodeSourceText(bytes);
          contentHash = sha256(bytes);
          charCount = decoded.text.length;
          lineCount = countTextLines(decoded.text);
          encoding = decoded.encoding;
          lineEnding = decoded.lineEnding;
          docId = idGenerator('documents', 16);
          const { basename } = extractWorkspaceBasenameAndExt(uniquePath);

          await db.insert(documents).values({
            content: decoded.text,
            fileId: file.id,
            fileType: resolveCanonicalTextMimeType(uniquePath),
            filename: uniquePath,
            id: docId,
            metadata: {
              encoding,
              estimatedTokens: estimateWorkspaceTokens(decoded.text),
              lineEnding,
              workspacePath: uniquePath,
            },
            source: file.url,
            sourceType: 'file',
            title: basename,
            totalCharCount: charCount,
            totalLineCount: lineCount,
            userId: af.userId,
          });
        } catch {
          if (!canBeDoc) {
            summary.skippedReasons.push(`agents_file:${file.id}:unreadable_text`);
            continue;
          }
          kind = 'document';
        }
      }
    }

    const [hasChunk] = await db
      .select({ chunkId: fileChunks.chunkId })
      .from(fileChunks)
      .where(eq(fileChunks.fileId, file.id))
      .limit(1);
    const ragEnabled = Boolean(hasChunk);

    const mimeType =
      kind === 'text'
        ? resolveCanonicalTextMimeType(uniquePath)
        : file.fileType || resolveCanonicalDocumentMimeType(uniquePath);

    await db.transaction(async (tx) => {
      const [ins] = await tx
        .insert(projectWorkspaceFiles)
        .values({
          agentId: agent.id,
          byteSize: file.size,
          charCount,
          contentSha256: contentHash,
          createdBy: 'migration',
          currentDocumentId: docId,
          currentFileId: file.id,
          currentRevision: 1,
          dataGuardStatus: 'unmasked',
          encoding,
          isProtected: resolveEffectiveProtection(uniquePath, 'on_demand', false),
          kind,
          lineCount,
          lineEnding,
          loadMode: 'on_demand',
          loadPriority: 100,
          mimeType,
          path: uniquePath,
          ragEnabled,
          updatedBy: 'migration',
          userId: af.userId,
        })
        .onConflictDoNothing()
        .returning();

      if (ins) {
        await tx.insert(projectFileRevisions).values({
          agentId: agent.id,
          authorType: 'migration',
          byteSize: file.size,
          changeNote: 'Migrated from agents_files',
          charCount,
          contentSha256: contentHash,
          diffStats: lineCount !== null ? { addedLines: lineCount, removedLines: 0 } : null,
          documentId: docId,
          encoding,
          fileId: file.id,
          lineCount,
          lineEnding,
          revision: 1,
          userId: af.userId,
          workspaceFileId: ins.id,
        });

        if (ragEnabled && finalizeCutover) {
          const [existingManagedKb] = await tx
            .select({ id: knowledgeBases.id })
            .from(knowledgeBases)
            .where(
              and(
                eq(knowledgeBases.userId, af.userId),
                eq(knowledgeBases.type, 'project_workspace'),
                sql`${knowledgeBases.settings}->>'managedByAgentId' = ${agent.id}`,
              ),
            )
            .limit(1);

          const kbId = existingManagedKb?.id ?? idGenerator('knowledgeBases');
          if (!existingManagedKb) {
            await tx.insert(knowledgeBases).values({
              id: kbId,
              name: `Файлы проекта «${agent.title?.trim() || 'Проект'}»`,
              settings: { managedByAgentId: agent.id },
              type: 'project_workspace',
              userId: af.userId,
            });
          }

          await tx
            .insert(agentsKnowledgeBases)
            .values({
              agentId: agent.id,
              enabled: true,
              knowledgeBaseId: kbId,
              userId: af.userId,
            })
            .onConflictDoNothing();

          await tx
            .insert(knowledgeBaseFiles)
            .values({
              fileId: file.id,
              knowledgeBaseId: kbId,
              userId: af.userId,
            })
            .onConflictDoNothing();
        }

        summary.agentsFilesMigrated++;
      }

      if (finalizeCutover) {
        await tx
          .update(agentsFiles)
          .set({ enabled: false, updatedAt: new Date() })
          .where(
            and(
              eq(agentsFiles.agentId, af.agentId),
              eq(agentsFiles.fileId, af.fileId),
              eq(agentsFiles.userId, af.userId),
            ),
          );
      }
    });
  }

  return summary;
}
