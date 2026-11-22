import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { FileLoaderInterface } from '../../types';
import { TextLoader } from './index';

const fixturePath = (filename: string) => path.join(__dirname, `./fixtures/${filename}`);

let loader: FileLoaderInterface;

const testFile = fixturePath('test.txt');

beforeEach(() => {
  loader = new TextLoader();
});

describe('TextLoader', () => {
  it('should load pages correctly', async () => {
    const pages = await loader.loadPages(testFile);
    expect(pages).toHaveLength(1);
    const page = pages[0];
    expect(page).toMatchSnapshot();
  });

  it('should aggregate content correctly', async () => {
    const pages = await loader.loadPages(testFile);
    const content = await loader.aggregateContent(pages);
    // Default aggregation joins with newline
    expect(content).toBe('Hello Text.\nSecond Line.\n');
  });

  it('should decode Windows-1251 Russian text without replacement characters', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'text-loader-cp1251-'));
    try {
      const cp1251Path = path.join(tmpDir, 'export_1c.txt');
      // "Начисления\r\nИтого: 100 руб.\r\n" encoded in Windows-1251
      const cp1251Bytes = Buffer.from([
        0xcd, 0xe0, 0xf7, 0xe8, 0xf1, 0xeb, 0xe5, 0xed, 0xe8, 0xff, 0x0d, 0x0a, 0xc8, 0xf2, 0xee,
        0xe3, 0xee, 0x3a, 0x20, 0x31, 0x30, 0x30, 0x20, 0xf0, 0xf3, 0xe1, 0x2e, 0x0d, 0x0a,
      ]);
      await writeFile(cp1251Path, cp1251Bytes);

      const pages = await loader.loadPages(cp1251Path);
      expect(pages).toHaveLength(1);
      expect(pages[0].pageContent).toBe('Начисления\r\nИтого: 100 руб.\r\n');
      expect(pages[0].pageContent).not.toContain('\uFFFD');
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  it('should handle file read errors in loadPages', async () => {
    const pages = await loader.loadPages(fixturePath('nonexistent.txt'));
    expect(pages).toHaveLength(1);
    expect(pages[0].metadata.error).toContain('Failed to load text file');
    expect(pages[0].pageContent).toBe('');
  });
});
