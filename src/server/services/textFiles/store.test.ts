// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  agents,
  agentsFiles,
  agentsKnowledgeBases,
  files,
  knowledgeBaseFiles,
  knowledgeBases,
  messages,
  messagesFiles,
  topics,
  users,
} from '@/database/schemas';
import { topicReferenceRuntime } from '@/server/services/toolExecution/serverRuntimes/topicReference';
import { isTrustedPrivateCodeFile } from '@/server/services/topicContext/codeArtifacts';

import { FileUploadService } from '../../../../packages/openapi/src/services/file.service';
import {
  MAX_SOURCE_BYTES,
  parseTextFileReceipt,
  RECEIPT_PREFIX,
  stripTextFileReceiptForClient,
  TextFileStore,
} from './store';

const db = await getTestDB();
const blobs = new Map<string, Buffer>();
const storage = {
  uploadBuffer: vi.fn(async (key: string, data: Buffer, _mime: string, privateFile?: boolean) => {
    expect(privateFile).toBe(true);
    blobs.set(key, Buffer.from(data));
    return { key };
  }),
  getFileByteArray: vi.fn(async (key: string) => blobs.get(key)!),
  deleteFile: vi.fn(async (key: string) => {
    blobs.delete(key);
  }),
};
const owner = 'owner';
const topic = 'one';
const store = (user = owner, id = topic) => new TextFileStore(db, user, id, storage);
beforeAll(async () => {
  await db.insert(users).values([{ id: owner }, { id: 'other' }]);
  await db.insert(topics).values([
    { id: topic, userId: owner },
    { id: 'two', userId: owner },
  ]);
});

describe('durable source parts', () => {
  it('recovers 165k+ exact characters on a new run without any retained assistant message', async () => {
    const fileName = 'Новый модуль странный.расширение';
    const sections = Array.from({ length: 12 }, (_, i) => i + '\uFEFFзначение\r\n  '.repeat(1600));
    let documentId: string | undefined;
    let result;
    for (const [index, text] of sections.entries()) {
      result = await store().write('assistant-' + index, {
        documentId,
        fileName,
        final: index === sections.length - 1,
        part: index + 1,
        text,
      });
      documentId = result.documentId;
      expect(await store().list()).toContainEqual(result);
      if (index === 4) {
        expect(await store().resume(documentId)).toEqual({
          receipt: result,
          tail: sections.slice(0, 5).join('').slice(-4096),
        });
      }
    }
    expect(sections.join('').length).toBeGreaterThan(165000);
    expect(
      blobs.get(`files/${owner}/code-artifacts/${topic}/${result!.fileId}/source.txt`),
    ).toEqual(Buffer.from(sections.join('')));
    expect((await store().list()).filter((f) => f.documentId === documentId)).toEqual([result]);
    await expect(store().resume(documentId!)).rejects.toThrow('not_found');
  });
  it('deduplicates parallel starts and rejects divergent replay, gaps and closed appends', async () => {
    const input = { fileName: '.env', final: false, part: 1, text: 'a\r\n' };
    const [a, b] = await Promise.all([
      store().write('parent', input),
      store().write('parent', input),
    ]);
    expect(a).toEqual(b);
    const second = { ...input, documentId: a.documentId, final: true, part: 2, text: 'b' };
    await expect(store().write('p', { ...second, part: 3 })).rejects.toThrow('not_found');
    const [x, y] = await Promise.allSettled([
      store().write('p', second),
      store().write('p', { ...second, text: 'different' }),
    ]);
    expect([x, y].filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([x, y].filter((r) => r.status === 'rejected')).toHaveLength(1);
    await expect(store().write('p', { ...second, part: 3 })).rejects.toThrow('part_conflict');
    expect(await store().write('new-parent', { ...input, documentId: a.documentId })).toEqual(a);
  });
  it('scopes reads, resumes, writes, and source provenance to owner and topic', async () => {
    const input = { fileName: 'Makefile', final: false, part: 1, text: 'all:' };
    const first = await store().write('new', input);
    expect(await isTrustedPrivateCodeFile(db, owner, topic, first.fileId)).toBe(true);
    for (const [user, id] of [
      ['other', topic],
      [owner, 'two'],
    ]) {
      expect(await store(user, id).list()).not.toContainEqual(first);
      await expect(store(user, id).resume(first.documentId)).rejects.toThrow('not_found');
      await expect(
        store(user, id).write('other', { ...input, documentId: first.documentId, part: 2 }),
      ).rejects.toThrow('not_found');
      expect(await isTrustedPrivateCodeFile(db, user, id, first.fileId)).toBe(false);
    }
  });
  it('never reads a writer snapshot from another conversation in a protected tool run', async () => {
    const first = await store().write('guard', {
      fileName: 'protected.txt',
      part: 1,
      text: 'private',
      final: true,
    });
    const runtime = topicReferenceRuntime.factory({
      serverDB: db,
      userId: owner,
      topicId: 'two',
      toolManifestMap: {},
      dataGuardProtected: true,
    });
    expect(
      await runtime.getTopicContext({
        mode: 'code_artifacts',
        topicId: topic,
        fileId: first.fileId,
      }),
    ).toMatchObject({ success: false });
    const list = await runtime.getTopicContext({ mode: 'code_artifacts', topicId: topic });
    expect(list.content).not.toContain(first.fileId);
  });
  it('refuses URL signing for another owner even with a global FILE_READ grant', async () => {
    const first = await store().write('private', {
      fileName: 'source',
      part: 1,
      text: 'private',
      final: true,
    });
    const signed = vi.fn(async () => 'signed');
    const service = Object.assign(Object.create(FileUploadService.prototype), {
      db,
      userId: 'other',
      coreFileService: {},
      s3Service: { createPreSignedUrlForPreview: signed },
      resolveOperationPermission: async () => ({ isPermitted: true }),
      log: vi.fn(),
    });
    await expect(service.getFileUrl(first.fileId)).rejects.toThrow('File not found');
    expect(signed).not.toHaveBeenCalled();
    service.userId = owner;
    expect(await service.getFileUrl(first.fileId)).toMatchObject({
      fileId: first.fileId,
      url: 'signed',
    });
    await db.insert(topics).values({ id: 'removed', userId: owner });
    const deleted = await store(owner, 'removed').write('p', {
      fileName: 'deleted',
      part: 1,
      text: 'x',
      final: true,
    });
    await db.delete(topics).where(eq(topics.id, 'removed'));
    await expect(service.getFileUrl(deleted.fileId)).rejects.toThrow('File not found');
  });
  it('accepts 255 UTF-8 name bytes, empty final and whitespace bytes', async () => {
    const fileName = 'Я'.repeat(127) + 'x';
    const a = await store().write('a', { fileName, part: 1, final: false, text: '  \r\n' });
    const b = await store().write('b', {
      documentId: a.documentId,
      fileName,
      part: 2,
      final: true,
      text: '',
    });
    expect(blobs.get(`files/${owner}/code-artifacts/${topic}/${b.fileId}/source.txt`)).toEqual(
      Buffer.from('  \r\n'),
    );
    const empty = await store().write('empty', {
      fileName: 'empty',
      part: 1,
      text: '',
      final: true,
    });
    expect(empty.status).toBe('ready');
    await expect(
      store().write('too-long', { fileName: fileName + 'a', part: 1, final: true, text: '' }),
    ).rejects.toThrow('invalid_part');
  });
  it.each([
    ' padded',
    'padded ',
    'a?',
    'a*',
    'a|',
    'a<',
    'a>',
    'a:',
    'a"',
    'a/b',
    '../a',
    'a\\b',
    '\u202Efile',
    '.',
    '..',
    'a\0',
    'a\n',
  ])('rejects invalid basename %j', async (fileName) => {
    await expect(store().write('p', { fileName, final: true, part: 1, text: 'x' })).rejects.toThrow(
      'invalid_part',
    );
  });
});

// Minimal Unicode -> Windows-1251 encoder for test fixtures (ASCII + Cyrillic + Ё/ё + №)
const encodeCp1251 = (text: string): Buffer => {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code >= 0x0410 && code <= 0x044f) {
      bytes.push(code - 0x0410 + 0xc0);
    } else if (code === 0x0401) {
      bytes.push(0xa8);
    } else if (code === 0x0451) {
      bytes.push(0xb8);
    } else if (code === 0x2116) {
      bytes.push(0xb9);
    } else {
      throw new Error(`Unsupported CP1251 test char: ${ch} (U+${code.toString(16)})`);
    }
  }
  return Buffer.from(bytes);
};

describe('stripTextFileReceiptForClient & parseTextFileReceipt', () => {
  it('strips LLM diff tail down to canonical 2-line 5-key receipt and preserves plain text', () => {
    const receipt = {
      documentId: '11111111-1111-5111-a111-111111111111',
      fileId: '22222222-2222-5222-a222-222222222222',
      fileName: 'Module1.bas',
      part: 2,
      status: 'ready' as const,
    };
    const withDiff =
      RECEIPT_PREFIX +
      JSON.stringify(receipt) +
      '\nPatch applied: 1 edit, lines 10 -> 11 (+1 / -0)\n@@ -1,2 +1,3 @@\n+x = 1';
    const stripped = stripTextFileReceiptForClient(withDiff);
    expect(stripped).toBe(RECEIPT_PREFIX + JSON.stringify(receipt));
    expect(stripped.split('\n')).toHaveLength(2);
    expect(parseTextFileReceipt(withDiff)).toEqual(receipt);
    expect(stripTextFileReceiptForClient('plain tool output\nline 2')).toBe(
      'plain tool output\nline 2',
    );
  });
});

describe('TextFileStore.patch & resolveReadableSourceFile', () => {
  it('patches a CP1251 160K+ Cyrillic VBA attachment with CRLF and supports re-patching over ready + toolCallId replay', async () => {
    const blocks: string[] = ['Attribute VB_Name = "ModuleMain"', 'Option Explicit', ''];
    for (let i = 1; i <= 480; i++) {
      blocks.push(
        `' Блок расчёта №${i} для скидок и НДС`,
        `Public Sub CalcBlock_${i}(ByVal ws As Worksheet)`,
        `    Dim rate As Double`,
        `    rate = ${(0.01 * i).toFixed(2)}`,
        `    ws.Cells(${i}, 2).Value = "Скидка применена к документу №${i} по стандартной таблице расчёта Excel"`,
        `    ws.Cells(${i}, 3).Value = "Контроль суммы строки ${i} завершён без расхождений в модуле 7.3.1"`,
        `End Sub`,
        '',
      );
    }
    const vbaText = blocks.join('\r\n');
    expect(vbaText.length).toBeGreaterThan(160_000);
    const cp1251Bytes = encodeCp1251(vbaText);

    const fileId = 'file_vba_cp1251';
    const key = `files/${owner}/uploads/${fileId}/7.3.1.txt`;
    blobs.set(key, cp1251Bytes);

    await db.insert(files).values({
      fileType: 'text/plain',
      id: fileId,
      name: '7.3.1.txt',
      size: cp1251Bytes.length,
      url: key,
      userId: owner,
    });
    const msgId = 'msg_attach_vba';
    await db.insert(messages).values({
      content: 'Поправь модуль',
      id: msgId,
      role: 'user',
      topicId: topic,
      userId: owner,
    });
    await db.insert(messagesFiles).values({
      fileId,
      messageId: msgId,
      userId: owner,
    });

    const targetNums = [1, 12, 24, 36, 48, 60, 72, 84, 96, 105, 115];
    const edits = targetNums.map((n) => ({
      newText: `    ws.Cells(${n}, 3).Value = "Обновлено версией 7.3.2 для блока №${n}"`,
      oldText: `    ws.Cells(${n}, 3).Value = "Контроль суммы строки ${n} завершён без расхождений в модуле 7.3.1"`,
    }));

    const first = await store().patch(
      'op-vba-1',
      { edits, fileName: '7.3.2.bas', sourceFileId: fileId },
      { requestMessageId: msgId, toolCallId: 'tc_patch_1' },
    );

    expect(first.receipt).toMatchObject({
      fileName: '7.3.2.bas',
      part: 1,
      status: 'ready',
    });
    expect(first.sourceEncoding).toBe('windows-1251');
    expect(first.lineEnding).toBe('CRLF');
    expect(first.appliedEdits).toBe(11);
    expect(first.diffSummary).toContain('encoding windows-1251 -> utf-8, lineEnding CRLF');

    const savedKey1 = `files/${owner}/code-artifacts/${topic}/${first.receipt.fileId}/source.txt`;
    const savedBuf1 = blobs.get(savedKey1)!;
    const savedUtf8_1 = savedBuf1.toString('utf8');
    expect(savedUtf8_1).not.toContain('\uFFFD');
    expect(savedUtf8_1).toContain('\r\n');
    expect(savedUtf8_1.replaceAll('\r\n', '')).not.toContain('\n');
    expect(savedUtf8_1).toContain('Обновлено версией 7.3.2 для блока №115');

    // Idempotent replay with the same toolCallId returns identical receipt without re-uploading
    storage.uploadBuffer.mockClear();
    const replayed1 = await store().patch(
      'op-vba-1',
      { edits, fileName: '7.3.2.bas', sourceFileId: fileId },
      { requestMessageId: msgId, toolCallId: 'tc_patch_1' },
    );
    expect(replayed1.replayed).toBe(true);
    expect(replayed1.receipt).toEqual(first.receipt);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();

    // Re-patch directly over status: 'ready' using documentId -> creates part 2!
    const second = await store().patch(
      'op-vba-2',
      {
        documentId: first.receipt.documentId,
        edits: [
          {
            newText: 'Attribute VB_Name = "ModuleMainV2"',
            oldText: 'Attribute VB_Name = "ModuleMain"',
          },
        ],
      },
      { toolCallId: 'tc_patch_2' },
    );
    expect(second.receipt).toMatchObject({
      documentId: first.receipt.documentId,
      fileName: '7.3.2.bas',
      part: 2,
      status: 'ready',
    });
    const savedBuf2 = blobs.get(
      `files/${owner}/code-artifacts/${topic}/${second.receipt.fileId}/source.txt`,
    )!;
    expect(savedBuf2.toString('utf8')).toContain('Attribute VB_Name = "ModuleMainV2"\r\n');
    expect(savedBuf2.toString('utf8')).toContain('Обновлено версией 7.3.2 для блока №115');

    // Replay of documentId re-patch with same toolCallId is also idempotent!
    storage.uploadBuffer.mockClear();
    const replayed2 = await store().patch(
      'op-vba-2',
      {
        documentId: first.receipt.documentId,
        edits: [
          {
            newText: 'Attribute VB_Name = "ModuleMainV2"',
            oldText: 'Attribute VB_Name = "ModuleMain"',
          },
        ],
      },
      { toolCallId: 'tc_patch_2' },
    );
    expect(replayed2.replayed).toBe(true);
    expect(replayed2.receipt).toEqual(second.receipt);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();

    // list() returns latest part 2
    expect((await store().list()).find((r) => r.documentId === first.receipt.documentId)).toEqual(
      second.receipt,
    );
  });

  it('allows re-patching over draft and enforces mutually exclusive sourceFileId XOR documentId', async () => {
    const draft = await store().write('draft-op', {
      fileName: 'draft.ts',
      final: false,
      part: 1,
      text: 'const v = 1;\n',
    });

    const patched = await store().patch(
      'patch-draft',
      {
        documentId: draft.documentId,
        edits: [{ newText: 'const v = 2;', oldText: 'const v = 1;' }],
        final: false,
      },
      { toolCallId: 'tc_draft_patch' },
    );
    expect(patched.receipt).toMatchObject({
      documentId: draft.documentId,
      part: 2,
      status: 'draft',
    });
    expect((await store().resume(draft.documentId)).tail).toBe('const v = 2;\n');

    // Both sourceFileId and documentId -> invalid_patch
    await expect(
      store().patch('bad', {
        documentId: draft.documentId,
        edits: [{ newText: 'b', oldText: 'a' }],
        sourceFileId: draft.fileId,
      }),
    ).rejects.toThrow('invalid_patch');

    // Neither sourceFileId nor documentId -> invalid_patch
    await expect(
      store().patch('bad', {
        edits: [{ newText: 'b', oldText: 'a' }],
      }),
    ).rejects.toThrow('invalid_patch');
  });

  it('enforces strict SQL scope / IDOR: blocks other user, other topic, orphan, internal://, disabled agent/KB files; allows enabled agent & KB files', async () => {
    const makeFile = async (
      id: string,
      userId: string,
      url: string,
      content: string,
      fileType = 'text/plain',
    ) => {
      blobs.set(url, Buffer.from(content, 'utf8'));
      await db.insert(files).values({
        fileType,
        id,
        name: `${id}.txt`,
        size: Buffer.byteLength(content),
        url,
        userId,
      });
    };

    // 1. Other user's file
    await makeFile('f_other_user', 'other', 'files/other/u/f1.txt', 'secret=1\n');
    await expect(
      store().patch('op', {
        edits: [{ newText: 'secret=2', oldText: 'secret=1' }],
        sourceFileId: 'f_other_user',
      }),
    ).rejects.toThrow('not_found');

    // 2. Owner's file attached to topic 'two' (NOT current topic 'one')
    await makeFile('f_other_topic', owner, `files/${owner}/u/f2.txt`, 'topicTwo=1\n');
    await db.insert(messages).values({
      content: 'other topic msg',
      id: 'msg_other_topic',
      role: 'user',
      topicId: 'two',
      userId: owner,
    });
    await db.insert(messagesFiles).values({
      fileId: 'f_other_topic',
      messageId: 'msg_other_topic',
      userId: owner,
    });
    await expect(
      store().patch('op', {
        edits: [{ newText: 'topicTwo=2', oldText: 'topicTwo=1' }],
        sourceFileId: 'f_other_topic',
      }),
    ).rejects.toThrow('not_found');

    // 3. Unattached orphan file of same owner
    await makeFile('f_orphan', owner, `files/${owner}/u/f3.txt`, 'orphan=1\n');
    await expect(
      store().patch('op', {
        edits: [{ newText: 'orphan=2', oldText: 'orphan=1' }],
        sourceFileId: 'f_orphan',
      }),
    ).rejects.toThrow('not_found');

    // 4. internal:// URL even if attached to current topic
    await makeFile('f_internal', owner, 'internal://skills/secret.txt', 'internal=1\n');
    await db.insert(messages).values({
      content: 'internal msg',
      id: 'msg_internal',
      role: 'user',
      topicId: topic,
      userId: owner,
    });
    await db.insert(messagesFiles).values({
      fileId: 'f_internal',
      messageId: 'msg_internal',
      userId: owner,
    });
    await expect(
      store().patch('op', {
        edits: [{ newText: 'internal=2', oldText: 'internal=1' }],
        sourceFileId: 'f_internal',
      }),
    ).rejects.toThrow('not_found');

    // 5. Agent files & KB files: disabled rejected, enabled allowed when agentId passed
    await db.insert(agents).values({ id: 'ag_patch', userId: owner });
    await makeFile('f_ag_disabled', owner, `files/${owner}/u/ag_dis.txt`, 'k=1\n');
    await makeFile('f_ag_enabled', owner, `files/${owner}/u/ag_en.txt`, 'k=1\n');
    await db.insert(agentsFiles).values([
      { agentId: 'ag_patch', enabled: false, fileId: 'f_ag_disabled', userId: owner },
      { agentId: 'ag_patch', enabled: true, fileId: 'f_ag_enabled', userId: owner },
    ]);

    await expect(
      store().patch(
        'op',
        { edits: [{ newText: 'k=2', oldText: 'k=1' }], sourceFileId: 'f_ag_disabled' },
        { agentId: 'ag_patch' },
      ),
    ).rejects.toThrow('not_found');

    // Without agentId even enabled agent file is not accessible
    await expect(
      store().patch('op', {
        edits: [{ newText: 'k=2', oldText: 'k=1' }],
        sourceFileId: 'f_ag_enabled',
      }),
    ).rejects.toThrow('not_found');

    // With agentId enabled agent file succeeds
    const agRes = await store().patch(
      'op-ag',
      { edits: [{ newText: 'k=2', oldText: 'k=1' }], sourceFileId: 'f_ag_enabled' },
      { agentId: 'ag_patch', toolCallId: 'tc_ag_ok' },
    );
    expect(agRes.receipt.status).toBe('ready');

    // Knowledge base file
    await db.insert(knowledgeBases).values({ id: 'kb_patch', name: 'KB', userId: owner });
    await makeFile('f_kb_en', owner, `files/${owner}/u/kb_en.txt`, 'kb=1\n');
    await db.insert(knowledgeBaseFiles).values({
      fileId: 'f_kb_en',
      knowledgeBaseId: 'kb_patch',
      userId: owner,
    });
    await db.insert(agentsKnowledgeBases).values({
      agentId: 'ag_patch',
      enabled: true,
      knowledgeBaseId: 'kb_patch',
      userId: owner,
    });

    const kbRes = await store().patch(
      'op-kb',
      { edits: [{ newText: 'kb=2', oldText: 'kb=1' }], sourceFileId: 'f_kb_en' },
      { agentId: 'ag_patch', toolCallId: 'tc_kb_ok' },
    );
    expect(kbRes.receipt.status).toBe('ready');
  });

  it('rejects oversized files and binary MIMEs BEFORE S3 download, and rejects NUL bytes in text files', async () => {
    const msgId = 'msg_guard_checks';
    await db.insert(messages).values({
      content: 'files',
      id: msgId,
      role: 'user',
      topicId: topic,
      userId: owner,
    });

    // Oversized file (size > MAX_SOURCE_BYTES) — S3 getFileByteArray must NOT be called!
    await db.insert(files).values({
      fileType: 'text/plain',
      id: 'f_huge',
      name: 'huge.log',
      size: MAX_SOURCE_BYTES + 1,
      url: `files/${owner}/u/huge.log`,
      userId: owner,
    });
    await db.insert(messagesFiles).values({ fileId: 'f_huge', messageId: msgId, userId: owner });

    storage.getFileByteArray.mockClear();
    await expect(
      store().patch('op', {
        edits: [{ newText: 'b', oldText: 'a' }],
        sourceFileId: 'f_huge',
      }),
    ).rejects.toThrow('size_limit');
    expect(storage.getFileByteArray).not.toHaveBeenCalled();

    // Binary MIME (PDF) — S3 getFileByteArray must NOT be called!
    await db.insert(files).values({
      fileType: 'application/pdf',
      id: 'f_pdf',
      name: 'report.pdf',
      size: 1024,
      url: `files/${owner}/u/report.pdf`,
      userId: owner,
    });
    await db.insert(messagesFiles).values({ fileId: 'f_pdf', messageId: msgId, userId: owner });

    storage.getFileByteArray.mockClear();
    await expect(
      store().patch('op', {
        edits: [{ newText: 'b', oldText: 'a' }],
        sourceFileId: 'f_pdf',
      }),
    ).rejects.toThrow('binary_file');
    expect(storage.getFileByteArray).not.toHaveBeenCalled();

    // Disguised binary with NUL byte after first 2048 bytes
    const disguised = Buffer.concat([Buffer.alloc(3000, 0x41), Buffer.from([0x00, 0x42])]);
    const disguisedUrl = `files/${owner}/u/disguised.txt`;
    blobs.set(disguisedUrl, disguised);
    await db.insert(files).values({
      fileType: 'text/plain',
      id: 'f_nul',
      name: 'disguised.txt',
      size: disguised.length,
      url: disguisedUrl,
      userId: owner,
    });
    await db.insert(messagesFiles).values({ fileId: 'f_nul', messageId: msgId, userId: owner });

    await expect(
      store().patch('op', {
        edits: [{ newText: 'B', oldText: 'A' }],
        sourceFileId: 'f_nul',
      }),
    ).rejects.toThrow('binary_file');
  });
});
