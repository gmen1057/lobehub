interface UriParserResult {
  base64: string | null;
  mimeType: string | null;
  type: 'url' | 'base64' | null;
}

export const parseDataUri = (dataUri: string): UriParserResult => {
  if (typeof dataUri !== 'string' || dataUri.length === 0) {
    return { base64: null, mimeType: null, type: null };
  }

  // Use indexOf instead of regex to avoid stack overflow on large data URIs (e.g. 26MB+ base64 images)
  const DATA_PREFIX = 'data:';
  const BASE64_MARKER = ';base64,';

  if (dataUri.slice(0, DATA_PREFIX.length).toLowerCase() === DATA_PREFIX) {
    const markerIndex = dataUri.indexOf(BASE64_MARKER, DATA_PREFIX.length);
    if (markerIndex >= DATA_PREFIX.length) {
      const rawMime = dataUri.slice(DATA_PREFIX.length, markerIndex).trim();
      const base64 = dataUri.slice(markerIndex + BASE64_MARKER.length);
      if (base64.length > 0) {
        return { base64, mimeType: rawMime.length > 0 ? rawMime : null, type: 'base64' };
      }
    }
    // Malformed or non-base64 `data:` URIs must never fall through to `new URL(dataUri)` -> `type: 'url'`
    return { base64: null, mimeType: null, type: null };
  }

  try {
    new URL(dataUri);
    // If it's a valid URL
    return { base64: null, mimeType: null, type: 'url' };
  } catch {
    // Neither a Data URI nor a valid URL
    return { base64: null, mimeType: null, type: null };
  }
};
