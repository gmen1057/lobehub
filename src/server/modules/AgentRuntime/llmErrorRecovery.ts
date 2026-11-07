interface LLMRecoverySignal {
  retrySafe?: boolean;
  status?: number;
}

/** Read the proxy's recovery decision through SDK/error/SSE wrappers. */
export const readLLMRecoverySignal = (error: unknown): LLMRecoverySignal => {
  const seen = new Set<object>();
  const statuses: number[] = [];
  let retrySafe: boolean | undefined;
  let remaining = 128;

  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || remaining-- <= 0) return;
    if (typeof value === 'string') {
      if (value.length > 64_000 || !/^\s*[[{]/.test(value)) return;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        // Ordinary provider text is not a JSON envelope.
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    // A refusal to replay wins over every outer wrapper's generic retry flag.
    if (record.retrySafe === false) retrySafe = false;
    else if (record.retrySafe === true && retrySafe === undefined) retrySafe = true;
    for (const key of ['status', 'statusCode', 'code']) {
      const candidate = record[key];
      const status = typeof candidate === 'number' ? candidate : Number(candidate);
      if (Number.isInteger(status) && status >= 400 && status <= 599) statuses.push(status);
    }
    for (const key of ['error', 'body', 'details', 'cause', 'message']) {
      visit(record[key], depth + 1);
    }
  };

  visit(error);
  // A transport wrapper's 500 must not hide the actual permanent provider refusal.
  const permanent = statuses.find(
    (status) => status >= 400 && status < 500 && ![408, 425, 429].includes(status),
  );
  return { retrySafe, status: permanent ?? statuses.at(-1) };
};
