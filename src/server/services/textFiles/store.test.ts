// @vitest-environment node
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { topics, users } from '@/database/schemas';
import { topicReferenceRuntime } from '@/server/services/toolExecution/serverRuntimes/topicReference';
import { isTrustedPrivateCodeFile } from '@/server/services/topicContext/codeArtifacts';

import { FileUploadService } from '../../../../packages/openapi/src/services/file.service';
import { TextFileStore } from './store';

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
