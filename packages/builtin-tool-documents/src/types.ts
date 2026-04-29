export enum DocumentFormat {
  Docx = 'docx',
  Markdown = 'md',
  Pdf = 'pdf',
  Xlsx = 'xlsx',
}

export enum DocumentsApiName {
  generateDocument = 'generateDocument',
}

export const DocumentsIdentifier = 'lobe-documents';

export type DocumentCellValue = boolean | number | string;

export interface DocumentSheet {
  name?: string;
  rows: DocumentCellValue[][];
}

export interface GenerateDocumentInput {
  contentMarkdown: string;
  filename: string;
  format: DocumentFormat;
  idempotencyKey?: string;
  messageId?: string;
  sheets?: DocumentSheet[];
  title: string;
  toolCallId?: string;
  topicId?: null | string;
}

export interface GenerateDocumentResult {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  toolIdentifier?: string;
  url: string;
}

export interface GenerateDocumentState extends Partial<GenerateDocumentResult> {
  error?: string;
  filename?: string;
  format?: DocumentFormat;
  status: 'error' | 'success';
  title?: string;
}

export interface DocumentsRuntimeService {
  generateDocument: (input: GenerateDocumentInput) => Promise<GenerateDocumentResult>;
}
