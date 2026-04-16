import { zipSync } from 'fflate';

export const EXCEL_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const DEFAULT_SHEET_NAME = 'Sheet1';
const DELIMITER_CANDIDATES = [',', ';', '\t'] as const;
const SPREADSHEET_FILE_KEYWORDS = [
  'excel',
  'exel',
  'xlsx',
  'xls',
  'spreadsheet',
  'csv',
  'tsv',
  'эксел',
  'эксель',
];
const TABLE_REQUEST_KEYWORDS = ['таблица', 'таблицу', 'таблицей', 'таблицы', 'таблице', 'table'];
const FILE_REQUEST_KEYWORDS = ['файл', 'file', 'скач', 'download', 'прикреп', 'attach'];
const textEncoder = new TextEncoder();

const toBytes = (value: string) => textEncoder.encode(value);

const escapeXml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const sanitizeSheetName = (sheetName: string) => {
  const sanitized = sheetName.replaceAll(/[\\/*?:[\]]/g, ' ').trim();

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

const countDelimiterOccurrences = (line: string, delimiter: string) => {
  let count = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }

  return count;
};

const detectDelimiter = (input: string, preferred?: string) => {
  if (preferred) return preferred;

  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  let bestDelimiter: string | null = null;
  let bestScore = -1;

  for (const delimiter of DELIMITER_CANDIDATES) {
    let matchingLines = 0;
    let totalOccurrences = 0;

    for (const line of lines) {
      const occurrences = countDelimiterOccurrences(line, delimiter);
      if (occurrences > 0) {
        matchingLines += 1;
        totalOccurrences += occurrences;
      }
    }

    if (matchingLines < 2) continue;

    const score = matchingLines * 100 + totalOccurrences;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delimiter;
    }
  }

  return bestDelimiter;
};

const trimTrailingEmptyCells = (row: string[]) => {
  const nextRow = [...row];

  while (nextRow.length > 0 && nextRow.at(-1)?.trim() === '') {
    nextRow.pop();
  }

  return nextRow;
};

const normalizeRows = (rows: string[][]) => {
  const compactRows = rows
    .map(trimTrailingEmptyCells)
    .filter((row) => row.some((cell) => cell.trim() !== ''));

  const columnCount = compactRows.reduce((max, row) => Math.max(max, row.length), 0);

  if (columnCount === 0) return [];

  return compactRows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => row[index] ?? ''),
  );
};

const isTabular = (rows: string[][], options?: { allowSingleRow?: boolean }) => {
  const normalizedRows = normalizeRows(rows);
  const minimumRows = options?.allowSingleRow ? 1 : 2;
  if (normalizedRows.length < minimumRows) return false;

  return normalizedRows[0].length > 1;
};

const parseDelimitedRows = (input: string, delimiter: string) => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (char === '"') {
      if (inQuotes && input[index + 1] === '"') {
        cell += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && input[index + 1] === '\n') {
        index += 1;
      }

      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return normalizeRows(rows);
};

const parseMarkdownTableRow = (line: string) => {
  const trimmedLine = line.trim().replace(/^\|/, '').replace(/\|$/, '');

  return trimmedLine.split('|').map((cell) => cell.trim().replaceAll('\\|', '|'));
};

const isMarkdownSeparatorCell = (cell: string) => /^:?-{3,}:?$/.test(cell.trim());

const isMarkdownSeparatorLine = (line: string) => {
  const trimmedLine = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  if (!trimmedLine.includes('|')) return false;

  const cells = trimmedLine
    .split('|')
    .map((cell) => cell.trim())
    .filter(Boolean);
  if (cells.length < 2) return false;

  return cells.every(isMarkdownSeparatorCell);
};

const isMarkdownTableLine = (line: string) => {
  const trimmedLine = line.trim();

  return trimmedLine.includes('|') && !trimmedLine.startsWith('```');
};

const extractRowsFromCodeBlock = (input: string) => {
  const codeBlockRegex = /```(?<info>[^\n`]*)\n(?<body>[\s\S]*?)```/g;

  for (const match of input.matchAll(codeBlockRegex)) {
    const info = match.groups?.info?.trim().toLowerCase() ?? '';
    const body = match.groups?.body?.trim() ?? '';
    if (!body) continue;

    const preferredDelimiter = info === 'tsv' ? '\t' : undefined;

    const delimiter = detectDelimiter(body, preferredDelimiter);
    if (!delimiter) continue;

    const rows = parseDelimitedRows(body, delimiter);
    if (isTabular(rows, { allowSingleRow: true })) return rows;
  }

  return null;
};

const extractRowsFromMarkdownTable = (input: string) => {
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isMarkdownTableLine(lines[index]) || !isMarkdownSeparatorLine(lines[index + 1])) continue;

    const rows = [parseMarkdownTableRow(lines[index])];

    for (let nextIndex = index + 2; nextIndex < lines.length; nextIndex += 1) {
      const line = lines[nextIndex];
      if (!line.trim()) break;
      if (!isMarkdownTableLine(line) || isMarkdownSeparatorLine(line)) break;

      rows.push(parseMarkdownTableRow(line));
    }

    if (isTabular(rows, { allowSingleRow: true })) {
      return normalizeRows(rows);
    }
  }

  return null;
};

const extractRowsFromPlainDelimitedText = (input: string) => {
  const delimiter = detectDelimiter(input);
  if (!delimiter) return null;

  const rows = parseDelimitedRows(input, delimiter);

  return isTabular(rows) ? rows : null;
};

const isNumericCell = (value: string) => {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return false;
  if (/^-?0\d+/.test(value)) return false;

  return true;
};

const buildCellXml = (value: string, rowIndex: number, columnIndex: number) => {
  const cellReference = `${columnName(columnIndex)}${rowIndex + 1}`;
  const trimmedValue = value.trim();

  if (trimmedValue !== '' && trimmedValue === value && isNumericCell(trimmedValue)) {
    return `<c r="${cellReference}"><v>${trimmedValue}</v></c>`;
  }

  const preserveWhitespace = /^\s|\s$|\n/.test(value);
  const spaceAttr = preserveWhitespace ? ' xml:space="preserve"' : '';

  return `<c r="${cellReference}" t="inlineStr"><is><t${spaceAttr}>${escapeXml(value)}</t></is></c>`;
};

const buildSheetXml = (rows: string[][]) => {
  const normalizedRows = normalizeRows(rows);
  const rowCount = normalizedRows.length;
  const columnCount = normalizedRows[0]?.length ?? 1;
  const lastCellReference = `${columnName(columnCount - 1)}${rowCount}`;
  const dimension = rowCount > 0 ? `A1:${lastCellReference}` : 'A1';

  const sheetRows = normalizedRows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => buildCellXml(cell, rowIndex, columnIndex))
        .join('');

      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `${XML_HEADER}
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="${dimension}"/>
  <sheetViews>
    <sheetView workbookViewId="0"/>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
};

export const extractSpreadsheetRows = (input: string) => {
  const normalizedInput = input.trim();

  return (
    extractRowsFromCodeBlock(normalizedInput) ??
    extractRowsFromMarkdownTable(normalizedInput) ??
    extractRowsFromPlainDelimitedText(normalizedInput)
  );
};

const extractTextContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => extractTextContent(item))
      .filter(Boolean)
      .join(' ');
  }

  if (!content || typeof content !== 'object') return '';

  const record = content as Record<string, unknown>;

  if (typeof record.text === 'string') return record.text;
  if ('content' in record) return extractTextContent(record.content);

  return '';
};

const getLatestUserMessageText = (messages: Array<{ content?: unknown; role?: string }>) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;

    const text = extractTextContent(messages[index]?.content).trim();
    if (text) return text;
  }

  return '';
};

export const shouldAutoAttachSpreadsheet = (
  assistantContent: string,
  messages: Array<{ content?: unknown; role?: string }>,
) => {
  if (!extractSpreadsheetRows(assistantContent)) return false;

  const latestUserText = getLatestUserMessageText(messages);
  if (!latestUserText) return false;

  const normalizedUserText = latestUserText.toLowerCase();
  const hasSpreadsheetKeyword = SPREADSHEET_FILE_KEYWORDS.some((keyword) =>
    normalizedUserText.includes(keyword),
  );
  const hasTableIntent = TABLE_REQUEST_KEYWORDS.some((keyword) =>
    normalizedUserText.includes(keyword),
  );
  const hasFileIntent = FILE_REQUEST_KEYWORDS.some((keyword) =>
    normalizedUserText.includes(keyword),
  );

  return hasSpreadsheetKeyword || (hasTableIntent && hasFileIntent);
};

export const buildXlsxFile = (
  rows: string[][],
  options?: { createdAt?: string; sheetName?: string },
) => {
  const normalizedRows = normalizeRows(rows);
  const sheetName = sanitizeSheetName(options?.sheetName ?? DEFAULT_SHEET_NAME);
  const createdAt = options?.createdAt ?? new Date().toISOString();

  const files = {
    '[Content_Types].xml': toBytes(`${XML_HEADER}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`),
    '_rels': {
      '.rels': toBytes(`${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
 </Relationships>`),
    },
    'docProps': {
      'app.xml': toBytes(`${XML_HEADER}
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>LobeChat</Application>
</Properties>`),
      'core.xml': toBytes(`${XML_HEADER}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:creator>LobeChat</dc:creator>
  <cp:lastModifiedBy>LobeChat</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${createdAt}</dcterms:modified>
</cp:coreProperties>`),
    },
    'xl': {
      '_rels': {
        'workbook.xml.rels': toBytes(`${XML_HEADER}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`),
      },
      'workbook.xml': toBytes(`${XML_HEADER}
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`),
      'worksheets': {
        'sheet1.xml': toBytes(buildSheetXml(normalizedRows)),
      },
    },
  };

  return zipSync(files, { level: 0 });
};

export const downloadXlsxFile = (rows: string[][], filename: string, sheetName?: string) => {
  const blob = new Blob([buildXlsxFile(rows, { sheetName })], {
    type: EXCEL_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
};
