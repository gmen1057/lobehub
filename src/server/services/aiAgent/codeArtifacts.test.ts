import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveLongCodeArtifacts } from './codeArtifacts';

const FILE_ID = 'f994edcd-bfb3-4d15-9ceb-924f63675569';
const VERSION_ID = 'fe7ae39d-53f3-4f40-9c52-5d1e6abaf284';
const uploadFromBuffer = vi.fn();
const options = {
  fileService: () => ({ uploadFromBuffer }),
  messageId: 'first',
  topicId: 'tpc_1',
  userId: 'usr_1',
};
const lines = Array.from({ length: 26 }, (_, i) => `  Debug.Print "строка ${i}"  `);
const block = (language: string, source: string, fence = '```') =>
  `${fence}${language}\n${source}\n${fence}`;

describe('automatic code artifacts', () => {
  beforeEach(() => {
    uploadFromBuffer.mockReset();
    uploadFromBuffer.mockResolvedValue({ fileId: FILE_ID });
  });

  it('saves exact UTF-8 source bytes and emits a private code artifact between surrounding prose', async () => {
    const source = ['Attribute VB_Name = "ModuleX"', 'Sub Example()', ...lines, 'End Sub', ''].join(
      '\r\n',
    );
    const input = ['Готовый модуль.', '', '````vba', source + '`````  ', '', 'Готово.'].join(
      '\r\n',
    );
    const output = await saveLongCodeArtifacts(input, options);
    expect(uploadFromBuffer).toHaveBeenCalledOnce();
    const [buffer, mime, key, uploadOptions] = uploadFromBuffer.mock.calls[0];
    const { codeArtifact } = uploadOptions.metadata;
    expect(buffer.equals(Buffer.from(source, 'utf8'))).toBe(true);
    expect(mime).toBe('text/plain; charset=utf-8');
    expect(uploadOptions.privateFile).toBe(true);
    expect(uploadOptions.skipGlobalDedup).toBe(true);
    expect(key).toMatch(/^files\/usr_1\/code-artifacts\/tpc_1\/[\da-f-]+\/ModuleX\.bas$/);
    expect(codeArtifact).toEqual({
      identifier: expect.stringMatching(/^code-vb-[a-f\d]{24}$/),
      language: 'vb',
      messageId: 'first',
      title: 'ModuleX.bas',
      topicId: 'tpc_1',
    });
    expect(output).toBe(
      `Готовый модуль.\r\n\r\n<lobeArtifact type="application/lobe.artifacts.code" identifier="${codeArtifact.identifier}" title="ModuleX.bas" language="vb" src="/chat/code-artifact/${FILE_ID}/"></lobeArtifact>\r\n\r\nГотово.`,
    );
  });

  it('groups named VBA revisions and gives them separate immutable storage keys and IDs', async () => {
    uploadFromBuffer
      .mockResolvedValueOnce({ fileId: FILE_ID })
      .mockResolvedValueOnce({ fileId: VERSION_ID });
    const original = await saveLongCodeArtifacts(
      block('vba', ['Attribute VB_Name = "ModuleX"', ...lines].join('\n')),
      options,
    );
    const revised = await saveLongCodeArtifacts(
      block('vb', ['Attribute VB_Name = "modulex"', ...lines, 'End Sub'].join('\n')),
      { ...options, messageId: 'next' },
    );
    const [first, second] = uploadFromBuffer.mock.calls;
    expect(first[3].metadata.codeArtifact.identifier).toBe(
      second[3].metadata.codeArtifact.identifier,
    );
    expect(first[2]).not.toBe(second[2]);
    expect(original).toContain(FILE_ID);
    expect(revised).toContain(VERSION_ID);
    expect(first[0].equals(second[0])).toBe(false);
  });

  it('keeps anonymous scripts separate and recognizes a longer closing delimiter', async () => {
    const fullSource = [...lines.slice(0, 7), '```', ...lines.slice(7)].join('\n');
    const input = block('python', fullSource, '````');
    await saveLongCodeArtifacts(`${input}\n\n${input}`, options);
    await saveLongCodeArtifacts(input, { ...options, messageId: 'next' });
    await saveLongCodeArtifacts(input, { ...options, contentPartIndex: 1 });
    await saveLongCodeArtifacts(input, { ...options, contentPartIndex: 2 });
    const calls = uploadFromBuffer.mock.calls;
    expect(calls.every(([source]) => source.equals(Buffer.from(`${fullSource}\n`)))).toBe(true);
    const artifacts = calls.map(([, , , options]) => options.metadata.codeArtifact);
    expect(new Set(artifacts.map((artifact) => artifact.identifier)).size).toBe(5);
    expect(artifacts.slice(-2).map((artifact) => artifact.messageId)).toEqual(['first', 'first']);
  });

  it('uses a compatible bare fence filename as the same VBA module identity', async () => {
    await saveLongCodeArtifacts(block('vba ModuleX.bas', lines.join('\n')), options);
    await saveLongCodeArtifacts(
      block('vb', ['Attribute VB_Name = "ModuleX"', ...lines].join('\n')),
      { ...options, messageId: 'next' },
    );
    await saveLongCodeArtifacts(block('vb ModuleX.html', lines.join('\n')), options);
    const artifacts = uploadFromBuffer.mock.calls.map(
      ([, , , options]) => options.metadata.codeArtifact,
    );
    expect(artifacts[0].title).toBe('ModuleX.bas');
    expect(artifacts[0].identifier).toBe(artifacts[1].identifier);
    expect(artifacts[2].title).toBe('code.bas');
    expect(artifacts[2].identifier).not.toBe(artifacts[0].identifier);
  });

  it.each([
    block('html', lines.join('\n')),
    block('svg', lines.join('\n')),
    block('python', 'print("one line")'),
    block('python example', lines.join('\n')),
    `### Пример\n\n${block('python', lines.join('\n'))}`,
    ['```python', ...lines].join('\n'),
    ['````python', ...lines, '```'].join('\n'),
    block('python', lines.join('\n'))
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  ])('leaves snippets, markup, examples and unfinished fences inline (%#)', async (input) => {
    expect(await saveLongCodeArtifacts(input, options)).toBe(input);
    expect(uploadFromBuffer).not.toHaveBeenCalled();
  });

  it('retains failed blocks and persists other complete blocks in the same reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      uploadFromBuffer.mockRejectedValueOnce(new Error('storage unavailable'));
      const failed = block('python', lines.join('\n'));
      const output = await saveLongCodeArtifacts(
        `${failed}\n\n${block('ts', lines.join('\n'), '~~~')}`,
        options,
      );
      expect(output).toContain(failed);
      expect(output).toContain(`language="typescript" src="/chat/code-artifact/${FILE_ID}/"`);
    } finally {
      warn.mockRestore();
    }
  });

  it('returns the original reply when cancelled before or during upload', async () => {
    const input = block('python', lines.join('\n'));
    const controller = new AbortController();
    controller.abort();
    expect(await saveLongCodeArtifacts(input, { ...options, signal: controller.signal })).toBe(
      input,
    );
    expect(uploadFromBuffer).not.toHaveBeenCalled();

    const duringUpload = new AbortController();
    uploadFromBuffer.mockImplementationOnce(async () => {
      duringUpload.abort();
      return { fileId: FILE_ID };
    });
    expect(await saveLongCodeArtifacts(input, { ...options, signal: duringUpload.signal })).toBe(
      input,
    );
  });
});
