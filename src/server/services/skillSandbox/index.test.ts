// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  base64DecodedSize,
  buildCommandProgram,
  parseCommandOutput,
  safeRelativePath,
  SANDBOX_MAX_UPLOAD_BYTES,
  skillFolderName,
  SkillSandbox,
} from './index';

const MARKER = '\u0001ARCKEP_RESULT\u0001';

const hasPython = spawnSync('python3', ['--version']).status === 0;

/** Запуск программы так, как это делает песочница: `python3 -c`, домашняя папка — временная. */
const runProgram = (code: string) => {
  const home = mkdtempSync(path.join(tmpdir(), 'skill-sandbox-'));
  const run = spawnSync('python3', ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  });
  return { home, run };
};

const jsonRpc = (text: string, isError = false) =>
  new Response(JSON.stringify({ id: 1, jsonrpc: '2.0', result: { content: [{ text }], isError } }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('base64DecodedSize', () => {
  it.each([
    ['', 0],
    ['aGk=', 2],
    ['aGVsbG8=', 5],
    ['aGVsbG8h', 6],
    ['YQ==', 1],
  ])('%j → %d байт', (base64, size) => {
    expect(base64DecodedSize(base64)).toBe(size);
    expect(Buffer.from(base64, 'base64').length).toBe(size);
  });
});

describe('safeRelativePath', () => {
  it('пропускает обычные относительные пути', () => {
    expect(safeRelativePath('scripts/build.py')).toBe('scripts/build.py');
    expect(safeRelativePath('./SKILL.md')).toBe('SKILL.md');
    expect(safeRelativePath('a\\b.txt')).toBe('a/b.txt');
  });

  it.each(['', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\u0000b', '..'])(
    'отклоняет %j',
    (path) => {
      expect(safeRelativePath(path)).toBeNull();
    },
  );
});

describe('skillFolderName', () => {
  it('оставляет безопасные знаки', () => {
    expect(skillFolderName('github.anthropics.skills.pdf')).toBe('github.anthropics.skills.pdf');
    expect(skillFolderName('user.abc/../x y')).toBe('user.abc_.._x_y');
    expect(skillFolderName('...')).toBe('skill');
  });
});

describe('parseCommandOutput', () => {
  it('разбирает результат с меткой и берёт последний', () => {
    const text = `шум\n${MARKER}${JSON.stringify({ exit: 0, stderr: 'warn', stdout: 'ok\n' })}\n`;
    expect(parseCommandOutput(text)).toEqual({
      exitCode: 0,
      output: 'ok\n',
      stderr: 'warn',
      success: true,
    });
  });

  it('ненулевой код — неуспех', () => {
    const result = parseCommandOutput(
      `${MARKER}${JSON.stringify({ exit: 2, stderr: 'нет файла', stdout: '' })}`,
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('нет файла');
  });

  it('без метки — текст шлюза как ошибка', () => {
    const result = parseCommandOutput('\n[error]: NameError: x\n');
    expect(result).toMatchObject({ exitCode: 1, output: '', success: false });
    expect(result.stderr).toContain('NameError');
  });

  it('пустой вывод — понятная ошибка', () => {
    expect(parseCommandOutput('').stderr).toMatch(/no result/);
  });

  it('битый JSON не роняет разбор', () => {
    expect(parseCommandOutput(`${MARKER}{oops`).success).toBe(false);
  });
});

describe('buildCommandProgram', () => {
  it('команда уходит в base64: кавычки и переводы строк не ломают программу', () => {
    const program = buildCommandProgram({ command: `echo "it's \${HOME}"\nls` });
    expect(program).not.toContain("it's");
    expect(program).toContain('shell=True');
    expect(program).toContain('timeout=55');
  });

  it('папка запуска задаётся относительно домашней', () => {
    const program = buildCommandProgram({ command: 'ls', cwd: 'skills/pdf' });
    expect(program).toContain('os.path.join(os.path.expanduser("~"), "skills/pdf")');
  });

  it.runIf(hasPython)('выполняет команду и печатает результат с меткой (живой python3)', () => {
    const { home, run } = runProgram(
      buildCommandProgram({ command: `printf 'привет "мир"'; echo err >&2; exit 3` }),
    );
    try {
      const result = parseCommandOutput(run.stdout);
      expect(result).toEqual({
        exitCode: 3,
        output: 'привет "мир"',
        stderr: 'err\n',
        success: false,
      });
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  it.runIf(hasPython)(
    'раскладывает файлы навыка и запускает команду из их папки (живой python3)',
    () => {
      const files = [
        {
          content: new TextEncoder().encode(
            'print("из скрипта", open("data/in.txt").read().strip())',
          ),
          path: 'scripts/run.py',
        },
        { content: new TextEncoder().encode('42\n'), path: 'scripts/data/in.txt' },
      ];
      const { home, run } = runProgram(
        buildCommandProgram({ command: 'cd scripts && python3 run.py', cwd: 'skills/demo', files }),
      );
      try {
        const result = parseCommandOutput(run.stdout);
        expect(result.output.trim()).toBe('из скрипта 42');
        expect(result.success).toBe(true);
        expect(readFileSync(path.join(home, 'skills/demo/scripts/data/in.txt'), 'utf8')).toBe(
          '42\n',
        );
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it.runIf(hasPython)('команда дольше лимита останавливается с кодом 124 (живой python3)', () => {
    const { home, run } = runProgram(buildCommandProgram({ command: 'sleep 5', timeoutSec: 1 }));
    try {
      const result = parseCommandOutput(run.stdout);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('did not finish in 1 seconds');
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

describe('SkillSandbox', () => {
  const make = (fetchImpl: typeof fetch, extra: { arckepUserId?: string } = {}) =>
    new SkillSandbox({
      arckepUserId: '15',
      fetchImpl,
      gatewayUrl: 'http://gw.test/mcp/e2b-sandbox',
      topicId: 'tpc_1',
      ...extra,
    });

  it('шлёт execute_code с номером темы и человека', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRpc(`${MARKER}${JSON.stringify({ exit: 0, stderr: '', stdout: 'hi' })}`),
    );
    const sandbox = make(fetchImpl as unknown as typeof fetch, { arckepUserId: '15' });

    const result = await sandbox.runCommand('echo hi');

    expect(result).toMatchObject({ exitCode: 0, output: 'hi', success: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gw.test/mcp/e2b-sandbox');
    expect(init.headers).toMatchObject({ 'X-Arckep-Topic': 'tpc_1', 'X-Arckep-User': '15' });
    const body = JSON.parse(init.body as string);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('execute_code');
    expect(body.params.arguments.session_id).toBe('tpc_1');
    expect(body.params.arguments.code).toContain('subprocess.run');
  });

  it('текст ошибки шлюза (лимит, баланс) доходит до модели как stderr', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRpc('Error: Недостаточно средств на балансе. Пополните баланс.', true),
    );
    const result = await make(fetchImpl as unknown as typeof fetch).runCommand('ls');
    expect(result).toEqual({
      exitCode: 1,
      output: '',
      stderr: 'Error: Недостаточно средств на балансе. Пополните баланс.',
      success: false,
    });
  });

  it('HTTP-ошибка и обрыв сети — понятный stderr, не исключение', async () => {
    const http = vi.fn(async () => new Response('', { status: 502 }));
    expect((await make(http as unknown as typeof fetch).runCommand('ls')).stderr).toContain(
      'HTTP 502',
    );

    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await make(down as unknown as typeof fetch).runCommand('ls');
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('ECONNREFUSED');
  });

  it('слишком большие файлы навыка не уходят в песочницу', async () => {
    const fetchImpl = vi.fn();
    const big = { content: new Uint8Array(SANDBOX_MAX_UPLOAD_BYTES + 1), path: 'big.bin' };
    const result = await make(fetchImpl as unknown as typeof fetch).runCommand('ls', {
      cwd: 'skills/x',
      files: [big],
    });
    expect(result.success).toBe(false);
    expect(result.stderr).toContain('too large');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('X-Arckep-User уходит в каждом вызове: без него шлюз не мог бы списать деньги', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonRpc(JSON.stringify({ content_base64: '', success: true })),
    );
    await make(fetchImpl as unknown as typeof fetch).readFile('a');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ 'X-Arckep-User': '15' });
  });

  it('ответ шлюза на команду сверх предела не читается целиком (поток обрывается)', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
        if (pulled > 200) controller.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body));

    const result = await make(fetchImpl as unknown as typeof fetch).runCommand('yes');

    expect(result.success).toBe(false);
    expect(result.stderr).toContain('too large');
    // читали ровно до предела (8 МБ), а не все 200 МБ
    expect(pulled).toBeLessThan(20);
  });

  it('заголовок Content-Length сверх предела отбрасывает ответ до чтения тела', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { headers: { 'content-length': String(500 * 1024 * 1024) } }),
    );
    const result = await make(fetchImpl as unknown as typeof fetch).readFile('big.bin');
    expect(result).toEqual({
      message: expect.stringContaining('too large to export'),
      ok: false,
    });
  });

  it('readFile: возвращает файл, а текст «не найден» — ошибкой', async () => {
    const found = vi.fn(async () =>
      jsonRpc(
        JSON.stringify({ content_base64: 'aGk=', filename: 'a.txt', size: 2, success: true }),
      ),
    );
    expect(await make(found as unknown as typeof fetch).readFile('out/a.txt')).toEqual({
      base64: 'aGk=',
      filename: 'a.txt',
      ok: true,
      size: 2,
    });
    const body = JSON.parse(
      (found.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(body.params.name).toBe('read_file');
    expect(body.params.arguments).toMatchObject({ path: 'out/a.txt', session_id: 'tpc_1' });

    const missing = vi.fn(async () => jsonRpc('File not found: out/b.txt'));
    expect(await make(missing as unknown as typeof fetch).readFile('out/b.txt')).toEqual({
      message: 'File not found: out/b.txt',
      ok: false,
    });
  });
});
