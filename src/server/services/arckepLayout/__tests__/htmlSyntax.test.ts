// @vitest-environment node
import { GeneralChatAgent } from '@lobechat/agent-runtime';
import {
  ArckepLayoutIdentifier,
  ArckepLayoutManifest,
} from '@lobechat/builtin-tool-arckep-layout';
import { ArckepLayoutExecutionRuntime } from '@lobechat/builtin-tool-arckep-layout/executionRuntime';
import { describe, expect, it, vi } from 'vitest';

import { activatorRuntime } from '@/server/services/toolExecution/serverRuntimes/activator';

import {
  computeHtmlSha256,
  formatHtmlSyntaxDiagnostics,
  HtmlArtifactStreamGate,
  validateHtmlArtifactSyntax,
} from '../htmlSyntax';
import { ArckepLayoutService, type LayoutServiceDeps } from '../service';

const BROKEN_PRODUCTION_ARTIFACT_CONTENT = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Тест</title>
</head>
<body>
  <div id="app">Привет</div>
  <script>\\n    function copyBibleText() {\\n      const text = \\"Привет\\";\\n      return text;\\n    }\\n  </script>
</body>
</html>`;

const BROKEN_INLINE_JS_HTML = `<!DOCTYPE html>
<html lang="ru">
<body>
  <button id="btn">Нажми</button>
  <script>
    const count = 1;
    function broken( {
      return count;
    }
  </script>
</body>
</html>`;

const VALID_INTERACTIVE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Калькулятор</title>
</head>
<body>
  <script type="application/json" id="seed-data">{"rate": 12.5, "unquoted": [1, 2, 3]}</script>
  <script type="module">
    const seed = JSON.parse(document.querySelector('#seed-data').textContent);
    export const total = seed.rate * 2;
  </script>
  <script>
    function runCalc(a, b) {
      return a + b;
    }
    window.__calcReady = runCalc(2, 3) === 5;
  </script>
</body>
</html>`;

const makeServiceDeps = () => {
  const saved: Array<{ html: string; name: string }> = [];
  const deps: LayoutServiceDeps = {
    address: (fileId) => `https://arckep.ru/chat/f/${fileId}/`,
    artifactMessages: vi.fn(async () => [
      {
        content: `<lobeArtifact identifier="calc" type="text/html" title="Калькулятор">${VALID_INTERACTIVE_HTML}</lobeArtifact>`,
        id: 'm1',
      },
    ]),
    askEditor: vi.fn(async () => '[]'),
    modelHasVision: vi.fn(async () => false),
    prepRecord: vi.fn(async () => undefined),
    readChatFileText: vi.fn(async () => undefined),
    readStorage: vi.fn(async () => new Uint8Array()),
    render: vi.fn(async () => {
      throw new Error('not used');
    }),
    saveHtml: vi.fn(async (html, name) => {
      saved.push({ html, name });
      return { address: 'https://arckep.ru/chat/f/file_VERIFIED/', fileId: 'file_VERIFIED' };
    }),
    studioUserId: vi.fn(async () => 42),
    topicPdfs: vi.fn(async () => []),
    turnModel: vi.fn(async () => undefined),
  };
  return { deps, saved };
};

describe('validateHtmlArtifactSyntax', () => {
  it('ловит реальный сбой прода с литеральными \\n и \\" внутри <script> с указанием строки и столбца', () => {
    const result = validateHtmlArtifactSyntax(BROKEN_PRODUCTION_ARTIFACT_CONTENT);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues[0].line).toBe(9);
    expect(result.issues[0].column).toBeGreaterThanOrEqual(1);
    const formatted = formatHtmlSyntaxDiagnostics(result, 'bible- study');
    expect(formatted).toContain('Строка 9, столбец');
    expect(formatted).toContain('Проверено:');
    expect(formatted).toContain('Не проверяется этим шагом:');
  });

  it('ловит обычный синтаксический сбой JS в <script> на точной строке HTML-документа', () => {
    const result = validateHtmlArtifactSyntax(BROKEN_INLINE_JS_HTML);
    expect(result.valid).toBe(false);
    expect(result.issues[0].kind).toBe('script_syntax');
    expect(result.issues[0].line).toBe(8);
    expect(result.issues[0].column).toBeGreaterThanOrEqual(1);
  });

  it('пропускает корректные классические и module <script>, а также <script type="application/json">', () => {
    const result = validateHtmlArtifactSyntax(VALID_INTERACTIVE_HTML);
    expect(result.valid).toBe(true);
    expect(result.checkedScripts).toBe(2);
    expect(result.issues).toEqual([]);
  });
});

describe('writeArtifact и editArtifact с проверкой синтаксиса', () => {
  it('writeArtifact: битый JS в <script> блокирует сохранение файла и возвращает строку/столбец модели', async () => {
    const { deps, saved } = makeServiceDeps();
    const service = new ArckepLayoutService(deps, { topicId: 'tpc_1', userId: 'u1' });
    const runtime = new ArckepLayoutExecutionRuntime({
      checkLayout: (params) => service.checkLayout(params),
      editArtifact: (params) => service.editArtifact(params),
      writeArtifact: (params) => service.writeArtifact(params),
    });

    const output = await runtime.writeArtifact({
      content: BROKEN_INLINE_JS_HTML,
      identifier: 'broken-page',
      title: 'Сломанная страница',
    });

    expect(output.success).toBe(false);
    expect(saved).toEqual([]);
    expect(output.content).toContain('HTML-артефакт не прошёл проверку и не сохранён');
    expect(output.content).toContain('Строка 8, столбец');
  });

  it('writeArtifact: валидный HTML сохраняется в файл чата и возвращает sha256 и короткий тег со src', async () => {
    const { deps, saved } = makeServiceDeps();
    const service = new ArckepLayoutService(deps, { topicId: 'tpc_1', userId: 'u1' });
    const runtime = new ArckepLayoutExecutionRuntime({
      checkLayout: (params) => service.checkLayout(params),
      editArtifact: (params) => service.editArtifact(params),
      writeArtifact: (params) => service.writeArtifact(params),
    });

    const output = await runtime.writeArtifact({
      content: VALID_INTERACTIVE_HTML,
      identifier: 'calc',
      title: 'Калькулятор',
    });

    expect(output.success).toBe(true);
    expect(saved).toEqual([{ html: VALID_INTERACTIVE_HTML, name: 'calc-write-2.html' }]);
    expect(output.state).toMatchObject({
      checkedScripts: 2,
      fileId: 'file_VERIFIED',
      identifier: 'calc',
      sha256: computeHtmlSha256(VALID_INTERACTIVE_HTML),
      src: 'https://arckep.ru/chat/f/file_VERIFIED/',
    });
    expect(output.content).toContain(
      '<lobeArtifact identifier="calc" type="text/html" title="Калькулятор" src="https://arckep.ru/chat/f/file_VERIFIED/"></lobeArtifact>',
    );
  });

  it('editArtifact: правка, ломающая синтаксис <script>, не перезаписывает последнюю рабочую версию', async () => {
    const { deps, saved } = makeServiceDeps();
    const service = new ArckepLayoutService(deps, { topicId: 'tpc_1', userId: 'u1' });

    await expect(
      service.editArtifact({
        edits: [{ find: 'return a + b;', replace: 'return a + ;' }],
        identifier: 'calc',
      }),
    ).rejects.toThrow(/предыдущая рабочая копия сохранена/);

    expect(saved).toEqual([]);
  });
});

describe('activateSkill("Artifacts") подключает arckep-layout на первом HTML-ходе', () => {
  it('возвращает arckep-layout в state.activatedTools, когда манифест есть в toolManifestMap', async () => {
    vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1');
    try {
      const emptyDb: any = {
        select: () => ({
          from: () => ({
            limit: async () => [],
            orderBy: async () => [],
            where: () => ({ limit: async () => [], orderBy: async () => [] }),
          }),
        }),
      };
      const runtime = (await activatorRuntime.factory({
        serverDB: emptyDb,
        toolManifestMap: { [ArckepLayoutIdentifier]: ArckepLayoutManifest },
        userId: 'u1',
      } as any)) as any;

      const result = await runtime.activateSkill({ name: 'Artifacts' });
      expect(result.success).toBe(true);
      expect(result.state.activatedTools).toEqual([
        expect.objectContaining({
          apiCount: 3,
          identifier: ArckepLayoutIdentifier,
        }),
      ]);
      expect(result.content).toContain('writeArtifact');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('HtmlArtifactStreamGate и перехват битого прямого потока', () => {
  it('удерживает <lobeArtifact type="text/html"> при разбиении тега по чанкам и пропускает валидный HTML', async () => {
    const gate = new HtmlArtifactStreamGate();
    const chunks = [
      'Вступление перед страницей.\n<lobeArt',
      'ifact identifier="demo" type="text/html" title="Демо">',
      VALID_INTERACTIVE_HTML,
      '</lobeArt',
      'ifact>\nПослесловие.',
    ];

    let streamedDuring = '';
    for (const chunk of chunks) {
      streamedDuring += gate.push(chunk);
    }

    expect(streamedDuring).toBe('Вступление перед страницей.\n\nПослесловие.');
    expect(streamedDuring).not.toContain('<lobeArtifact');
    const finalized = await gate.finalize();
    expect(finalized.valid).toBe(true);
    expect(finalized.diagnostics).toEqual([]);
    expect(finalized.finalContent).toContain('<lobeArtifact identifier="demo" type="text/html"');
    expect(finalized.finalContent).toContain('Послесловие.');
  });

  it('блокирует публикацию сломанного <lobeArtifact type="text/html"> и отдаёт диагностику со строкой и столбцом', async () => {
    const gate = new HtmlArtifactStreamGate();
    const streamed = gate.push(
      `Готово:\n<lobeArtifact identifier="bad" type="text/html" title="Bad">${BROKEN_INLINE_JS_HTML}</lobeArtifact>`,
    );
    expect(streamed).toBe('Готово:\n');

    const finalized = await gate.finalize();
    expect(finalized.valid).toBe(false);
    expect(finalized.finalContent).toBe('Готово:\n');
    expect(finalized.finalContent).not.toContain('<lobeArtifact');
    expect(finalized.diagnostics[0]).toContain('Строка 8, столбец');
  });

  it('блокирует незакрытый <lobeArtifact> и экранированные кавычки атрибутов <lobeArtifact identifier=\\"…\\">', async () => {
    const unclosedGate = new HtmlArtifactStreamGate();
    unclosedGate.push('<lobeArtifact identifier="cut" type="text/html"><html><body>Обрыв');
    const unclosed = await unclosedGate.finalize();
    expect(unclosed.valid).toBe(false);
    expect(unclosed.finalContent).toBe('');
    expect(unclosed.diagnostics[0]).toContain('Unclosed <lobeArtifact> wrapper');

    const escapedGate = new HtmlArtifactStreamGate();
    escapedGate.push(
      `<lobeArtifact identifier=\\"esc\\" type=\\"text/html\\" title=\\"Esc\\">${BROKEN_PRODUCTION_ARTIFACT_CONTENT}</lobeArtifact>`,
    );
    const escaped = await escapedGate.finalize();
    expect(escaped.valid).toBe(false);
    expect(escaped.finalContent).toBe('');
    expect(escaped.diagnostics[0]).toContain('backslash-escaped quotes');
  });

  it('GeneralChatAgent планирует повторный шаг call_llm при htmlArtifactSyntaxError и уважает forceFinish / interrupted', async () => {
    const agent = new GeneralChatAgent({
      modelRuntimeConfig: { model: 'gpt-4o', provider: 'openai' },
      operationId: 'op_test',
    });

    const baseState: any = {
      forceFinish: false,
      messages: [
        { content: 'Сделай калькулятор', role: 'user' },
        { content: 'Битый HTML', role: 'assistant' },
        { content: 'Диагностика строки 7', role: 'user' },
      ],
      status: 'running',
      tools: [],
    };

    const nextInstruction = await agent.runner(
      {
        payload: {
          hasToolsCalling: false,
          htmlArtifactSyntaxError: 'строка 7, столбец 21',
          parentMessageId: 'msg_assistant_1',
          result: { content: '', tool_calls: [] },
          toolsCalling: [],
        },
        phase: 'llm_result',
        session: { messageCount: 3, sessionId: 'op_test', status: 'running', stepCount: 1 },
      },
      baseState,
    );

    expect(nextInstruction).toMatchObject({
      payload: {
        assistantMessageId: 'msg_assistant_1',
        parentMessageId: 'msg_assistant_1',
      },
      type: 'call_llm',
    });

    const forcedFinish = await agent.runner(
      {
        payload: {
          hasToolsCalling: false,
          htmlArtifactSyntaxError: 'строка 7, столбец 21',
          parentMessageId: 'msg_assistant_1',
          result: { content: '', tool_calls: [] },
          toolsCalling: [],
        },
        phase: 'llm_result',
        session: { messageCount: 3, sessionId: 'op_test', status: 'running', stepCount: 1 },
      },
      { ...baseState, forceFinish: true },
    );

    expect(forcedFinish).toMatchObject({
      reason: 'max_steps_completed',
      type: 'finish',
    });
  });
});
