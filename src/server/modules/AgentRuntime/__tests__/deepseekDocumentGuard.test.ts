import { expect, it } from 'vitest';

import { assertDeepSeekDocumentsGuardCompatible } from '../deepseekDocumentGuard';

it('rejects current and previous opaque documents before inference when Data Guard is effective', () => {
  expect(() => assertDeepSeekDocumentsGuardCompatible(true, [], ['arkdoc_current'])).toThrow(
    'Data Guard',
  );
  expect(() =>
    assertDeepSeekDocumentsGuardCompatible(true, [
      { metadata: { deepseek_document_ids: ['arkdoc_old'] } },
    ]),
  ).toThrow('Data Guard');
  expect(() =>
    assertDeepSeekDocumentsGuardCompatible(true, [
      { content: [{ type: 'file', file_id: 'arkdoc_old' }] },
    ]),
  ).toThrow('Data Guard');
  expect(() => assertDeepSeekDocumentsGuardCompatible(false, [], ['arkdoc_current'])).not.toThrow();
  expect(() =>
    assertDeepSeekDocumentsGuardCompatible(true, [{ content: 'plain text' }]),
  ).not.toThrow();
});
