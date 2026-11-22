// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  applyAtomicPatch,
  MAX_DIFF_SUMMARY_CHARS,
  MAX_PATCH_BATCH_BYTES,
  MAX_PATCH_EDITS,
} from './patch';

describe('applyAtomicPatch', () => {
  it('applies Level 1 exact matches atomically, preserves CRLF, and keeps original startLine/endLine across edits', () => {
    const source = [
      'Sub Header()',
      '    Dim a As Long',
      '    a = 1',
      'End Sub',
      '',
      'Sub Footer()',
      '    Dim b As Long',
      '    b = 2',
      'End Sub',
      '',
    ].join('\r\n');

    const res = applyAtomicPatch(
      source,
      [
        {
          // Expands line 3 by +4 lines — edit[1] still passes original startLine: 7..8!
          endLine: 3,
          newText: '    a = 10\n    a = a + 1\n    a = a + 2\n    a = a + 3\n    a = a + 4',
          oldText: '    a = 1',
          startLine: 2,
        },
        {
          endLine: 8,
          newText: '    b = 200',
          oldText: '    b = 2',
          startLine: 7,
        },
      ],
      { fileName: 'Module1.bas', sourceEncoding: 'windows-1251' },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.lineEnding).toBe('CRLF');
    expect(res.hasBom).toBe(false);
    expect(res.appliedEdits).toBe(2);
    expect(res.linesBefore).toBe(9);
    expect(res.linesAfter).toBe(13);
    expect(res.diagnostics.map((d) => d.level)).toEqual(['exact', 'exact']);
    expect(res.content).toContain('\r\n');
    expect(res.content.replaceAll('\r\n', '')).not.toContain('\n');
    expect(res.content).toContain('    a = a + 4\r\nEnd Sub');
    expect(res.content).toContain('    b = 200\r\nEnd Sub');
    expect(res.diffSummary).toContain('encoding windows-1251 -> utf-8, lineEnding CRLF');
    expect(res.diffSummary).toContain('@@ ');
    expect(res.diffSummary).toContain('+    b = 200');
  });

  it('uses Level 2 line_trim_end (trailing whitespace only, never bare .trim())', () => {
    const source = 'def foo():   \n    x = 1  \t\n    return x\n';
    const okRes = applyAtomicPatch(source, [
      {
        newText: 'def foo():\n    x = 2\n    return x',
        oldText: 'def foo():\n    x = 1\n    return x',
      },
    ]);
    expect(okRes.ok).toBe(true);
    if (!okRes.ok) return;
    expect(okRes.diagnostics[0].level).toBe('line_trim_end');
    expect(okRes.content).toBe('def foo():\n    x = 2\n    return x\n');

    // Leading-indent mismatch with broken relative indentation must NOT match Level 2 or Level 3
    const pythonSource = 'def bar():\n    if True:\n        return 1\n';
    const badRelative = applyAtomicPatch(pythonSource, [
      {
        newText: 'if True:\n    return 2',
        oldText: 'if True:\n  return 1', // 2 spaces instead of 4 spaces relative indent
      },
    ]);
    expect(badRelative.ok).toBe(false);
    if (badRelative.ok) return;
    expect(badRelative.diagnostics[0].code).toBe('not_found');
  });

  it('uses Level 3 indent_flexible with exact relative indentation and delta re-indentation', () => {
    const source = [
      'class Demo:',
      '    def compute(self):',
      '        if self.ready:',
      '            total = 1',
      '            return total',
      '',
    ].join('\n');

    // Model omitted the 8-space base indent while preserving the 4-space inner indent
    const res = applyAtomicPatch(source, [
      {
        newText: 'if self.ready:\n    total = 42\n\n    return total * 2',
        oldText: 'if self.ready:\n    total = 1\n    return total',
      },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diagnostics[0].level).toBe('indent_flexible');
    expect(res.content).toBe(
      [
        'class Demo:',
        '    def compute(self):',
        '        if self.ready:',
        '            total = 42',
        '',
        '            return total * 2',
        '',
      ].join('\n'),
    );
  });

  it('supports tab indentation in Level 3 and rejects mixed tabs/spaces or negative indent delta', () => {
    const tabSource = 'func main() {\n\tif ok {\n\t\treturn 1\n\t}\n}\n';
    const tabOk = applyAtomicPatch(tabSource, [
      {
        newText: 'if ok {\n\treturn 2\n}',
        oldText: 'if ok {\n\treturn 1\n}',
      },
    ]);
    expect(tabOk.ok).toBe(true);
    if (tabOk.ok) {
      expect(tabOk.diagnostics[0].level).toBe('indent_flexible');
      expect(tabOk.content).toBe('func main() {\n\tif ok {\n\t\treturn 2\n\t}\n}\n');
    }

    // Spaces in oldText must NOT match tabs in source
    const spaceVsTab = applyAtomicPatch(tabSource, [
      {
        newText: '  if ok {\n    return 2\n  }',
        oldText: '  if ok {\n    return 1\n  }',
      },
    ]);
    expect(spaceVsTab.ok).toBe(false);

    // Negative indent delta: source at column 0, model sent 4-space indented oldText,
    // but newText only has 2 spaces on a line -> indent would go negative -> indent_mismatch
    const col0Source = 'if x:\n    y = 1\n';
    const negRes = applyAtomicPatch(col0Source, [
      {
        newText: '  if x:\n      y = 2',
        oldText: '    if x:\n        y = 1',
      },
    ]);
    expect(negRes.ok).toBe(false);
    if (!negRes.ok) {
      expect(negRes.diagnostics[0].code).toBe('indent_mismatch');
    }
  });

  it('reports ambiguous_match with line numbers unless replaceAll or startLine/endLine disambiguates', () => {
    const source = Array.from(
      { length: 15 },
      (_, i) => `val = TODO_${i % 2 === 0 ? 'X' : 'Y'}`,
    ).join('\n');

    const amb = applyAtomicPatch(source, [{ newText: 'val = DONE', oldText: 'val = TODO_X' }]);
    expect(amb.ok).toBe(false);
    if (!amb.ok) {
      expect(amb.diagnostics[0].code).toBe('ambiguous_match');
      expect(amb.diagnostics[0].matchLines).toEqual([1, 3, 5, 7, 9, 11, 13, 15]);
      expect(amb.diagnostics[0].occurrences).toBe(8);
    }

    // Disambiguate with replaceAll
    const allRes = applyAtomicPatch(source, [
      { newText: 'val = DONE', oldText: 'val = TODO_X', replaceAll: true },
    ]);
    expect(allRes.ok).toBe(true);
    if (allRes.ok) {
      expect(allRes.appliedOccurrences).toBe(8);
      expect(allRes.content).not.toContain('TODO_X');
    }

    // Disambiguate with startLine/endLine on a sparse file
    const sparse = Array.from({ length: 40 }, (_, i) =>
      i === 4 || i === 34 ? 'TARGET_LINE()' : `line_${i + 1}`,
    ).join('\n');
    const scoped = applyAtomicPatch(sparse, [
      { endLine: 36, newText: 'REPLACED()', oldText: 'TARGET_LINE()', startLine: 33 },
    ]);
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      const lines = scoped.content.split('\n');
      expect(lines[4]).toBe('TARGET_LINE()');
      expect(lines[34]).toBe('REPLACED()');
    }
  });

  it('rejects not_found_in_range with real line hints and NEVER silently patches outside the window', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row_${i + 1}`);
    lines[39] = 'UNIQUE_ANCHOR = 1'; // Line 40
    const source = lines.join('\n');

    const res = applyAtomicPatch(source, [
      { endLine: 12, newText: 'UNIQUE_ANCHOR = 2', oldText: 'UNIQUE_ANCHOR = 1', startLine: 8 },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics[0].code).toBe('not_found_in_range');
    expect(res.diagnostics[0].matchLines).toEqual([40]);
    expect(res.error).toContain('40');
  });

  it('rejects overlapping edits atomically and reports all per-edit statuses', () => {
    const source = 'line1\nline2\nline3\nline4\nline5\n';
    const res = applyAtomicPatch(source, [
      { newText: 'A\nB', oldText: 'line1\nline2' },
      { newText: 'B2\nC', oldText: 'line2\nline3' },
      { newText: 'E', oldText: 'line5' },
    ]);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('patch_failed');
    expect(res.diagnostics).toHaveLength(3);
    expect(res.diagnostics[0].code).toBe('overlapping_edits');
    expect(res.diagnostics[0].overlappingWith).toEqual([1]);
    expect(res.diagnostics[1].code).toBe('overlapping_edits');
    expect(res.diagnostics[1].overlappingWith).toEqual([0]);
    expect(res.diagnostics[2].ok).toBe(true);
  });

  it('preserves leading UTF-8 BOM and enforces batch/output limits', () => {
    const bomSource = '\uFEFFПривет\r\nМир\r\n';
    const res = applyAtomicPatch(bomSource, [{ newText: 'Земля', oldText: 'Мир' }]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.hasBom).toBe(true);
      expect(res.lineEnding).toBe('CRLF');
      expect(res.content).toBe('\uFEFFПривет\r\nЗемля\r\n');
    }

    // Empty edits / > 50 edits
    expect(applyAtomicPatch('abc', []).ok).toBe(false);
    expect(
      applyAtomicPatch(
        'abc',
        Array.from({ length: MAX_PATCH_EDITS + 1 }, () => ({ newText: 'b', oldText: 'a' })),
      ).ok,
    ).toBe(false);

    // Batch > 512 KB
    const huge = applyAtomicPatch('x', [
      { newText: 'a'.repeat(MAX_PATCH_BATCH_BYTES + 1), oldText: 'x' },
    ]);
    expect(huge.ok).toBe(false);

    // Output > maxOutputBytes
    const smallLimit = applyAtomicPatch('hello', [{ newText: 'world12345', oldText: 'hello' }], {
      maxOutputBytes: 8,
    });
    expect(smallLimit.ok).toBe(false);
    if (!smallLimit.ok) expect(smallLimit.code).toBe('size_limit');

    // NUL byte rejected
    expect(applyAtomicPatch('abc', [{ newText: 'a\0b', oldText: 'a' }]).ok).toBe(false);
  });

  it('truncates very large diff summaries cleanly to <= 2500 chars', () => {
    const lines = Array.from(
      { length: 120 },
      (_, i) => `Const ITEM_${i} = "значение_${i}_${'z'.repeat(40)}"`,
    );
    const source = lines.join('\n') + '\n';
    const edits = Array.from({ length: 25 }, (_, i) => ({
      newText: `Const ITEM_${i * 4} = "обновлено_${i * 4}_${'w'.repeat(40)}"`,
      oldText: lines[i * 4],
    }));
    const res = applyAtomicPatch(source, edits, { fileName: 'BigConst.bas' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSummary.length).toBeLessThanOrEqual(MAX_DIFF_SUMMARY_CHARS);
    expect(res.diffSummary.endsWith('...(truncated)')).toBe(true);
  });

  it('stress-tests ~160K-char Cyrillic VBA module with CRLF and 11 edits in one atomic batch', () => {
    // Build a realistic ~165 KB Cyrillic VBA module with CRLF line endings
    const procedures: string[] = ['Attribute VB_Name = "ModuleDiscounts"', 'Option Explicit', ''];
    for (let i = 1; i <= 240; i++) {
      procedures.push(
        `' === Процедура расчёта скидок #${i}: обработка позиций и контроль НДС ===`,
        `Public Sub ProcessDiscountBlock_${i}(ByVal ws As Worksheet, ByVal rowStart As Long)`,
        `    Dim i As Long`,
        `    Dim rate As Double`,
        `    Dim commentText As String`,
        `    rate = ${(0.01 * i).toFixed(2)}`,
        `    commentText = "Блок скидки номер ${i}: базовая ставка применена к таблице расчётов Excel"`,
        `    For i = rowStart To rowStart + 250`,
        `        If ws.Cells(i, 4).Value > 0 Then`,
        `            ws.Cells(i, 5).Value = Round(ws.Cells(i, 4).Value * (1 - rate), 2)`,
        `            ws.Cells(i, 6).Value = commentText & " | строка " & CStr(i) & " | контроль суммы"`,
        `            ws.Cells(i, 7).Value = "Проверено модулем 7.3.1 для контрагента и договора"`,
        `        End If`,
        `    Next i`,
        `End Sub`,
        '',
      );
    }
    const vbaSource = procedures.join('\r\n');
    expect(vbaSource.length).toBeGreaterThan(160_000);

    // Prepare 11 edits spread across the entire 160K+ module using original 1-based line numbers
    const rawLines = vbaSource.split('\r\n');
    const targetBlocks = [1, 20, 45, 70, 95, 120, 145, 170, 195, 220, 240];
    const edits = targetBlocks.map((blockNum, idx) => {
      const headerLine = `Public Sub ProcessDiscountBlock_${blockNum}(ByVal ws As Worksheet, ByVal rowStart As Long)`;
      const lineIdx = rawLines.indexOf(headerLine);
      expect(lineIdx).toBeGreaterThan(0);

      // Mix exact, line_trim_end, and indent_flexible styles across the 11 edits
      if (idx === 0) {
        return {
          endLine: lineIdx + 10,
          newText: `    rate = 0.15\n    ' Добавлен аудит\n    ws.Cells(rowStart, 8).Value = "Аудит #${blockNum}"`,
          oldText: `    rate = ${(0.01 * blockNum).toFixed(2)}`,
          startLine: lineIdx + 1,
        };
      }
      if (idx === 5) {
        // Level 3 indent_flexible (omitted 4-space base indent)
        return {
          endLine: lineIdx + 13,
          newText: `For i = rowStart To rowStart + 500\n    If ws.Cells(i, 4).Value > 0 Then`,
          oldText: `For i = rowStart To rowStart + 250\n    If ws.Cells(i, 4).Value > 0 Then`,
          startLine: lineIdx + 6,
        };
      }
      return {
        endLine: lineIdx + 14,
        newText: `            ws.Cells(i, 7).Value = "Обновлено версией 7.3.2 (блок ${blockNum})"`,
        oldText: `            ws.Cells(i, 7).Value = "Проверено модулем 7.3.1 для контрагента и договора"`,
        startLine: lineIdx + 9,
      };
    });

    const t0 = performance.now();
    const res = applyAtomicPatch(vbaSource, edits, {
      fileName: '7.3.1.bas',
      sourceEncoding: 'windows-1251',
    });
    const elapsedMs = performance.now() - t0;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.appliedEdits).toBe(11);
    expect(res.lineEnding).toBe('CRLF');
    expect(res.content.replaceAll('\r\n', '')).not.toContain('\n');
    expect(res.content).toContain('ws.Cells(rowStart, 8).Value = "Аудит #1"');
    expect(res.content).toContain('    For i = rowStart To rowStart + 500\r\n');
    expect(res.content).toContain('Обновлено версией 7.3.2 (блок 240)');
    // Untouched block remains byte-for-byte intact
    expect(res.content).toContain('Public Sub ProcessDiscountBlock_15(');
    expect(res.diffSummary.length).toBeLessThanOrEqual(MAX_DIFF_SUMMARY_CHARS);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
