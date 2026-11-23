import type { CommandResult } from '@lobechat/builtin-tool-skills';
import debug from 'debug';

import type { SandboxBridgeContext } from '@/server/services/sandboxWorkspace/bridge';
import {
  appendSandboxBridgeTrailer,
  getActiveSandboxBridgeContext,
  hasActiveSandboxBridgeScope,
  prepareSandboxBridgeSession,
  sanitizeBridgeArgumentsObject,
} from '@/server/services/sandboxWorkspace/bridge';
import { extractAndStripArckepSync } from '@/server/services/sandboxWorkspace/commitSync';
import { resolveEffectiveTopicGuardAndAgent } from '@/server/services/sandboxWorkspace/manifest';

const log = debug('lobe-server:skill-sandbox');

/**
 * arckep (19.10.2026): команды навыков (`runCommand`, `execScript`, `exportFile`) в движке без интерфейса
 * идут в песочницу E2B через наш шлюз коннекторов — туда же, куда ходит `execute_code` у подключения
 * `mcp-arckep-e2b-sandbox`. Апстримный путь (`market.plugins.runBuildInTool`) ведёт в облако LobeHub, которого
 * у нас нет. Песочница одна на тему (ключ — номер темы), файлы между вызовами сохраняются; платит человек
 * (этап 1 ТЗ chat-skills-tools: шлюз считает время и списывает по X-Arckep-User).
 */

const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8410/mcp/e2b-sandbox';

/** Предел одной команды в песочнице; шлюз выполняет код с таймаутом E2B около 60 с, оставляем запас. */
export const SANDBOX_COMMAND_TIMEOUT_SEC = 55;
/** Предел одной команды в видеопесочнице Remotion (сборка и рендер MP4 в Chromium + FFmpeg занимают до 2–3 мин). */
export const SANDBOX_REMOTION_TIMEOUT_SEC = 170;
const GATEWAY_TIMEOUT_MS = 110_000;
const GATEWAY_REMOTION_TIMEOUT_MS = 200_000;

/** Сколько байт файлов навыка можно скопировать в песочницу одним вызовом (они едут в коде base64). */
export const SANDBOX_MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
/** Предел файла, который забираем из песочницы (шлюз отдаёт его base64 внутри JSON). */
export const SANDBOX_MAX_EXPORT_BYTES = 25 * 1024 * 1024;
/** Предел ответа шлюза на команду (stdout+stderr): команда, печатающая гигабайты, не должна съесть память движка. */
const GATEWAY_COMMAND_RESPONSE_LIMIT = 8 * 1024 * 1024;
/** Ответ на read_file: base64 файла (×4/3) плюс обёртка JSON. */
const GATEWAY_FILE_RESPONSE_LIMIT = Math.ceil((SANDBOX_MAX_EXPORT_BYTES * 4) / 3) + 4096;

/** Файл по длине base64 (без декодирования): `=` в конце уменьшают размер. */
export const base64DecodedSize = (base64: string): number => {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

/**
 * Тело ответа не больше `maxBytes`: длина из заголовка проверяется до чтения, а само чтение идёт потоком
 * и обрывается на пределе — не `response.json()` по неограниченному телу. `null` — предел превышен.
 */
const readCappedText = async (response: Response, maxBytes: number): Promise<string | null> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }

  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text) > maxBytes ? null : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

/** Метка перед JSON-результатом команды в выводе шлюза; управляющие знаки в обычном выводе не встречаются. */
const RESULT_MARKER = '\u0001ARCKEP_RESULT\u0001';

export interface SandboxFile {
  content: Uint8Array;
  /** Относительный путь внутри папки навыка */
  path: string;
}

export type SandboxFileRead =
  { base64: string; filename: string; ok: true; size: number } | { message: string; ok: false };

export interface SkillSandboxOptions {
  /** Доступ песочницы к интернету (выводится сервером из настройки веб-поиска). */
  allowInternet?: boolean;
  /**
   * Номер человека в студии (X-Arckep-User): по нему шлюз считает деньги и квоты. Обязателен: без него
   * песочница работала бы неучтённо, поэтому вызывающий не создаёт SkillSandbox для чужих аккаунтов.
   */
  arckepUserId: string;
  /** Опциональный контекст файлового моста S3 ↔ /workspace (в ToolExecutionService передаётся и через AsyncLocalStorage). */
  bridgeContext?: SandboxBridgeContext;
  /** Режим Data Guard: принудительно закрывает интернет и передаёт X-Arckep-Data-Guard: '1'. */
  dataGuard?: boolean;
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  topicId: string;
}

/** Путь внутри папки навыка: только относительный, без `..` и управляющих знаков. */
export const safeRelativePath = (path: string): string | null => {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F]/.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  return normalized;
};

/** Имя папки навыка в песочнице. */
export const skillFolderName = (identifier: string): string => {
  const cleaned = identifier
    .replaceAll(/[^\w.-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'skill';
};

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64');

/**
 * Питон-программа для `execute_code`: (по желанию) раскладывает файлы навыка, выполняет команду через
 * оболочку и печатает одну строку `метка + JSON` с кодом возврата, stdout и stderr.
 */
export const buildCommandProgram = (options: {
  command: string;
  /** Папка запуска (относительно домашней или абсолютный путь вида `/workspace/project`); без неё — `/workspace` */
  cwd?: string;
  files?: SandboxFile[];
  timeoutSec?: number;
}): string => {
  const timeoutSec = options.timeoutSec ?? SANDBOX_COMMAND_TIMEOUT_SEC;
  const hasExplicitCwd = Boolean(options.cwd);
  const root = options.cwd
    ? options.cwd.startsWith('/')
      ? JSON.stringify(options.cwd)
      : `os.path.join(os.path.expanduser("~"), ${JSON.stringify(options.cwd)})`
    : '"/workspace"';
  const payload = (options.files ?? []).map((file) => [file.path, b64(file.content)]);

  return `import base64, json, os, subprocess
_M = "\\x01ARCKEP_RESULT\\x01"
def _out(code, out, err):
    print(_M + json.dumps({"exit": code, "stdout": out, "stderr": err}, ensure_ascii=False))
try:
    _root = ${root}
${
  hasExplicitCwd
    ? ''
    : `    if not os.path.isdir(_root):
        _root = os.path.expanduser("~")
`
}    os.makedirs(_root, exist_ok=True)
${
  payload.length > 0
    ? `    for _p, _b in json.loads(base64.b64decode("${b64(JSON.stringify(payload))}").decode()):
        _f = os.path.join(_root, _p)
        os.makedirs(os.path.dirname(_f), exist_ok=True)
        with open(_f, "wb") as _h:
            _h.write(base64.b64decode(_b))
`
    : ''
}    _env = os.environ.copy()
${
  options.cwd === '/workspace/project'
    ? ''
    : `    _pp = [p for p in _env.get("PYTHONPATH", "").split(":") if p]
    _head = [p for p in ("/workspace/project", "/workspace") if p not in _pp]
    if _head or _pp:
        _env["PYTHONPATH"] = ":".join(_head + _pp)
`
}    _r = subprocess.run(base64.b64decode("${b64(options.command)}").decode(), shell=True, capture_output=True, text=True, errors="replace", cwd=_root, env=_env, timeout=${timeoutSec})
    _out(_r.returncode, _r.stdout, _r.stderr)
except subprocess.TimeoutExpired:
    _out(124, "", "Command stopped: it did not finish in ${timeoutSec} seconds. Split the work into smaller steps.")
except Exception as _e:
    _out(1, "", "Could not run the command: %s" % _e)
`;
};

/** Разбор вывода `execute_code` в результат команды. */
export const parseCommandOutput = (text: string): CommandResult => {
  const at = text.lastIndexOf(RESULT_MARKER);
  if (at === -1) {
    // Питон упал до печати результата или шлюз вернул свою ошибку — отдаём как есть.
    return {
      exitCode: 1,
      output: '',
      stderr: text.trim() || 'The sandbox returned no result.',
      success: false,
    };
  }

  const line = text.slice(at + RESULT_MARKER.length).split('\n', 1)[0];
  try {
    const parsed = JSON.parse(line) as { exit?: number; stderr?: string; stdout?: string };
    const exitCode = typeof parsed.exit === 'number' ? parsed.exit : 1;
    return {
      exitCode,
      output: parsed.stdout ?? '',
      stderr: parsed.stderr ?? '',
      success: exitCode === 0,
    };
  } catch {
    return {
      exitCode: 1,
      output: '',
      stderr: 'The sandbox result could not be read.',
      success: false,
    };
  }
};

export class SkillSandbox {
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayUrl: string;

  constructor(private readonly options: SkillSandboxOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.gatewayUrl = options.gatewayUrl ?? process.env.E2B_GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  }

  /** Вызов инструмента шлюза; ошибки сети, шлюза и лимитов возвращаются текстом для модели. */
  private async call(
    toolName: string,
    args: Record<string, unknown>,
    maxResponseBytes: number = GATEWAY_COMMAND_RESPONSE_LIMIT,
  ): Promise<{ ok: true; receiptFooter?: string; text: string } | { message: string; ok: false }> {
    const cleanedArgs = sanitizeBridgeArgumentsObject(args);
    const isRemotion = cleanedArgs.template === 'remotion';
    const timeoutMs = isRemotion ? GATEWAY_REMOTION_TIMEOUT_MS : GATEWAY_TIMEOUT_MS;

    const rawBridgeCtx = this.options.bridgeContext ?? getActiveSandboxBridgeContext();
    const effectiveBridgeCtx: SandboxBridgeContext | undefined = rawBridgeCtx
      ? {
          ...rawBridgeCtx,
          dataGuardProtected: Boolean(this.options.dataGuard || rawBridgeCtx.dataGuardProtected),
          topicId: rawBridgeCtx.topicId ?? this.options.topicId,
        }
      : undefined;

    const bridgeSession =
      toolName === 'execute_code' && effectiveBridgeCtx
        ? await prepareSandboxBridgeSession({
            apiName: 'execute_code',
            argsObject: cleanedArgs,
            context: effectiveBridgeCtx,
          })
        : null;

    let effectiveDataGuard = Boolean(
      this.options.dataGuard ||
      effectiveBridgeCtx?.dataGuardProtected ||
      bridgeSession?.effectiveDataGuard,
    );
    if (!effectiveDataGuard && !bridgeSession && effectiveBridgeCtx?.serverDB) {
      const resolved = await resolveEffectiveTopicGuardAndAgent({
        agentId: effectiveBridgeCtx.agentId,
        dataGuardProtected: effectiveBridgeCtx.dataGuardProtected,
        serverDB: effectiveBridgeCtx.serverDB,
        topicId: effectiveBridgeCtx.topicId,
        userId: effectiveBridgeCtx.userId,
      });
      effectiveDataGuard = resolved.effectiveDataGuard;
    }

    const outgoingArgs = bridgeSession ? bridgeSession.argsObject : cleanedArgs;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Arckep-Allow-Internet': !effectiveDataGuard && this.options.allowInternet ? '1' : '0',
      'X-Arckep-Data-Guard': effectiveDataGuard ? '1' : '0',
      'X-Arckep-Topic': this.options.topicId,
      'X-Arckep-User': this.options.arckepUserId,
    };
    if (isRemotion) {
      headers['X-Arckep-Sandbox-Template'] = 'remotion';
    }
    try {
      const response = await this.fetchImpl(this.gatewayUrl, {
        body: JSON.stringify({
          id: Date.now(),
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            arguments: { ...outgoingArgs, session_id: this.options.topicId },
            name: toolName,
          },
        }),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        return { message: `The sandbox is unavailable (HTTP ${response.status}).`, ok: false };
      }

      const body = await readCappedText(response, maxResponseBytes);
      if (body === null) {
        return { message: 'The sandbox response is too large to read.', ok: false };
      }

      const data = JSON.parse(body) as {
        error?: { message?: string };
        result?: { content?: Array<{ text?: string }>; isError?: boolean };
      };
      if (data.error) return { message: data.error.message || 'Sandbox gateway error.', ok: false };

      const rawText = data.result?.content?.[0]?.text ?? '';
      const { cleanedText, syncReport } = extractAndStripArckepSync(rawText);
      if (data.result?.isError) {
        return { message: cleanedText || 'Sandbox gateway error.', ok: false };
      }

      let receiptFooter: string | undefined;
      if (syncReport && bridgeSession) {
        const committed = await bridgeSession.commitFromSyncReport(syncReport);
        const imageLines = committed.mediaBlocks.map((img) => `![](${img.data})`);
        const trailerParts = [
          ...committed.receiptFooter
            .split('\n')
            .filter((line) => Boolean(line) && !line.startsWith('ARCKEP_')),
          ...imageLines,
          ...committed.markerLines,
        ];
        const fullTrailer = trailerParts.join('\n');
        if (fullTrailer) {
          if (hasActiveSandboxBridgeScope()) {
            appendSandboxBridgeTrailer(fullTrailer);
          } else {
            receiptFooter = fullTrailer;
          }
        }
      }

      return { ok: true, receiptFooter, text: cleanedText };
    } catch (error) {
      log('gateway call %s failed: %O', toolName, error);
      return { message: `The sandbox is unavailable: ${(error as Error).message}`, ok: false };
    }
  }

  /** Команда в песочнице темы; файлы навыка (если есть) раскладываются в папку `cwd` перед запуском. */
  async runCommand(
    command: string,
    options: {
      cwd?: string;
      files?: SandboxFile[];
      template?: 'remotion';
      timeoutSec?: number;
    } = {},
  ): Promise<CommandResult> {
    const total = (options.files ?? []).reduce((sum, file) => sum + file.content.byteLength, 0);
    if (total > SANDBOX_MAX_UPLOAD_BYTES) {
      return {
        exitCode: 1,
        output: '',
        stderr: `The skill files are too large to copy into the sandbox (${total} bytes, limit ${SANDBOX_MAX_UPLOAD_BYTES}).`,
        success: false,
      };
    }

    const isRemotion = options.template === 'remotion';
    const timeoutSec =
      options.timeoutSec ??
      (isRemotion ? SANDBOX_REMOTION_TIMEOUT_SEC : SANDBOX_COMMAND_TIMEOUT_SEC);
    const cwd = options.cwd ?? (isRemotion ? '/workspace/project' : undefined);
    const callArgs: Record<string, unknown> = {
      code: buildCommandProgram({ command, cwd, files: options.files, timeoutSec }),
    };
    if (isRemotion) {
      callArgs.template = 'remotion';
      callArgs.timeout_ms = (timeoutSec + 10) * 1000;
    }

    const result = await this.call('execute_code', callArgs);
    if (!result.ok) return { exitCode: 1, output: '', stderr: result.message, success: false };

    const parsed = parseCommandOutput(result.text);
    if (result.receiptFooter) {
      const trimmedOut = parsed.output.replace(/\n+$/, '');
      return {
        ...parsed,
        output: trimmedOut ? `${trimmedOut}\n\n${result.receiptFooter}` : result.receiptFooter,
      };
    }
    return parsed;
  }

  /** Файл из песочницы (base64). */
  async readFile(path: string, options: { template?: 'remotion' } = {}): Promise<SandboxFileRead> {
    const callArgs: Record<string, unknown> = { path };
    if (options.template === 'remotion') {
      callArgs.template = 'remotion';
    }
    const result = await this.call('read_file', callArgs, GATEWAY_FILE_RESPONSE_LIMIT);
    if (!result.ok) {
      const tooLarge = result.message === 'The sandbox response is too large to read.';
      return {
        message: tooLarge
          ? `The file is too large to export (limit ${SANDBOX_MAX_EXPORT_BYTES} bytes).`
          : result.message,
        ok: false,
      };
    }

    try {
      const parsed = JSON.parse(result.text) as {
        content_base64?: string;
        filename?: string;
        size?: number;
        success?: boolean;
      };
      if (parsed.success && typeof parsed.content_base64 === 'string') {
        return {
          base64: parsed.content_base64,
          filename: parsed.filename || path.split('/').pop() || 'file',
          ok: true,
          size: typeof parsed.size === 'number' ? parsed.size : 0,
        };
      }
    } catch {
      // не JSON — это текст ошибки шлюза («File not found: …»)
    }

    return { message: result.text.trim() || `File not found: ${path}`, ok: false };
  }
}
