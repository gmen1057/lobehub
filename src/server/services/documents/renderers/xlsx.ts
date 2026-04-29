import type { DocumentCellValue, DocumentSheet } from '@lobechat/builtin-tool-documents';
import { zipSync } from 'fflate';

import { EXCEL_MIME_TYPE, extractSpreadsheetRows } from '@/utils/spreadsheet';

import { sanitizeSpreadsheetRows } from '../sanitization';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const DEFAULT_SHEET_NAME = 'Sheet1';
const textEncoder = new TextEncoder();

interface ExcelRow {
  font?: Record<string, unknown>;
}

interface ExcelWorksheet {
  addRows: (rows: DocumentCellValue[][]) => void;
  getRow: (rowNumber: number) => ExcelRow;
}

interface ExcelWorkbook {
  addWorksheet: (name: string) => ExcelWorksheet;
  xlsx: { writeBuffer: () => Promise<ArrayBuffer | Buffer | Uint8Array> };
}

interface ExcelModule {
  Workbook: new () => ExcelWorkbook;
}

export { EXCEL_MIME_TYPE };

const toBytes = (value: string) => textEncoder.encode(value);

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const sanitizeSheetName = (sheetName?: string) => {
  const sanitized = (sheetName || DEFAULT_SHEET_NAME).replaceAll(/[\\/*?:[\]]/g, ' ').trim();
  return sanitized.slice(0, 31) || DEFAULT_SHEET_NAME;
};

const columnName = (index: number) => {
  let column = '';
  let value = index + 1;

  while (value > 0) {
    const remainder = (value - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    value = Math.floor((value - 1) / 26);
  }

  return column;
};

const normalizeRows = (rows: DocumentCellValue[][]) => {
  const compactRows = rows.filter((row) => row.some((cell) => String(cell).trim() !== ''));
  const columnCount = compactRows.reduce((max, row) => Math.max(max, row.length), 0);

  return compactRows.map((row) => Array.from({ length: columnCount }, (_, i) => row[i] ?? ''));
};

const loadExcel = async (): Promise<ExcelModule | null> => {
  try {
    const packageName = 'exceljs';
    const mod = (await import(packageName)) as unknown as ExcelModule;
    return mod.Workbook ? mod : null;
  } catch {
    return null;
  }
};

const toBuffer = (value: ArrayBuffer | Buffer | Uint8Array) => {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};

const renderWithExcelPackage = async (sheets: DocumentSheet[]) => {
  const excel = await loadExcel();
  if (!excel) return null;

  const workbook = new excel.Workbook();
  for (const sheet of sheets) {
    const worksheet = workbook.addWorksheet(sanitizeSheetName(sheet.name));
    worksheet.addRows(normalizeRows(sheet.rows));
    worksheet.getRow(1).font = { bold: true };
  }

  return toBuffer(await workbook.xlsx.writeBuffer());
};

const cellXml = (value: DocumentCellValue, rowIndex: number, columnIndex: number) => {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }

  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  const text = String(value);
  const preserveWhitespace = /^\s|\s$|\n/.test(text);
  const spaceAttr = preserveWhitespace ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"><is><t${spaceAttr}>${escapeXml(text)}</t></is></c>`;
};

const sheetXml = (rows: DocumentCellValue[][]) => {
  const normalizedRows = normalizeRows(rows);
  const rowCount = normalizedRows.length;
  const columnCount = normalizedRows[0]?.length ?? 1;
  const dimension = rowCount ? `A1:${columnName(columnCount - 1)}${rowCount}` : 'A1';
  const sheetRows = normalizedRows
    .map((row, rowIndex) => {
      const cells = row.map((cell, columnIndex) => cellXml(cell, rowIndex, columnIndex)).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
};

const fallbackXlsx = (sheets: DocumentSheet[]) => {
  const contentTypes = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('\n');
  const workbookSheets = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sanitizeSheetName(sheet.name))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');
  const rels = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('\n');

  const worksheetFiles = Object.fromEntries(
    sheets.map((sheet, index) => [`sheet${index + 1}.xml`, toBytes(sheetXml(sheet.rows))]),
  );

  const files = {
    '[Content_Types].xml': toBytes(`${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${contentTypes}
</Types>`),
    '_rels': {
      '.rels': toBytes(`${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    'xl': {
      '_rels': {
        'workbook.xml.rels': toBytes(`${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`),
      },
      'workbook.xml': toBytes(`${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
      'worksheets': worksheetFiles,
    },
  };

  return Buffer.from(zipSync(files, { level: 0 }));
};

export const resolveSheets = (
  markdown: string,
  sheets?: DocumentSheet[],
  fallbackName?: string,
): DocumentSheet[] => {
  if (sheets?.length) {
    return sheets.map((sheet) => ({ ...sheet, rows: sanitizeSpreadsheetRows(sheet.rows) }));
  }

  const rows = extractSpreadsheetRows(markdown) ?? [[markdown]];
  return [{ name: fallbackName ?? DEFAULT_SHEET_NAME, rows: sanitizeSpreadsheetRows(rows) }];
};

export const renderXlsxDocument = async (sheets: DocumentSheet[]): Promise<Buffer> => {
  const safeSheets = sheets.map((sheet) => ({
    ...sheet,
    rows: sanitizeSpreadsheetRows(sheet.rows),
  }));
  const packageBuffer = await renderWithExcelPackage(safeSheets);
  return packageBuffer ?? fallbackXlsx(safeSheets);
};
