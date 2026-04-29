import { describe, expect, it } from 'vitest';

import { resolveSheets } from '../renderers/xlsx';
import {
  sanitizeMarkdown,
  sanitizeSpreadsheetCell,
  sanitizeSpreadsheetRows,
} from '../sanitization';

describe('document sanitization', () => {
  it('strips script tags from markdown', () => {
    const sanitized = sanitizeMarkdown('# Safe\n<script>alert("x")</script>\n<b>bold</b>');

    expect(sanitized).toContain('# Safe');
    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('alert');
    expect(sanitized).toContain('bold');
  });

  it('prevents spreadsheet formula injection', () => {
    expect(sanitizeSpreadsheetCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(sanitizeSpreadsheetCell('+cmd')).toBe("'+cmd");
    expect(sanitizeSpreadsheetCell('-10')).toBe("'-10");
    expect(sanitizeSpreadsheetCell('@user')).toBe("'@user");
  });

  it('sanitizes all string cells in rows', () => {
    const rows = sanitizeSpreadsheetRows([
      ['Name', '=Formula'],
      ['Value', 10],
    ]);

    expect(rows[0][1]).toBe("'=Formula");
    expect(rows[1][1]).toBe(10);
  });

  it('sanitizes formulas extracted from markdown tables', () => {
    const [sheet] = resolveSheets('| Name | Formula |\n| --- | --- |\n| A | =SUM(A1:A2) |');

    expect(sheet.rows[1][1]).toBe("'=SUM(A1:A2)");
  });
});
