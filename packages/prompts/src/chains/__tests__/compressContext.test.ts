import type { UIChatMessage } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import { compressContextSystemPrompt } from '../../prompts';
import { chainCompressContext, type CompressContextOptions } from '../compressContext';

const makeMessage = (overrides: Partial<UIChatMessage> & { id: string }): UIChatMessage =>
  ({
    content: '',
    createdAt: 1_700_000_000_000,
    meta: {},
    role: 'user',
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }) as UIChatMessage;

describe('chainCompressContext', () => {
  it('remains backward-compatible with 1-arg calls and omits <existing_summary>', () => {
    const messages: UIChatMessage[] = [
      makeMessage({
        content: 'Inspect the contract draft.',
        fileList: [
          {
            fileType: 'application/pdf',
            id: 'file-1',
            name: 'contract.pdf',
            size: 1024,
            url: '/files/contract.pdf',
          },
        ],
        id: 'msg-1',
        role: 'user',
      }),
      makeMessage({
        content: 'Calling tool.',
        id: 'msg-2',
        role: 'assistant',
        tools: [
          {
            apiName: 'readKnowledge',
            arguments: '{"fileId":"file-1"}',
            id: 'call-1',
            identifier: 'lobe-knowledge-base',
            type: 'builtin',
          },
        ],
      }),
    ];

    const payload = chainCompressContext(messages);

    expect(payload.messages).toHaveLength(2);
    expect(payload.messages?.[0]).toEqual({
      content: compressContextSystemPrompt,
      role: 'system',
    });

    const userContent = String(payload.messages?.[1]?.content ?? '');
    expect(userContent).not.toContain('<existing_summary>');
    expect(userContent).toContain('<chat_history>');
    expect(userContent).toContain('[source_message_id: msg-1]');
    expect(userContent).toContain('[source_message_id: msg-2]');
    expect(userContent).toContain('Tool calls:');
    expect(userContent).toContain('<original_files>');
    expect(userContent).toContain('"fileId":"file-1"');
  });

  it('supports string 2nd arg and prepends <existing_summary> before <chat_history>', () => {
    const messages: UIChatMessage[] = [
      makeMessage({ content: 'Follow-up turn', id: 'msg-3', role: 'user' }),
    ];

    const payload = chainCompressContext(messages, '  Prior verified facts and decisions.  ');
    const userContent = String(payload.messages?.[1]?.content ?? '');

    const summaryIdx = userContent.indexOf('<existing_summary>');
    const summaryEndIdx = userContent.indexOf('</existing_summary>');
    const historyIdx = userContent.indexOf('<chat_history>');

    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(summaryEndIdx).toBeGreaterThan(summaryIdx);
    expect(historyIdx).toBeGreaterThan(summaryEndIdx);
    expect(userContent).toContain(
      '<existing_summary>\nPrior verified facts and decisions.\n</existing_summary>',
    );
  });

  it('omits <existing_summary> when string or options.existingSummary is blank/whitespace', () => {
    const messages: UIChatMessage[] = [
      makeMessage({ content: 'Hello', id: 'msg-1', role: 'user' }),
    ];

    const fromBlankString = String(
      chainCompressContext(messages, '   \n\t  ').messages?.[1]?.content,
    );
    const fromBlankOption = String(
      chainCompressContext(messages, { existingSummary: '  ' }).messages?.[1]?.content,
    );

    expect(fromBlankString).not.toContain('<existing_summary>');
    expect(fromBlankOption).not.toContain('<existing_summary>');
  });

  it('accepts CompressContextOptions and preserves earlier fileIds via priorMessages', () => {
    const priorCompressedGroup = makeMessage({
      compressedMessages: [
        makeMessage({
          content: 'Uploaded earlier spec.',
          fileList: [
            {
              fileType: 'text/markdown',
              id: 'file-old-1',
              name: 'spec.md',
              size: 512,
              url: '/files/spec.md',
            },
          ],
          id: 'msg-old-1',
          role: 'user',
        }),
      ],
      content: 'Earlier rolling summary.',
      fileList: [
        {
          fileType: 'text/csv',
          id: 'file-old-2',
          name: 'metrics.csv',
          size: 256,
          url: '/files/metrics.csv',
        },
      ],
      id: 'group-1',
      role: 'compressedGroup',
    });

    const newMessages: UIChatMessage[] = [
      makeMessage({
        content: 'Uploaded addendum.',
        fileList: [
          {
            fileType: 'text/markdown',
            id: 'file-old-1',
            name: 'spec.md',
            size: 512,
            url: '/files/spec.md',
          },
          {
            fileType: 'application/pdf',
            id: 'file-new-3',
            name: 'addendum.pdf',
            size: 2048,
            url: '/files/addendum.pdf',
          },
        ],
        id: 'msg-new-1',
        role: 'user',
      }),
    ];

    const options: CompressContextOptions = {
      existingSummary: 'Earlier rolling summary.',
      priorMessages: [priorCompressedGroup],
    };

    const payload = chainCompressContext(newMessages, options);
    const userContent = String(payload.messages?.[1]?.content ?? '');

    expect(userContent).toContain(
      '<existing_summary>\nEarlier rolling summary.\n</existing_summary>',
    );
    expect(userContent.indexOf('<existing_summary>')).toBeLessThan(
      userContent.indexOf('<chat_history>'),
    );
    expect(userContent).toContain('<original_files>');
    expect(userContent).toContain('"fileId":"file-old-1"');
    expect(userContent).toContain('"fileId":"file-old-2"');
    expect(userContent).toContain('"fileId":"file-new-3"');
    // Deduplicated across priorMessages and new messages
    expect(userContent.match(/file-old-1/g)).toHaveLength(1);
  });

  it('handles consolidating prior summaries when messages array is empty', () => {
    const priorGroup = makeMessage({
      compressedMessages: [
        makeMessage({
          fileList: [
            {
              fileType: 'text/plain',
              id: 'file-legacy-1',
              name: 'notes.txt',
              size: 100,
              url: '/files/notes.txt',
            },
          ],
          id: 'msg-legacy-1',
          role: 'user',
        }),
      ],
      content: 'Legacy summary part 1',
      id: 'legacy-group-1',
      role: 'compressedGroup',
    });

    const payload = chainCompressContext([], {
      existingSummary: 'Legacy summary part 1\n\nLegacy summary part 2',
      priorMessages: [priorGroup],
    });
    const userContent = String(payload.messages?.[1]?.content ?? '');

    expect(userContent).toContain(
      '<existing_summary>\nLegacy summary part 1\n\nLegacy summary part 2\n</existing_summary>',
    );
    expect(userContent).toContain('"fileId":"file-legacy-1"');
  });

  it('includes rolling consolidation, fidelity, and length ceiling guidance in system prompt', () => {
    expect(compressContextSystemPrompt).toContain('<existing_summary>');
    expect(compressContextSystemPrompt).toContain('<chat_history>');
    expect(compressContextSystemPrompt).toMatch(/duplicate sections/i);
    expect(compressContextSystemPrompt).toMatch(/superseded drafts/i);
    expect(compressContextSystemPrompt).toMatch(/source_message_id/);
    expect(compressContextSystemPrompt).toMatch(/fileIds/i);
    expect(compressContextSystemPrompt).toMatch(/never invent|extrapolate/i);
    expect(compressContextSystemPrompt).toMatch(/1,500-2,500 words/);
    expect(compressContextSystemPrompt).toMatch(/3,500 tokens/);
  });
});
