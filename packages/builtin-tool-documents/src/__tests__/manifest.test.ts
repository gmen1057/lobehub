import { describe, expect, it } from 'vitest';

import { DocumentsManifest } from '../manifest';
import { DocumentFormat, DocumentsApiName, DocumentsIdentifier } from '../types';

describe('DocumentsManifest', () => {
  it('has the expected identifier and one generateDocument api', () => {
    expect(DocumentsManifest.identifier).toBe(DocumentsIdentifier);
    expect(DocumentsManifest.api).toHaveLength(1);
    expect(DocumentsManifest.api[0].name).toBe(DocumentsApiName.generateDocument);
  });

  it('exposes provider-friendly document format enum', () => {
    const format = DocumentsManifest.api[0].parameters.properties?.format as { enum: string[] };

    expect(format.enum).toEqual([
      DocumentFormat.Pdf,
      DocumentFormat.Docx,
      DocumentFormat.Xlsx,
      DocumentFormat.Markdown,
    ]);
    expect(DocumentsManifest.api[0].parameters.required).toEqual([
      'format',
      'title',
      'filename',
      'contentMarkdown',
    ]);
  });
});
