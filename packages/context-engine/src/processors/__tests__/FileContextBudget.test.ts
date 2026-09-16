import { describe, expect, it } from 'vitest';

import { MessagesEngine } from '../../engine/messages/MessagesEngine';

describe('attachment budget across the final message pipeline', () => {
  it('bounds many historical attachments without changing user questions or losing file IDs', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `msg-${i}`,
      role: 'user' as const,
      content: `Exact question ${i}`,
      createdAt: i,
      updatedAt: i,
      fileList: [
        {
          id: `file-${i}`,
          name: 'contacts.vcf',
          fileType: 'text/vcard',
          size: 100_000,
          content: 'X'.repeat(100_000),
          url: '/original',
        },
      ],
    }));
    const result = await new MessagesEngine({
      model: 'test',
      provider: 'test',
      messages,
    }).process();
    const output = JSON.stringify(result.messages);
    expect(output.length).toBeLessThan(60_000);
    for (let i = 0; i < 20; i++) {
      expect(output).toContain(`Exact question ${i}`);
      expect(output).toContain(`file-${i}`);
    }
    expect(messages[0].fileList[0].content.length).toBe(100_000);
    expect(JSON.stringify(result.messages.at(-1))).toContain('X'.repeat(100));
  });

  it('keeps deterministic original-file and archive access after compression', async () => {
    const result = await new MessagesEngine({
      model: 'test',
      provider: 'test',
      messages: [
        {
          id: 'summary',
          role: 'compressedGroup',
          content: 'A short summary that omitted the attachment ID',
          topicId: 'topic-original',
          createdAt: 1,
          updatedAt: 1,
          compressedMessages: [
            {
              role: 'user',
              id: 'original',
              content: 'See file',
              fileList: [{ id: 'file-keep', name: 'contacts.vcf' }],
            },
          ],
        },
      ] as any,
    }).process();
    const output = JSON.stringify(result.messages);
    expect(output).toContain('file-keep');
    expect(output).toContain('getTopicContext');
    expect(output).toContain('topic-original');
  });
});
