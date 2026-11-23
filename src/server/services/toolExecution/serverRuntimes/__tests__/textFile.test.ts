// @vitest-environment node
import { TopicReferenceIdentifier } from '@lobechat/builtin-tool-topic-reference';
import { TEXT_FILE_TOOL } from '@lobechat/builtin-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RECEIPT_PREFIX, TextFileError, TextFileStore } from '@/server/services/textFiles/store';

import { activatorRuntime } from '../activator';
import { textFileRuntime } from '../textFile';

vi.mock('@/server/services/file', () => ({
  FileService: class {},
}));

describe('textFileRuntime.patchFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes agentId and toolCallId, returns 5-key receipt + diff tail in content and checkpoint in state', async () => {
    const receipt = {
      documentId: '11111111-1111-5111-a111-111111111111',
      fileId: '22222222-2222-5222-a222-222222222222',
      fileName: 'Module1.bas',
      part: 2,
      status: 'ready' as const,
    };
    const diffSummary =
      'Patch applied: 1 edit, lines 10 -> 10 (+1 / -1), encoding utf-8 -> utf-8, lineEnding CRLF.\n@@ -1,1 +1,1 @@\n-old\n+new';
    const patchSpy = vi.spyOn(TextFileStore.prototype, 'patch').mockResolvedValue({
      appliedEdits: 1,
      appliedOccurrences: 1,
      diffSummary,
      lineEnding: 'CRLF',
      linesAfter: 10,
      linesBefore: 10,
      receipt,
      // eslint-disable-next-line unicorn/text-encoding-identifier-case
      sourceEncoding: 'utf-8',
    });

    const runtime = textFileRuntime.factory({
      agentId: 'ag-1',
      operationId: 'op-1',
      parentMessageId: 'msg-parent',
      serverDB: {} as any,
      studioTextFileEnabled: true,
      studioTextFileRequestId: 'req-1',
      toolManifestMap: {},
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const args = {
      documentId: receipt.documentId,
      edits: [{ newText: 'new', oldText: 'old' }],
    };
    const res = await runtime.patchFile(args, {
      agentId: 'ag-1',
      toolCallId: 'call_patch_42',
      toolManifestMap: {},
    });

    expect(patchSpy).toHaveBeenCalledWith('op-1', args, {
      agentId: 'ag-1',
      requestMessageId: 'req-1',
      toolCallId: 'call_patch_42',
    });
    expect(res).toEqual({
      content: RECEIPT_PREFIX + JSON.stringify(receipt) + '\n' + diffSummary,
      state: {
        documentId: receipt.documentId,
        part: 2,
        status: 'ready',
      },
      success: true,
    });
  });

  it('rejects when studioTextFileEnabled is false or studioTextFileContinueId does not match', async () => {
    const disabled = textFileRuntime.factory({
      parentMessageId: 'p1',
      serverDB: {} as any,
      studioTextFileEnabled: false,
      toolManifestMap: {},
      topicId: 't1',
      userId: 'u1',
    });
    const res1 = await disabled.patchFile({
      edits: [{ newText: 'b', oldText: 'a' }],
      sourceFileId: 'f1',
    });
    expect(res1.success).toBe(false);
    expect(res1.content).toContain('"reason":"not_found"');
    expect(res1.error).toMatchObject({ code: 'INVALID_ARGUMENT' });

    const mismatch = textFileRuntime.factory({
      parentMessageId: 'p1',
      serverDB: {} as any,
      studioTextFileContinueId: '11111111-1111-5111-a111-111111111111',
      studioTextFileEnabled: true,
      toolManifestMap: {},
      topicId: 't1',
      userId: 'u1',
    });
    const res2 = await mismatch.patchFile({
      documentId: '99999999-9999-5999-a999-999999999999',
      edits: [{ newText: 'b', oldText: 'a' }],
    });
    expect(res2.success).toBe(false);
    expect(res2.content).toContain('"reason":"part_conflict"');
  });

  it('returns per-edit diagnostics and non-retryable INVALID_ARGUMENT error on patch_failed', async () => {
    const diagnostics = [
      { code: 'not_found' as const, index: 0, message: 'oldText was not found.', ok: false },
    ];
    vi.spyOn(TextFileStore.prototype, 'patch').mockRejectedValue(
      new TextFileError('patch_failed', 'Atomic patch rejected', diagnostics),
    );

    const runtime = textFileRuntime.factory({
      parentMessageId: 'p1',
      serverDB: {} as any,
      studioTextFileEnabled: true,
      toolManifestMap: {},
      topicId: 't1',
      userId: 'u1',
    });
    const res = await runtime.patchFile({
      edits: [{ newText: 'b', oldText: 'missing' }],
      sourceFileId: 'f1',
    });
    expect(res.success).toBe(false);
    expect(res.error).toEqual({ code: 'INVALID_ARGUMENT', message: 'patch_failed' });
    const parsed = JSON.parse(res.content.slice('ARCKEP_TEXT_FILE_ERROR_V1\n'.length));
    expect(parsed).toMatchObject({
      diagnostics,
      message: 'Atomic patch rejected',
      reason: 'patch_failed',
    });
  });

  it('returns detailsMessage on size_limit so the model does not retry patchFile on >2 MiB files', async () => {
    const sizeMsg =
      'File size (3145728 bytes) exceeds the 2 MiB (2097152 bytes) ceiling for patchFile. Do not retry patchFile or split edits on this file — run a script in the E2B sandbox.';
    vi.spyOn(TextFileStore.prototype, 'patch').mockRejectedValue(
      new TextFileError('size_limit', sizeMsg),
    );

    const runtime = textFileRuntime.factory({
      parentMessageId: 'p1',
      serverDB: {} as any,
      studioTextFileEnabled: true,
      toolManifestMap: {},
      topicId: 't1',
      userId: 'u1',
    });
    const res = await runtime.patchFile({
      edits: [{ newText: 'b', oldText: 'a' }],
      sourceFileId: 'f_big',
    });
    expect(res.success).toBe(false);
    expect(res.error).toEqual({ code: 'INVALID_ARGUMENT', message: 'size_limit' });
    const parsed = JSON.parse(res.content.slice('ARCKEP_TEXT_FILE_ERROR_V1\n'.length));
    expect(parsed).toEqual({
      message: sizeMsg,
      reason: 'size_limit',
    });
  });
});

describe('activatorRuntime co-activation for arckep-text-file', () => {
  it('co-activates lobe-topic-reference when arckep-text-file is activated and both exist in manifestMap', async () => {
    const manifest = (id: string, apiName: string) =>
      ({
        api: [
          { description: 'desc', name: apiName, parameters: { properties: {}, type: 'object' } },
        ],
        identifier: id,
        meta: { title: id },
        type: 'builtin',
      }) as any;

    const runtime = await activatorRuntime.factory({
      toolManifestMap: {
        [TEXT_FILE_TOOL]: manifest(TEXT_FILE_TOOL, 'patchFile'),
        [TopicReferenceIdentifier]: manifest(TopicReferenceIdentifier, 'getTopicContext'),
      },
    });

    const result = await runtime.activateTools({ identifiers: [TEXT_FILE_TOOL] });
    expect(result.success).toBe(true);
    expect(result.state?.activatedTools.map((t: any) => t.identifier)).toEqual([
      TEXT_FILE_TOOL,
      TopicReferenceIdentifier,
    ]);
  });

  it('does not co-activate lobe-topic-reference if it is absent from manifestMap', async () => {
    const runtime = await activatorRuntime.factory({
      toolManifestMap: {
        [TEXT_FILE_TOOL]: {
          api: [
            {
              description: 'desc',
              name: 'patchFile',
              parameters: { properties: {}, type: 'object' },
            },
          ],
          identifier: TEXT_FILE_TOOL,
          meta: { title: TEXT_FILE_TOOL },
          type: 'builtin',
        } as any,
      },
    });

    const result = await runtime.activateTools({ identifiers: [TEXT_FILE_TOOL] });
    expect(result.success).toBe(true);
    expect(result.state?.activatedTools.map((t: any) => t.identifier)).toEqual([TEXT_FILE_TOOL]);
  });
});
