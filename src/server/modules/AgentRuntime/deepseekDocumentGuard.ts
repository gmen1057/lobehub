/** Provider-parsed text is opaque, so Data Guard cannot inspect it before inference. */
export const assertDeepSeekDocumentsGuardCompatible = (
  protectedRequest: boolean,
  messages: Array<{ metadata?: any; content?: any }>,
  currentDocumentIds?: string[],
) => {
  if (!protectedRequest) return;
  const hasDocuments =
    !!currentDocumentIds?.length ||
    messages.some(
      (message) =>
        !!message.metadata?.deepseek_document_ids?.length ||
        (Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part.type === 'file' &&
              typeof part.file_id === 'string' &&
              part.file_id.startsWith('arkdoc_'),
          )),
    );
  if (hasDocuments) throw new Error('Parsed documents cannot be used while Data Guard is enabled');
};
