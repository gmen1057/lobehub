import { execFile } from 'node:child_process';
import os from 'node:os';

import debug from 'debug';

const log = debug('lobe-server:poppler');

/**
 * arckep (19.10.2026): запуск программ poppler (pdfinfo, pdftoppm, pdfimages) для PDF от людей. Отдельным
 * процессом, под prlimit: память (виртуальная, ARCKEP_PDF_MEMORY_MB, по умолчанию 2048, 0 — без предела),
 * размер записываемого файла и процессорное время — чужой PDF с огромной страницей или «бомбой» упирается в
 * предел и падает, а не съедает память и диск хоста. Нет prlimit на хосте — запуск без него.
 */

export type PopplerProgram = 'pdfimages' | 'pdfinfo' | 'pdftoppm';

const ENV_NAMES: Record<PopplerProgram, string> = {
  pdfimages: 'PDFIMAGES_BIN',
  pdfinfo: 'PDFINFO_BIN',
  pdftoppm: 'PDFTOPPM_BIN',
};

/** Путь к программе: переменная окружения (PDFINFO_BIN и т. п.) или имя из PATH. */
export const popplerBin = (name: PopplerProgram): string => process.env[ENV_NAMES[name]] || name;

const memoryLimitBytes = () => {
  const mb = Number(process.env.ARCKEP_PDF_MEMORY_MB ?? 2048);
  return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
};

/** Самый большой файл, который poppler может записать за один запуск. */
const MAX_WRITE_BYTES = 256 * 1024 * 1024;

const exec = (file: string, args: string[], timeout: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 8 * 1024 * 1024, timeout }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    // Не мешаем остальным службам на хосте: низкий приоритет
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // приоритет не обязателен
    }
  });

export const runPoppler = async (
  file: string,
  args: string[],
  timeout: number,
  /** maxFileBytes — предел одного записываемого файла (по умолчанию 256 МБ) */
  options: { maxFileBytes?: number } = {},
): Promise<string> => {
  const memory = memoryLimitBytes();
  if (memory > 0) {
    try {
      return await exec(
        'prlimit',
        [
          `--as=${memory}`,
          `--fsize=${options.maxFileBytes ?? MAX_WRITE_BYTES}`,
          `--cpu=${Math.ceil(timeout / 1000) + 5}`,
          '--',
          file,
          ...args,
        ],
        timeout,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      log('prlimit is not available, running without limits');
    }
  }
  return exec(file, args, timeout);
};
