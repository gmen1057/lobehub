// @vitest-environment node
/* eslint-disable unicorn/text-encoding-identifier-case */
import type { LobeChatDatabase } from '@lobechat/database';
import { idGenerator } from '@lobechat/database';
import {
  agentDocuments,
  agents,
  agentsFiles,
  agentsKnowledgeBases,
  chunks,
  documents,
  embeddings,
  fileChunks,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  messages,
  messagesFiles,
  topics,
  users,
} from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { encodeSourceText } from '@lobechat/file-loaders';
import { eq } from 'drizzle-orm';
import { sha256 } from 'js-sha256';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applySandboxProjectFileSync,
  backfillProjectWorkspaces,
  cleanupAgentWorkspaceBeforeDelete,
  CODE_EXTENSIONS,
  estimateWorkspaceTokens,
  findWorkspaceFileReferences,
  formatWorkspaceIndexBlock,
  HARD_MAX_PINNED_CHARS,
  HARD_MAX_PINNED_TOKENS,
  hasEverHadAgentsMd,
  listHydratableProjectFiles,
  MAX_WORKSPACE_INDEX_CHARS,
  MAX_WORKSPACE_TEXT_BYTES,
  normalizeWorkspacePath,
  ProjectWorkspaceStore,
  resolveAgentSystemRoleFromWorkspace,
  resolveTopicWorkspaceSnapshot,
  sanitizeUserSummary,
  validateWorkspaceLoadMode,
  validateWorkspaceTextBuffer,
  WorkspaceError,
  type WorkspaceStorageAdapter,
} from '../index';

class InMemoryStorageAdapter implements WorkspaceStorageAdapter {
  public readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  public getBytesCalls = 0;

  uploadBuffer = vi.fn(
    async (key: string, buffer: Buffer, contentType: string): Promise<{ key: string }> => {
      this.objects.set(key, { bytes: new Uint8Array(buffer), contentType });
      return { key };
    },
  );

  deleteFile = vi.fn(async (key: string) => {
    this.objects.delete(key);
  });

  deleteFiles = vi.fn(async (keys: string[]) => {
    for (const key of keys) {
      this.objects.delete(key);
    }
  });

  getFileByteArray = vi.fn(async (key: string): Promise<Uint8Array> => {
    this.getBytesCalls++;
    const found = this.objects.get(key);
    if (!found) {
      const err: any = new Error(`NoSuchKey: ${key}`);
      err.Code = 'NoSuchKey';
      throw err;
    }
    return found.bytes;
  });

  createPreSignedUrlForPreview = vi.fn(
    async (
      key: string,
      _expiresIn?: number,
      options?: { responseContentDisposition?: string },
    ): Promise<string> => {
      const disp = options?.responseContentDisposition
        ? `?disposition=${encodeURIComponent(options.responseContentDisposition)}`
        : '';
      return `https://s3.mock.local/${key}${disp}`;
    },
  );
}

describe('ProjectWorkspace core (1A-2)', () => {
  let db: LobeChatDatabase;
  let storage: InMemoryStorageAdapter;
  let userId: string;
  let agentId: string;
  const prevEnv = process.env.ARCKEP_WORKSPACE_ENABLED;

  beforeEach(async () => {
    process.env.ARCKEP_WORKSPACE_ENABLED = '1';
    db = await getTestDB();
    await db.delete(users);
    storage = new InMemoryStorageAdapter();
    userId = `usr_ws_${Date.now()}`;
    agentId = `agt_ws_${Date.now()}`;

    await db.insert(users).values({ id: userId });
    await db.insert(agents).values({
      id: agentId,
      slug: 'my-project',
      systemRole: 'Legacy role to be cleared',
      title: 'Финансовый аналитик',
      userId,
      virtual: false,
    });
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.ARCKEP_WORKSPACE_ENABLED;
    } else {
      process.env.ARCKEP_WORKSPACE_ENABLED = prevEnv;
    }
  });

  describe('1. paths.ts & validator.ts pure invariants', () => {
    it('computes estimateWorkspaceTokens deterministically across ASCII, Cyrillic/№, and CJK/Emoji', () => {
      expect(estimateWorkspaceTokens('')).toBe(0);
      expect(estimateWorkspaceTokens('abcd')).toBe(1); // 4 * 0.25 = 1
      expect(estimateWorkspaceTokens('abcde')).toBe(2); // ceil(1.25) = 2
      expect(estimateWorkspaceTokens('Привет№—')).toBe(Math.ceil(8 * 0.45)); // 8 * 0.45 = 3.6 -> 4
      expect(estimateWorkspaceTokens('你好🚀')).toBe(3); // 3 code points >= 0x800 -> 3 * 1.0 = 3
    });

    it('normalizes NFC paths and rejects all dangerous path patterns', () => {
      // NFD "и\u0306" -> NFC "й"
      const nfd = 'src/фа\u0438\u0306л.py';
      expect(normalizeWorkspacePath(nfd)).toBe('src/файл.py');
      expect(normalizeWorkspacePath('Dockerfile')).toBe('Dockerfile');
      expect(normalizeWorkspacePath('a/b/c/d/e.ts')).toBe('a/b/c/d/e.ts');

      const badPaths = [
        '',
        '/abs/path.ts',
        'trailing/slash/',
        'win\\path.ts',
        'double//slash.ts',
        './rel.ts',
        'src/../escape.ts',
        'null\u0000byte.ts',
        'del\u007Fchar.ts',
        'zwsp\u200Bfile.ts',
        'bidi\u202Egpj.py',
        'bom\uFEFFname.md',
        ' leading.md',
        'trailing.md ',
        'dir /nested.md',
        'AGENTS.md.',
        '.git/config',
        'src/.GIT/hooks',
        'CON',
        'con.txt',
        'Aux.py',
        'COM1.json',
        'lpt9.log',
        'a/b/c/d/e/too_deep.ts',
        `${'a'.repeat(101)}.ts`,
        `src/${'b'.repeat(200)}.ts`,
        'bad<char>.md',
        'bad:name.md',
        'bad|pipe.md',
      ];

      for (const bad of badPaths) {
        expect(() => normalizeWorkspacePath(bad)).toThrowError(WorkspaceError);
      }

      expect(() => validateWorkspaceLoadMode('AGENTS.md', 'on_demand')).toThrowError(
        /cannot use on_demand/,
      );
      expect(() => validateWorkspaceLoadMode('agents.md', 'always')).not.toThrow();
      expect(() => validateWorkspaceLoadMode('agents.md', 'disabled')).not.toThrow();

      expect(sanitizeUserSummary('  <script>"hello"\n\u200Bworld</script>  ')).toBe(
        'script hello world /script',
      );
      expect(() => sanitizeUserSummary('x'.repeat(121))).toThrowError(WorkspaceError);
    });

    it('enforces the 36+11+2 text extension whitelist, blocks dangerous extensions, 22 magic signatures, RIFF, PE, BOM-prefixed binaries, and EICAR', () => {
      expect(CODE_EXTENSIONS).toHaveLength(36);
      const okBytes = new TextEncoder().encode('print("ok")\n');
      expect(validateWorkspaceTextBuffer(okBytes, 'src/main.py')).toBe('src/main.py');
      expect(validateWorkspaceTextBuffer(okBytes, 'Dockerfile')).toBe('Dockerfile');
      expect(validateWorkspaceTextBuffer(okBytes, 'Makefile')).toBe('Makefile');
      expect(validateWorkspaceTextBuffer(okBytes, 'schema.prisma')).toBe('schema.prisma');

      const forbiddenExts = [
        'index.html',
        'page.htm',
        'icon.svg',
        'run.bat',
        'run.cmd',
        'app.exe',
        'lib.dll',
        'setup.msi',
        'dos.com',
        'saver.scr',
        'macro.vbs',
        'app.jar',
        'data.db',
        'local.sqlite',
      ];
      for (const p of forbiddenExts) {
        expect(() => validateWorkspaceTextBuffer(okBytes, p)).toThrowError(
          expect.objectContaining({ code: 'UNSUPPORTED_TEXT_EXTENSION', httpStatus: 415 }),
        );
      }

      // Control byte 0x7F
      expect(() =>
        validateWorkspaceTextBuffer(new Uint8Array([0x61, 0x7f, 0x62]), 'notes.txt'),
      ).toThrowError(expect.objectContaining({ code: 'BINARY_CONTENT', httpStatus: 415 }));

      // 22 binary magic signatures (both direct and prefixed by UTF-8 BOM)
      const signatures: Uint8Array[] = [
        new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x30]),
        new Uint8Array([0xfe, 0xed, 0xfa, 0xce]),
        new Uint8Array([0xfe, 0xed, 0xfa, 0xcf]),
        new Uint8Array([0xce, 0xfa, 0xed, 0xfe]),
        new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]),
        new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
        new Uint8Array([0xbe, 0xba, 0xfe, 0xca]),
        new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
        new Uint8Array([0x50, 0x4b, 0x05, 0x06]),
        new Uint8Array([0x50, 0x4b, 0x07, 0x08]),
        new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        new TextEncoder().encode('%PDF-1.7 fake text'),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
        new TextEncoder().encode('GIF87a...'),
        new TextEncoder().encode('GIF89a...'),
        new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]),
        new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),
        new Uint8Array([0x1f, 0x8b, 0x08]),
        new Uint8Array([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
        new TextEncoder().encode('BZh91AY&SY'),
        new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
      ];

      expect(signatures).toHaveLength(22);
      for (const sig of signatures) {
        expect(() => validateWorkspaceTextBuffer(sig, 'data.txt')).toThrowError(
          expect.objectContaining({ code: 'BINARY_CONTENT', httpStatus: 415 }),
        );
        const withBom = new Uint8Array(3 + sig.length);
        withBom.set([0xef, 0xbb, 0xbf], 0);
        withBom.set(sig, 3);
        expect(() => validateWorkspaceTextBuffer(withBom, 'data.txt')).toThrowError(
          expect.objectContaining({ code: 'BINARY_CONTENT', httpStatus: 415 }),
        );
      }

      // RIFF WEBP & PE DOS stub (ASCII-clean without NULs)
      const riffWebp = new TextEncoder().encode('RIFF1234WEBPpayload');
      expect(() => validateWorkspaceTextBuffer(riffWebp, 'note.txt')).toThrowError(
        expect.objectContaining({ code: 'BINARY_CONTENT', httpStatus: 415 }),
      );

      const mzDos = new TextEncoder().encode(
        'MZ......................This program cannot be run in DOS mode.',
      );
      expect(() => validateWorkspaceTextBuffer(mzDos, 'note.txt')).toThrowError(
        expect.objectContaining({ code: 'BINARY_CONTENT', httpStatus: 415 }),
      );

      // EICAR split literal
      const eicar = new TextEncoder().encode(
        `prefix\n${'X5O!P%@AP[4\\PZX54(P^)7CC)7}$'}${'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'}\nsuffix`,
      );
      expect(() => validateWorkspaceTextBuffer(eicar, 'test.txt')).toThrowError(
        expect.objectContaining({ code: 'MALWARE_SIGNATURE', httpStatus: 415 }),
      );

      // > 2 MiB
      const huge = new Uint8Array(MAX_WORKSPACE_TEXT_BYTES + 1).fill(0x61);
      expect(() => validateWorkspaceTextBuffer(huge, 'big.txt')).toThrowError(
        expect.objectContaining({ code: 'FILE_TOO_LARGE', httpStatus: 413 }),
      );
    });
  });

  describe('2. ProjectWorkspaceStore revisions, 60K/24K budget, resurrection, CP1251, proposals, RAG chunks & B-1 cleanup', () => {
    it('manages AGENTS.md lifecycle, clears agents.system_role, prevents zombie fallback, and forbids inbox AGENTS.md', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // Before AGENTS.md exists, fallbackDbSystemRole is used
      const before = await resolveAgentSystemRoleFromWorkspace(
        db,
        userId,
        agentId,
        'Legacy role to be cleared',
      );
      expect(before.hasEverHadAgentsMd).toBe(false);
      expect(before.systemRole).toBe('Legacy role to be cleared');

      // Saving AGENTS.md clears agents.system_role = NULL
      const saved = await store.putUserTextFile(agentId, {
        content: '# Правила проекта\nОтвечай кратко.',
        path: 'AGENTS.md',
      });
      expect(saved.deleted).toBe(false);
      expect(saved.file?.currentRevision).toBe(1);
      expect(saved.file?.loadMode).toBe('always');
      expect(saved.file?.isProtected).toBe(true);

      const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agentRow?.systemRole).toBeNull();

      const activeRole = await resolveAgentSystemRoleFromWorkspace(
        db,
        userId,
        agentId,
        'Zombie role',
      );
      expect(activeRole.hasEverHadAgentsMd).toBe(true);
      expect(activeRole.systemRole).toBe('# Правила проекта\nОтвечай кратко.');

      // Clearing AGENTS.md via whitespace content soft-deletes it and NEVER resurrects zombie fallback
      const cleared = await store.putUserTextFile(agentId, {
        baseRevision: 1,
        content: '   \n  ',
        path: 'AGENTS.md',
      });
      expect(cleared.deleted).toBe(true);
      expect(cleared.file).toBeNull();

      expect(await hasEverHadAgentsMd(db, userId, agentId)).toBe(true);
      const afterDelete = await resolveAgentSystemRoleFromWorkspace(
        db,
        userId,
        agentId,
        'Zombie role',
      );
      expect(afterDelete.hasEverHadAgentsMd).toBe(true);
      expect(afterDelete.systemRole).toBeNull();

      // Idempotent second clear when already deleted
      const clearedAgain = await store.putUserTextFile(agentId, {
        content: '',
        path: 'AGENTS.md',
      });
      expect(clearedAgain.deleted).toBe(false);
      expect(clearedAgain.file).toBeNull();

      // Resurrecting AGENTS.md continues revision numbering at v2!
      const resurrected = await store.putUserTextFile(agentId, {
        content: '# Новая инструкция v2',
        path: 'AGENTS.md',
      });
      expect(resurrected.file?.id).toBe(saved.file?.id);
      expect(resurrected.file?.currentRevision).toBe(2);

      // Inbox agent rejects AGENTS.md
      const inboxId = `agt_inbox_${Date.now()}`;
      await db.insert(agents).values({
        id: inboxId,
        slug: 'inbox',
        title: 'Inbox',
        userId,
        virtual: true,
      });
      await expect(
        store.putUserTextFile(inboxId, { content: 'Forbidden', path: 'AGENTS.md' }),
      ).rejects.toMatchObject({ code: 'INBOX_INSTRUCTION_FORBIDDEN', httpStatus: 422 });
    });

    it('enforces 60K chars / 24K tokens pinned ceiling (422) and baseRevision conflicts (409) with S3 orphan cleanup', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // Exceed 60_000 chars on pinned file -> 422 + S3 cleaned up
      const s3CountBefore = storage.objects.size;
      await expect(
        store.putUserTextFile(agentId, {
          content: 'a'.repeat(HARD_MAX_PINNED_CHARS + 10),
          loadMode: 'always',
          path: 'rules/huge.md',
        }),
      ).rejects.toMatchObject({ code: 'PINNED_BUDGET_EXCEEDED', httpStatus: 422 });
      expect(storage.objects.size).toBe(s3CountBefore);

      //Exceed 24_000 tokens via CJK chars (25_000 chars < 60_000 chars, but 25_000 tokens > 24_000!)
      await expect(
        store.putUserTextFile(agentId, {
          content: '中'.repeat(HARD_MAX_PINNED_TOKENS + 100),
          loadMode: 'always',
          path: 'rules/cjk.md',
        }),
      ).rejects.toMatchObject({ code: 'PINNED_BUDGET_EXCEEDED', httpStatus: 422 });
      expect(storage.objects.size).toBe(s3CountBefore);

      // Create valid file v1
      const v1 = await store.putUserTextFile(agentId, {
        content: 'def add(a, b):\n    return a + b\n',
        path: 'src/calc.py',
      });
      expect(v1.file?.currentRevision).toBe(1);

      // Duplicate create (baseRevision = 0) -> 409 FILE_ALREADY_EXISTS
      await expect(
        store.putUserTextFile(agentId, {
          baseRevision: 0,
          content: 'overwrite',
          path: 'SRC/CALC.PY',
        }),
      ).rejects.toMatchObject({
        code: 'FILE_ALREADY_EXISTS',
        details: expect.objectContaining({ currentRevision: 1 }),
        httpStatus: 409,
      });

      // Stale baseRevision -> 409 REVISION_CONFLICT
      await expect(
        store.putUserTextFile(agentId, {
          baseRevision: 99,
          content: 'stale',
          path: 'src/calc.py',
        }),
      ).rejects.toMatchObject({
        code: 'REVISION_CONFLICT',
        details: expect.objectContaining({ currentRevision: 1 }),
        httpStatus: 409,
      });
    });

    it('preserves Windows-1251 + CRLF across write, readProjectFilePage, and patchAgentTextFile', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      const created = await store.putUserTextFile(agentId, {
        content: 'Процедура Тест()\n    Сообщить("Привет №1");\nКонецПроцедуры\n',
        encoding: 'windows-1251',
        lineEnding: 'CRLF',
        path: '1c/Module.bsl',
      });
      expect(created.file?.encoding).toBe('windows-1251');
      expect(created.file?.lineEnding).toBe('CRLF');

      const patched = await store.patchAgentTextFile(agentId, {
        baseRevision: 1,
        edits: [{ newText: '    Сообщить("Привет №2");', oldText: '    Сообщить("Привет №1");' }],
        path: '1c/Module.bsl',
      });
      expect(patched.outcome).toBe('updated');
      if (patched.outcome === 'updated') {
        expect(patched.file.currentRevision).toBe(2);
        expect(patched.file.encoding).toBe('windows-1251');
        expect(patched.file.lineEnding).toBe('CRLF');
      }

      const pageRes = await store.readProjectFilePage(agentId, {
        path: '1c/Module.bsl',
        startLine: 1,
      });
      expect(pageRes.wrappedContent).toContain(
        '<project_file path="1c/Module.bsl" revision="2" encoding="windows-1251" trust="untrusted_workspace_data">',
      );
      expect(pageRes.wrappedContent).toContain('Привет №2');

      // Emoji in CP1251 patch must fail cleanly with 422 INVALID_ENCODING
      await expect(
        store.patchAgentTextFile(agentId, {
          baseRevision: 2,
          edits: [{ newText: '    Сообщить("🚀");', oldText: '    Сообщить("Привет №2");' }],
          path: '1c/Module.bsl',
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ENCODING', httpStatus: 422 });
    });

    it('routes agent edits/deletes on protected files into proposals, supports idempotent apply/reject, rollback, and >30 revision pruning', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // Agent tries to create AGENTS.md -> proposal_created ('create_pinned')
      const propCreate = await store.writeAgentTextFile(agentId, {
        content: '# Agent proposed rules\nRule 1\n',
        path: 'AGENTS.md',
        reason: 'Initial project conventions',
      });
      expect(propCreate.outcome).toBe('proposal_created');
      if (propCreate.outcome !== 'proposal_created') throw new Error('expected proposal');
      expect(propCreate.proposal.proposalType).toBe('create_pinned');

      // Apply proposal (first call applies, second call is idempotent!)
      const applied1 = await store.applyProposal(agentId, propCreate.proposal.id);
      expect(applied1.alreadyApplied).toBe(false);
      expect(applied1.file?.currentRevision).toBe(1);

      const applied2 = await store.applyProposal(agentId, propCreate.proposal.id);
      expect(applied2.alreadyApplied).toBe(true);
      expect(applied2.file?.currentRevision).toBe(1);

      // Agent patches protected AGENTS.md -> proposal_created ('edit')
      const propEdit = await store.patchAgentTextFile(agentId, {
        edits: [{ newText: 'Rule 1\nRule 2', oldText: 'Rule 1' }],
        path: 'AGENTS.md',
        reason: 'Add Rule 2',
      });
      expect(propEdit.outcome).toBe('proposal_created');
      if (propEdit.outcome !== 'proposal_created') throw new Error('expected proposal');

      // Reject proposal idempotently
      const rej1 = await store.rejectProposal(agentId, propEdit.proposal.id);
      expect(rej1.proposal.status).toBe('rejected');
      const rej2 = await store.rejectProposal(agentId, propEdit.proposal.id);
      expect(rej2.proposal.status).toBe('rejected');

      // Unprotected file: write 33 revisions to verify >30 rotation preserves v1!
      let rev = 0;
      let wsId = '';
      for (let i = 1; i <= 33; i++) {
        const res = await store.putUserTextFile(agentId, {
          baseRevision: rev === 0 ? null : rev,
          content: `line ${i}\n`,
          path: 'src/counter.ts',
        });
        rev = res.file!.currentRevision;
        wsId = res.file!.id;
      }

      const { revisions } = await store.listRevisions(agentId, wsId);
      expect(revisions.length).toBe(30);
      expect(revisions.some((r) => r.revision === 1)).toBe(true);
      expect(revisions[0]?.revision).toBe(33);

      const diff = await store.diffRevisions(agentId, wsId, 1, 33);
      expect(diff.addedLines).toBe(1);
      expect(diff.removedLines).toBe(1);
      expect(diff.patch).toContain('-line 1');
      expect(diff.patch).toContain('+line 33');

      // Soft-delete src/counter.ts and resurrect via rollback to v1!
      const delRes = await store.deleteWorkspaceFile(
        agentId,
        { workspaceFileId: wsId },
        { actor: 'user', baseRevision: 33 },
      );
      expect(delRes.outcome).toBe('deleted');

      const rolledBack = await store.rollbackFileRevision(agentId, wsId, {
        baseRevision: 33,
        targetRevision: 1,
      });
      expect(rolledBack.file.currentRevision).toBe(34);
      expect(rolledBack.file.updatedBy).toBe('rollback');

      const detail = await store.getFileDetail(agentId, wsId);
      expect(detail.content).toBe('line 1\n');
      expect(detail.downloadUrl).toContain('attachment');
    });

    it('cleans up RAG chunks on revision change/delete (B-2), runs searchProjectFiles with 0 S3 GETs (H-4), and cleans workspace on agent delete (B-1)', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);

      // Upload a PDF document and attach RAG chunks
      const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
      const pdfKey = `files/${userId}/uploads/spec.pdf`;
      await storage.uploadBuffer(pdfKey, Buffer.from(pdfBytes), 'application/pdf');
      const pdfFileId1 = idGenerator('files');
      await db.insert(files).values({
        fileHash: null,
        fileType: 'application/pdf',
        id: pdfFileId1,
        name: 'spec.pdf',
        size: pdfBytes.byteLength,
        url: pdfKey,
        userId,
      });

      const regDoc = await store.registerUploadedFile(agentId, {
        enableRag: true,
        fileId: pdfFileId1,
        kind: 'document',
        mimeType: 'application/pdf',
        path: 'docs/spec.pdf',
      });
      expect(regDoc.file.ragEnabled).toBe(true);

      // Simulate indexed chunk + embedding for pdfFileId1
      const [chunkRow] = await db
        .insert(chunks)
        .values({ text: 'PDF chunk text', userId })
        .returning();
      await db.insert(fileChunks).values({
        chunkId: chunkRow!.id,
        fileId: pdfFileId1,
        userId,
      });
      await db.insert(embeddings).values({
        chunkId: chunkRow!.id,
        embeddings: Array.from({ length: 1024 }, () => 0.01),
        model: 'text-embedding-3-small',
        userId,
      });

      const overviewReady = await store.getWorkspaceOverview(agentId);
      const docDto = overviewReady.files.find((f) => f.path === 'docs/spec.pdf');
      expect(docDto?.indexingStatus).toBe('ready');

      // Disabling ragEnabled must delete fileChunks + chunks + embeddings!
      await store.updateFileMetadata(agentId, regDoc.file.id, {
        baseRevision: 1,
        ragEnabled: false,
      });

      const remainingChunks = await db.select().from(chunks).where(eq(chunks.id, chunkRow!.id));
      expect(remainingChunks).toHaveLength(0);

      // Search project files with 0 S3 GET calls, excluding disabled files (H-4)!
      const alphaWritten = await store.putUserTextFile(agentId, {
        content: 'const ALPHA_TOKEN = "find_me_needle";\n',
        path: 'src/alpha.ts',
      });
      await store.putUserTextFile(agentId, {
        content: 'const DISABLED_TOKEN = "find_me_needle";\n',
        loadMode: 'disabled',
        path: 'src/disabled.ts',
      });

      // Agent actor cannot rename ordinary file into protected rules/* path (H-6)
      await expect(
        store.updateFileMetadata(agentId, alphaWritten.file!.id, {
          actor: 'agent',
          baseRevision: 1,
          path: 'rules/sneaky.md',
        }),
      ).rejects.toMatchObject({ code: 'PROTECTED_FILE', httpStatus: 403 });

      storage.getBytesCalls = 0;

      const searchRes = await store.searchProjectFiles(agentId, {
        pathPrefix: 'src',
        query: 'FIND_ME_NEEDLE',
      });
      expect(storage.getBytesCalls).toBe(0);
      expect(searchRes.matches).toHaveLength(1);
      expect(searchRes.matches[0]?.path).toBe('src/alpha.ts');
      expect(searchRes.matches[0]?.line).toBe(1);

      // B-1 reference check & cleanupAgentWorkspaceBeforeDelete (protecting messages_files!)
      const alphaOverview = await store.getWorkspaceOverview(agentId);
      const alphaFileId = alphaOverview.files.find((f) => f.path === 'src/alpha.ts')!.currentFileId;
      const refs = await findWorkspaceFileReferences(db, alphaFileId);
      expect(refs.referenced).toBe(true);
      expect(refs.sources).toContain('project_workspace_files');

      // Attach pdfFileId1 to a message in another topic so it MUST survive agent workspace cleanup!
      const msgId = idGenerator('messages');
      await db.insert(messages).values({ content: 'See spec', id: msgId, role: 'user', userId });
      await db.insert(messagesFiles).values({ fileId: pdfFileId1, messageId: msgId, userId });

      const cleanupRes = await cleanupAgentWorkspaceBeforeDelete(db, userId, agentId, storage);
      expect(cleanupRes.deletedFileIds).toContain(alphaFileId);
      expect(cleanupRes.deletedFileIds).not.toContain(pdfFileId1);
    });
  });

  describe('3. sandboxBridge.ts (Contract V), contextSnapshot.ts (B-3/H-2/H-3/M-1), and backfill.ts', () => {
    it('hydrates project files and syncs sandbox outputs across all Contract V outcomes', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);
      const [topic] = await db
        .insert(topics)
        .values({ agentId, id: `tpc_sb_${Date.now()}`, title: 'Sandbox topic', userId })
        .returning();

      await store.putUserTextFile(agentId, { content: '# Rules', path: 'AGENTS.md' });
      const codeRes = await store.putUserTextFile(agentId, {
        content: 'x = 1\n',
        path: 'src/script.py',
      });

      const hydratable = await listHydratableProjectFiles({
        agentId,
        dataGuardProtected: false,
        serverDB: db,
        userId,
      });
      expect(hydratable).toHaveLength(2);
      expect(hydratable.find((f) => f.path === 'AGENTS.md')?.readOnly).toBe(true);
      expect(hydratable.find((f) => f.path === 'src/script.py')?.readOnly).toBe(false);

      // Under Data Guard, unmasked workspace files must NOT be hydrated into E2B (B-4)
      const hydratableUnderGuard = await listHydratableProjectFiles({
        agentId,
        dataGuardProtected: true,
        serverDB: db,
        userId,
      });
      expect(hydratableUnderGuard).toEqual([]);

      // When ARCKEP_WORKSPACE_ENABLED='0', hydration immediately returns []
      process.env.ARCKEP_WORKSPACE_ENABLED = '0';
      const hydratableWhenDisabled = await listHydratableProjectFiles({
        agentId,
        dataGuardProtected: false,
        serverDB: db,
        userId,
      });
      expect(hydratableWhenDisabled).toEqual([]);
      process.env.ARCKEP_WORKSPACE_ENABLED = '1';

      // 1. Updated unprotected file
      const nextBytes = new TextEncoder().encode('x = 2\ny = 3\n');
      const syncOk = await applySandboxProjectFileSync(
        {
          agentId,
          baseRevision: codeRes.file!.currentRevision,
          bytes: nextBytes,
          dataGuardProtected: false,
          path: 'src/script.py',
          serverDB: db,
          sha256: sha256(nextBytes),
          topicId: topic!.id,
          userId,
        },
        storage,
      );
      expect(syncOk).toMatchObject({
        outcome: 'updated',
        path: 'src/script.py',
        prevRevision: 1,
        revision: 2,
      });

      // 2. Protected file -> proposal_created
      const propBytes = new TextEncoder().encode('# Rules\nNew sandbox rule\n');
      const syncProp = await applySandboxProjectFileSync(
        {
          agentId,
          baseRevision: 1,
          bytes: propBytes,
          dataGuardProtected: false,
          path: 'AGENTS.md',
          serverDB: db,
          sha256: sha256(propBytes),
          topicId: topic!.id,
          userId,
        },
        storage,
      );
      expect(syncProp.outcome).toBe('proposal_created');

      // 3. Data Guard blocked -> fallback_to_topic
      const syncGuard = await applySandboxProjectFileSync(
        {
          agentId,
          bytes: nextBytes,
          dataGuardProtected: true,
          path: 'src/new.py',
          serverDB: db,
          sha256: sha256(nextBytes),
          topicId: topic!.id,
          userId,
        },
        storage,
      );
      expect(syncGuard).toMatchObject({
        outcome: 'fallback_to_topic',
        reason: 'data_guard_blocked',
      });

      // 4. Document extension in /workspace/project/ -> protected_readonly_doc
      const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const syncDoc = await applySandboxProjectFileSync(
        {
          agentId,
          bytes: xlsxBytes,
          dataGuardProtected: false,
          path: 'reports/out.xlsx',
          serverDB: db,
          sha256: sha256(xlsxBytes),
          topicId: topic!.id,
          userId,
        },
        storage,
      );
      expect(syncDoc).toMatchObject({
        outcome: 'fallback_to_topic',
        reason: 'protected_readonly_doc',
      });

      // 5. Revision conflict -> revision_conflict
      const conflictBytes = new TextEncoder().encode('x = 999\n');
      const syncConflict = await applySandboxProjectFileSync(
        {
          agentId,
          baseRevision: 1, // current is 2!
          bytes: conflictBytes,
          dataGuardProtected: false,
          path: 'src/script.py',
          serverDB: db,
          sha256: sha256(conflictBytes),
          topicId: topic!.id,
          userId,
        },
        storage,
      );
      expect(syncConflict).toMatchObject({
        outcome: 'fallback_to_topic',
        reason: 'revision_conflict',
      });
    });

    it('freezes topic prefix snapshot across mid-topic edits, preserves sibling topic metadata (M-1), rebuilds on compressionSignature/agentId change, and caps index >50 files', async () => {
      const store = new ProjectWorkspaceStore(db, userId, storage);
      const topicId = `tpc_snap_${Date.now()}`;
      await db.insert(topics).values({
        agentId,
        id: topicId,
        metadata: { cronJobId: 'cron_keep_me', model: 'claude-sonnet-4-5' },
        title: 'Snapshot topic',
        userId,
      });

      await store.putUserTextFile(agentId, { content: 'Rule v1', path: 'AGENTS.md' });
      await store.putUserTextFile(agentId, { content: 'print(1)', path: 'src/app.py' });

      const snap1 = await resolveTopicWorkspaceSnapshot({
        agentId,
        compressionSignature: null,
        db,
        persist: true,
        topicId,
        userId,
      });
      expect(snap1.rebuilt).toBe(true);
      expect(snap1.workspaceDelta).toBeNull();
      expect(snap1.rulesBlock).toContain('Rule v1');
      expect(snap1.indexBlock).toContain(
        '<project_workspace_index trust="untrusted_workspace_data">',
      );

      // Modify AGENTS.md to v2 and add src/extra.py
      await store.putUserTextFile(agentId, {
        baseRevision: 1,
        content: 'Rule v2 updated',
        path: 'AGENTS.md',
      });
      await store.putUserTextFile(agentId, {
        content: 'extra = True',
        path: 'src/extra.py',
      });

      const snap2 = await resolveTopicWorkspaceSnapshot({
        agentId,
        compressionSignature: null,
        db,
        persist: true,
        topicId,
        userId,
      });
      expect(snap2.rebuilt).toBe(false);
      // Frozen prefix!
      expect(snap2.rulesBlock).toBe(snap1.rulesBlock);
      expect(snap2.indexBlock).toBe(snap1.indexBlock);
      // Delta contains changes + <updated_project_rules>
      expect(snap2.workspaceDelta).toContain('AGENTS.md: updated (v1 -> v2)');
      expect(snap2.workspaceDelta).toContain('src/extra.py: created (v1)');
      expect(snap2.workspaceDelta).toContain('<updated_project_rules>');
      expect(snap2.workspaceDelta).toContain('Rule v2 updated');

      // Sibling metadata keys on topics.metadata must stay intact!
      const [tpcRow] = await db.select().from(topics).where(eq(topics.id, topicId));
      expect((tpcRow?.metadata as any)?.cronJobId).toBe('cron_keep_me');
      expect((tpcRow?.metadata as any)?.model).toBe('claude-sonnet-4-5');

      // Explicit forceRebuild: true refreshes frozen prefix even without compressionSignature change (HIGH #3b)
      const snapForced = await resolveTopicWorkspaceSnapshot({
        agentId,
        compressionSignature: null,
        db,
        forceRebuild: true,
        persist: true,
        topicId,
        userId,
      });
      expect(snapForced.rebuilt).toBe(true);
      expect(snapForced.rulesBlock).toContain('Rule v2 updated');
      expect(snapForced.indexBlock).toContain('src/extra.py');
      expect(snapForced.workspaceDelta).toBeNull();

      // Changing compressionSignature forces clean rebuild (H-3)
      const snap3 = await resolveTopicWorkspaceSnapshot({
        agentId,
        compressionSignature: 'cmp_after_summary_1',
        db,
        persist: true,
        topicId,
        userId,
      });
      expect(snap3.rebuilt).toBe(true);
      expect(snap3.rulesBlock).toContain('Rule v2 updated');
      expect(snap3.workspaceDelta).toBeNull();

      // Index folder summary mode for > 50 files stays <= 6000 chars
      const manyEntries = Array.from({ length: 80 }, (_, idx) => ({
        byteSize: 2048,
        kind: 'text' as const,
        lineCount: 42,
        loadMode: idx === 0 ? ('always' as const) : ('on_demand' as const),
        path: `module_${idx % 5}/file_${idx}.ts`,
        revision: 1,
        updatedAt: Date.now() - idx * 1000,
        userSummary: 'Описание модуля для проверки лимита 6000 символов',
      }));
      const largeIndex = formatWorkspaceIndexBlock(manyEntries);
      expect(largeIndex.length).toBeLessThanOrEqual(MAX_WORKSPACE_INDEX_CHARS);
      expect(largeIndex).toContain('Папки:');
    });

    it('runs backfillProjectWorkspaces idempotently across system_role, single-agent KB, agent_documents, and agents_files', async () => {
      const otherAgentId = `agt_other_${Date.now()}`;
      await db.insert(agents).values({
        id: otherAgentId,
        slug: 'second-agent',
        systemRole: null,
        title: 'Второй агент',
        userId,
        virtual: false,
      });

      // 1. Single-agent KB (`Файлы проекта «Финансовый аналитик»`) with duplicate filenames `report.pdf`
      const singleKbId = idGenerator('knowledgeBases');
      await db.insert(knowledgeBases).values({
        id: singleKbId,
        name: 'Файлы проекта «Финансовый аналитик»',
        userId,
      });
      await db.insert(agentsKnowledgeBases).values({
        agentId,
        enabled: true,
        knowledgeBaseId: singleKbId,
        userId,
      });

      const kbFile1 = idGenerator('files');
      const kbFile2 = idGenerator('files');
      await db.insert(files).values([
        {
          fileType: 'application/pdf',
          id: kbFile1,
          name: 'report.pdf',
          size: 1024,
          url: `files/${userId}/kb1.pdf`,
          userId,
        },
        {
          fileType: 'application/pdf',
          id: kbFile2,
          name: 'report.pdf',
          size: 2048,
          url: `files/${userId}/kb2.pdf`,
          userId,
        },
      ]);
      await db.insert(knowledgeBaseFiles).values([
        { fileId: kbFile1, knowledgeBaseId: singleKbId, userId },
        { fileId: kbFile2, knowledgeBaseId: singleKbId, userId },
      ]);

      // 2. Shared KB linked to 2 agents -> MUST BE SKIPPED (M-2)
      const sharedKbId = idGenerator('knowledgeBases');
      await db.insert(knowledgeBases).values({
        id: sharedKbId,
        name: 'Файлы проекта «Общая база»',
        userId,
      });
      await db.insert(agentsKnowledgeBases).values([
        { agentId, enabled: true, knowledgeBaseId: sharedKbId, userId },
        { agentId: otherAgentId, enabled: true, knowledgeBaseId: sharedKbId, userId },
      ]);

      // 3. Active agent_documents
      const docId = idGenerator('documents', 16);
      await db.insert(documents).values({
        content: '# Справочник терминов\nEBITDA — прибыль до вычета.',
        fileType: 'text/markdown',
        filename: 'glossary.md',
        id: docId,
        source: 'agent-doc',
        sourceType: 'api',
        title: 'glossary',
        totalCharCount: 48,
        totalLineCount: 2,
        userId,
      });
      await db.insert(agentDocuments).values({
        agentId,
        documentId: docId,
        policyLoad: 'always',
        userId,
      });

      // 4. Active agents_files
      const afFileId = idGenerator('files');
      const csvBytes = encodeSourceText('a,b\n1,2\n', 'utf-8', 'LF');
      const csvKey = `files/${userId}/table.csv`;
      await storage.uploadBuffer(csvKey, Buffer.from(csvBytes), 'text/csv');
      await db.insert(files).values({
        fileType: 'text/csv',
        id: afFileId,
        name: 'table.csv',
        size: csvBytes.byteLength,
        url: csvKey,
        userId,
      });
      await db.insert(agentsFiles).values({
        agentId,
        enabled: true,
        fileId: afFileId,
        userId,
      });

      // Pass 1 (Step 1 deploy, finalizeCutover: false): non-destructive copy!
      const runPhase1 = await backfillProjectWorkspaces(db, {
        fileServiceFactory: () => storage,
        finalizeCutover: false,
        userId,
      });
      expect(runPhase1.finalizeCutover).toBe(false);
      expect(runPhase1.systemRolesMigrated).toBe(1);
      expect(runPhase1.knowledgeBasesClaimed).toBe(0);
      expect(runPhase1.knowledgeBaseFilesMigrated).toBe(2);
      expect(runPhase1.agentDocumentsMigrated).toBe(1);
      expect(runPhase1.agentsFilesMigrated).toBe(1);
      expect(runPhase1.skippedReasons).toContain(`kb:${sharedKbId}:linked_to_2_agents`);

      // Verify legacy columns remain untouched while ARCKEP_WORKSPACE_ENABLED=0
      const [agentAfterPhase1] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agentAfterPhase1?.systemRole).toBe('Legacy role to be cleared');
      const [kbAfterPhase1] = await db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, singleKbId));
      expect(kbAfterPhase1?.type).toBeNull();
      const [afAfterPhase1] = await db
        .select()
        .from(agentsFiles)
        .where(eq(agentsFiles.fileId, afFileId));
      expect(afAfterPhase1?.enabled).toBe(true);

      // Pass 2 (Step 2 deploy, finalizeCutover: true): finalizes cutover without duplicating files!
      const runPhase2 = await backfillProjectWorkspaces(db, {
        fileServiceFactory: () => storage,
        finalizeCutover: true,
        userId,
      });
      expect(runPhase2.finalizeCutover).toBe(true);
      expect(runPhase2.systemRolesMigrated).toBe(0);
      expect(runPhase2.knowledgeBasesClaimed).toBe(1);
      expect(runPhase2.knowledgeBaseFilesMigrated).toBe(0);
      expect(runPhase2.agentDocumentsMigrated).toBe(0);
      expect(runPhase2.agentsFilesMigrated).toBe(0);

      const store = new ProjectWorkspaceStore(db, userId, storage);
      const overview = await store.getWorkspaceOverview(agentId);
      const paths = overview.files.map((f) => f.path);
      expect(overview.files).toHaveLength(5);
      expect(paths).toContain('AGENTS.md');
      expect(paths).toContain('report.pdf');
      expect(paths).toContain('report (2).pdf');
      expect(paths).toContain('glossary.md');
      expect(paths).toContain('table.csv');

      const [agentAfterPhase2] = await db.select().from(agents).where(eq(agents.id, agentId));
      expect(agentAfterPhase2?.systemRole).toBeNull();
      const [kbAfterPhase2] = await db
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, singleKbId));
      expect(kbAfterPhase2?.type).toBe('project_workspace');
      expect((kbAfterPhase2?.settings as any)?.managedByAgentId).toBe(agentId);

      const [afAfter] = await db.select().from(agentsFiles).where(eq(agentsFiles.fileId, afFileId));
      expect(afAfter?.enabled).toBe(false);

      // Pass 3: Re-run backfill with finalizeCutover: true -> 100% idempotent!
      const run3 = await backfillProjectWorkspaces(db, {
        fileServiceFactory: () => storage,
        finalizeCutover: true,
        userId,
      });
      expect(run3.systemRolesMigrated).toBe(0);
      expect(run3.knowledgeBasesClaimed).toBe(0);
      expect(run3.knowledgeBaseFilesMigrated).toBe(0);
      expect(run3.agentDocumentsMigrated).toBe(0);
      expect(run3.agentsFilesMigrated).toBe(0);
    });
  });
});
