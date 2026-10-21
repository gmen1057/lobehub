import { describe, expect, it } from 'vitest';

import { compactHistoryMessages } from '../compactHistoryMessages';

describe('compactHistoryMessages', () => {
  it('сжимает перекрытые более новой inline-версией <lobeArtifact> с тем же identifier, сохраняя последнюю версию целиком', () => {
    const htmlV1 = '<table>' + '<tr><td>Версия 1</td></tr>'.repeat(60) + '</table>';
    const htmlV2 = '<table>' + '<tr><td>Версия 2</td></tr>'.repeat(60) + '</table>';
    const messages = [
      { content: 'Сверстай письмо', role: 'user' },
      {
        content: `Первая сборка:\n<lobeArtifact identifier="k31-email" type="text/html" title="Письмо">${htmlV1}</lobeArtifact>`,
        role: 'assistant',
      },
      { content: 'Поправь отступы', role: 'user' },
      {
        content: `Исправленный вариант:\n<lobeArtifact identifier="k31-email" type="text/html" title="Письмо">${htmlV2}</lobeArtifact>`,
        role: 'assistant',
      },
    ];

    const compacted = compactHistoryMessages(messages);

    expect(compacted[1].content).toContain(
      '<lobeArtifact identifier="k31-email" type="text/html" title="Письмо">',
    );
    expect(compacted[1].content).toContain('Предыдущая версия макета');
    expect(compacted[1].content).not.toContain('Версия 1');
    expect(compacted[3].content).toContain(htmlV2);
  });

  it('не сжимает полную inline-версию артефакта, если следом идёт только короткий тег со ссылкой src без тела', () => {
    const htmlV1 = '<table>' + '<tr><td>Полный код</td></tr>'.repeat(60) + '</table>';
    const messages = [
      { content: 'Сверстай письмо', role: 'user' },
      {
        content: `<lobeArtifact identifier="k31-email" type="text/html" title="Письмо">${htmlV1}</lobeArtifact>`,
        role: 'assistant',
      },
      {
        content:
          '<lobeArtifact identifier="k31-email" type="text/html" title="Письмо" src="https://arckep.ru/chat/f/file_123/"></lobeArtifact>',
        role: 'assistant',
      },
    ];

    const compacted = compactHistoryMessages(messages);

    expect(compacted[1].content).toContain(htmlV1);
  });

  it('сжимает старые громоздкие выводы tool и JSON-аргументы старше последних 3 сообщений человека, оставляя свежие нетронутыми', () => {
    const bigToolOutput = 'BEGIN_OUT_' + 'x'.repeat(5000) + '_END_OUT';
    const bigCodeArg = 'import os\n' + 'print("line")\n'.repeat(400) + '# DONE';
    const recentBigToolOutput = 'RECENT_' + 'y'.repeat(5000);

    const messages = [
      { content: 'Ход 1 (старый)', role: 'user' },
      {
        content: '',
        role: 'assistant',
        tools: [
          {
            apiName: 'execute_code',
            arguments: JSON.stringify({ code: bigCodeArg, timeout_ms: 30000 }),
            id: 'tc-old',
            identifier: 'mcp-arckep-e2b-sandbox',
          },
        ],
      },
      { content: bigToolOutput, role: 'tool' },
      { content: 'Ход 2', role: 'user' },
      { content: 'Ответ 2', role: 'assistant' },
      { content: 'Ход 3', role: 'user' },
      { content: 'Ответ 3', role: 'assistant' },
      { content: 'Ход 4 (свежий)', role: 'user' },
      { content: recentBigToolOutput, role: 'tool' },
    ];

    const compacted = compactHistoryMessages(messages);

    // Старый вывод tool сжат, но сохраняет начало и конец
    expect(compacted[2].content.length).toBeLessThan(2000);
    expect(compacted[2].content).toContain('BEGIN_OUT_');
    expect(compacted[2].content).toContain('_END_OUT');
    expect(compacted[2].content).toContain('вывод инструмента');

    // Старый аргумент tool остаётся валидным JSON, но длинная строка code сжата
    const parsedOldArgs = JSON.parse(compacted[1].tools![0].arguments);
    expect(parsedOldArgs.timeout_ms).toBe(30000);
    expect(parsedOldArgs.code.length).toBeLessThan(1000);
    expect(parsedOldArgs.code).toContain('import os');
    expect(parsedOldArgs.code).toContain('# DONE');

    // Свежий вывод tool (внутри последних 3 сообщений человека) не тронут
    expect(compacted[8].content).toBe(recentBigToolOutput);
  });
});
