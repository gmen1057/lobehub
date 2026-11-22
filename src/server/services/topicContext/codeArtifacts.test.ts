// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { CompressionRepository } from '@/database/repositories/compression';
import { files, messages, topics, users } from '@/database/schemas';
import { saveLongCodeArtifacts } from '@/server/services/aiAgent/codeArtifacts';
import { FileService } from '@/server/services/file';

import { topicHasCodeArtifacts } from './codeArtifacts';
import { getTopicContext } from './index';

const sources = vi.hoisted(() => new Map<string, Buffer>());
const read = vi.hoisted(() => vi.fn(async (key: string) => sources.get(key)!));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({
    getFileByteArray: read,
    uploadBuffer: async (key: string, buffer: Buffer) => {
      sources.set(key, Buffer.from(buffer));
      return { key };
    },
  }),
}));

const db = await getTestDB();
const oldCode =
  '\uFEFFAttribute VB_Name = "Module1"\r\nSub Run()\r\n' +
  " ' исходный модуль\r\n".repeat(24) +
  'End Sub\r\n';
const newCode = oldCode + "  ' сохранён исходник 💡  \r\n".repeat(1700);
const versionIds: string[] = [];
const versionFile = (
  fileId: string,
  userId: string,
  topicId: string,
  content: string,
  day: number,
) => {
  const url = `files/${userId}/code-artifacts/${topicId}/${fileId}/Module1.bas`;
  sources.set(url, Buffer.from(content, 'utf8'));
  return {
    createdAt: new Date(Date.UTC(2026, 10, day)),
    fileType: 'text/plain',
    id: fileId,
    metadata: {
      codeArtifact: {
        identifier: 'vba-module1',
        language: 'vba',
        messageId: `pending-${fileId}`,
        title: 'Module1.bas',
        topicId,
      },
    },
    name: 'Module1.bas',
    size: Buffer.byteLength(content, 'utf8'),
    url,
    userId,
  };
};

beforeAll(async () => {
  await db.insert(users).values([{ id: 'owner' }, { id: 'foreign' }]);
  await db.insert(topics).values([
    { id: 'topic_1', userId: 'owner' },
    { id: 'topic_2', userId: 'owner' },
  ]);
  await db.insert(files).values([
    versionFile('other-topic', 'owner', 'topic_2', 'other topic', 3),
    versionFile('foreign', 'foreign', 'topic_1', 'foreign source', 3),
    versionFile('unpublished', 'owner', 'topic_1', 'cancelled source', 5),
    {
      ...versionFile('invalid-path', 'owner', 'topic_1', 'wrong namespace', 4),
      url: 'files/owner/upload.bas',
    },
  ]);
  const fileService = new FileService(db, 'owner');
  const messageIds: string[] = [];
  for (const [index, source] of [oldCode, newCode].entries()) {
    const messageId = `code-${index}`;
    const content = await saveLongCodeArtifacts(`\`\`\`vba Module1.bas\r\n${source}\`\`\``, {
      fileService: () => fileService,
      messageId,
      topicId: 'topic_1',
      userId: 'owner',
    });
    const id = /src="\/chat\/code-artifact\/([a-f0-9-]+)\/"/.exec(content)?.[1];
    expect(id).toBeDefined();
    versionIds.push(id!);
    await db
      .insert(messages)
      .values({ content, id: messageId, role: 'assistant', topicId: 'topic_1', userId: 'owner' });
    messageIds.push(messageId);
  }
  await new CompressionRepository(db, 'owner').createCompressionGroup({
    content: 'Создан и изменён модуль VBA.',
    messageIds,
    metadata: {},
    topicId: 'topic_1',
  });
});

describe('saved code source', () => {
  const context = (
    params: {
      fileId?: string;
      maxLines?: number;
      offset?: number;
      query?: string;
      startLine?: number;
    } = {},
  ) => getTopicContext(db, 'owner', { ...params, mode: 'code_artifacts', topicId: 'topic_1' });

  it('lists durable versions in order even without any original messages in the active context', async () => {
    expect(await topicHasCodeArtifacts(db, 'owner', 'topic_1')).toBe(true);
    expect(await topicHasCodeArtifacts(db, 'owner', 'topic%1')).toBe(false);
    const result = await context();
    expect(result.success).toBe(true);
    const versions = JSON.parse(result.content).versions;
    expect(versions.map((v: { fileId: string }) => v.fileId)).toEqual([...versionIds].reverse());
    expect(versions[0]).toMatchObject({ identifier: versions[1].identifier, title: 'Module1.bas' });
    expect(
      await getTopicContext(db, 'foreign', { mode: 'code_artifacts', topicId: 'topic_1' }),
    ).toMatchObject({ success: false });
  });

  it('reads both immutable versions without altering BOM, source bytes or page boundaries', async () => {
    for (const [fileId, expected] of [
      [versionIds[0], oldCode],
      [versionIds[1], newCode],
    ]) {
      let actual = '';
      let offset: number | null = 0;
      while (offset !== null) {
        const result = await context({ fileId, offset });
        expect(result.success).toBe(true);
        const boundary = result.content.indexOf('\n');
        const page = JSON.parse(result.content.slice(0, boundary));
        expect(page.fileId).toBe(fileId);
        expect(page.startOffset).toBe(offset);
        actual += result.content.slice(boundary + 1);
        offset = page.nextOffset;
      }
      expect(Buffer.from(actual, 'utf8')).toEqual(Buffer.from(expected, 'utf8'));
    }
  });

  it('cannot read an unpublished version, another owner or topic, or an unrelated storage key', async () => {
    read.mockClear();
    for (const fileId of ['unpublished', 'other-topic', 'foreign', 'invalid-path']) {
      expect((await context({ fileId })).success).toBe(false);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('supports startLine/maxLines pagination and query match indexing in code_artifacts mode', async () => {
    const fileId = versionIds[0];
    const page1 = await context({ fileId, maxLines: 5, startLine: 2 });
    expect(page1.success).toBe(true);
    const boundary1 = page1.content.indexOf('\n');
    const header1 = JSON.parse(page1.content.slice(0, boundary1));
    const body1 = page1.content.slice(boundary1 + 1);
    expect(header1).toMatchObject({
      endLine: 6,
      fileId,
      lineEnding: 'CRLF',
      nextStartLine: 7,
      startLine: 2,
      totalLines: 27,
    });
    expect(body1.split('\n')[0]).toBe('L2: Sub Run()');
    expect(body1.split('\n')[1]).toBe("L3:  ' исходный модуль");

    const queryResult = await context({ fileId, query: 'исходный модуль' });
    expect(queryResult.success).toBe(true);
    const boundaryQ = queryResult.content.indexOf('\n');
    const headerQ = JSON.parse(queryResult.content.slice(0, boundaryQ));
    expect(headerQ.totalMatches).toBe(24);
    expect(headerQ.matches).toHaveLength(24);
    expect(headerQ.matches[0].line).toBe(3);
  });

  it('decodes Windows-1251 Russian code artifacts cleanly without throwing', async () => {
    const cp1251FileId = 'cp1251-artifact';
    const url = `files/owner/code-artifacts/topic_1/${cp1251FileId}/Module_CP1251.bas`;
    // "Sub Тест()\r\n' Привет\r\nEnd Sub\r\n" in Windows-1251
    const cp1251Bytes = Buffer.from([
      0x53, 0x75, 0x62, 0x20, 0xd2, 0xe5, 0xf1, 0xf2, 0x28, 0x29, 0x0d, 0x0a, 0x27, 0x20, 0xcf,
      0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a, 0x45, 0x6e, 0x64, 0x20, 0x53, 0x75, 0x62, 0x0d,
      0x0a,
    ]);
    sources.set(url, cp1251Bytes);
    await db.insert(files).values({
      clientId: 'arckep-text-file/v1/topic_1/doc-cp1251/1',
      createdAt: new Date(Date.UTC(2026, 10, 10)),
      fileType: 'text/plain',
      id: cp1251FileId,
      metadata: {
        textFile: {
          documentId: 'doc-cp1251',
          fileName: 'Module_CP1251.bas',
          part: 1,
          status: 'ready',
          topicId: 'topic_1',
        },
      },
      name: 'Module_CP1251.bas',
      size: cp1251Bytes.byteLength,
      url,
      userId: 'owner',
    });

    const result = await context({ fileId: cp1251FileId, startLine: 1 });
    expect(result.success).toBe(true);
    const boundary = result.content.indexOf('\n');
    const header = JSON.parse(result.content.slice(0, boundary));
    const body = result.content.slice(boundary + 1);
    expect(header.lineEnding).toBe('CRLF');
    expect(header.totalLines).toBe(3);
    expect(body).toBe("L1: Sub Тест()\nL2: ' Привет\nL3: End Sub");
  });
});
