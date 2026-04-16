import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { buildXlsxFile, extractSpreadsheetRows, shouldAutoAttachSpreadsheet } from './spreadsheet';

describe('extractSpreadsheetRows', () => {
  it('should parse csv fenced blocks with semicolon delimiter', () => {
    const rows = extractSpreadsheetRows(`Вводный текст

\`\`\`csv
Name;Role;Age
Leo;Manager;42
Ann;Analyst;31
\`\`\`

Хвост`);

    expect(rows).toEqual([
      ['Name', 'Role', 'Age'],
      ['Leo', 'Manager', '42'],
      ['Ann', 'Analyst', '31'],
    ]);
  });

  it('should parse markdown tables', () => {
    const rows = extractSpreadsheetRows(`
| Name | Score |
| --- | ---: |
| Leo | 98 |
| Ann | 87 |
`);

    expect(rows).toEqual([
      ['Name', 'Score'],
      ['Leo', '98'],
      ['Ann', '87'],
    ]);
  });
});

describe('buildXlsxFile', () => {
  it('should build a valid workbook archive with numeric and string cells', () => {
    const archive = buildXlsxFile(
      [
        ['Code', 'Value'],
        ['001', '42'],
      ],
      {
        createdAt: '2026-04-15T20:00:00.000Z',
        sheetName: 'Export',
      },
    );

    const files = unzipSync(archive);
    const worksheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    const workbook = strFromU8(files['xl/workbook.xml']);

    expect(workbook).toContain('sheet name="Export"');
    expect(worksheet).toContain('<c r="A2" t="inlineStr"><is><t>001</t></is></c>');
    expect(worksheet).toContain('<c r="B2"><v>42</v></c>');
  });
});

describe('shouldAutoAttachSpreadsheet', () => {
  it('should auto-attach for explicit Excel file requests when assistant returns a table', () => {
    const shouldAttach = shouldAutoAttachSpreadsheet(
      `
| тест | строитель | дата |
| --- | --- | --- |
|  |  |  |
`,
      [{ content: 'Можешь сделать exel файл с колонками тест, строитель и дата?', role: 'user' }],
    );

    expect(shouldAttach).toBe(true);
  });

  it('should not auto-attach for generic table responses without file intent', () => {
    const shouldAttach = shouldAutoAttachSpreadsheet(
      `
| Model | Speed |
| --- | --- |
| A | Fast |
`,
      [{ content: 'Сравни эти модели в таблице', role: 'user' }],
    );

    expect(shouldAttach).toBe(false);
  });
});
