/** Runtime guard: tool JSON schemas do not validate persisted/model-supplied arguments. */
export const getSearchQueryError = (
  input: unknown,
): { code: 'invalid_query' | 'missing_query'; message: string } | undefined => {
  const query =
    input && typeof input === 'object' ? (input as { query?: unknown }).query : undefined;
  if (query === undefined) {
    return { code: 'missing_query', message: 'searchKnowledgeBase requires a query.' };
  }
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { code: 'invalid_query', message: 'query must be a non-empty string.' };
  }
};

export const searchQueryRetryMessage = (error: { code: string; message: string }): string =>
  `${error.code}: ${error.message} Retry searchKnowledgeBase with a non-empty string query based on the user's request. No search was performed.`;
