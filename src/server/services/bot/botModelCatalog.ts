import debug from 'debug';

const log = debug('lobe-server:service:bot-model-catalog');

const IMAGE_STUDIO_BASE = 'http://127.0.0.1:8202';
const CATALOG_TTL_MS = 60_000; // 60s TTL for in-memory cache

interface ModelsResponse {
  data: Array<{ id: string }>;
}

let cachedIds: Set<string> | null = null;
let cachedAt: number = 0;

function getBaseUrl(): string {
  const raw = process.env.IMAGE_STUDIO_API_URL || IMAGE_STUDIO_BASE;
  return raw.replace(/\/$/, '');
}

function getInternalToken(): string | undefined {
  return process.env.ARCKEP_INTERNAL_TOKEN || process.env.LOBECHAT_BACKEND_KEY;
}

/**
 * Fetch valid model IDs from the image-studio backend catalog.
 * Uses in-memory TTL cache (60s) to avoid hammering the backend on every setModel call.
 */
export async function fetchValidModelIds(): Promise<Set<string>> {
  const now = Date.now();
  if (cachedIds && now - cachedAt < CATALOG_TTL_MS) {
    return cachedIds;
  }

  const baseUrl = getBaseUrl();
  const token = getInternalToken();

  const res = await fetch(`${baseUrl}/api/chat/openai-compat/v1/models`, {
    headers: token ? { 'x-arckep-token': token } : {},
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Catalog fetch failed: HTTP ${res.status}`);
  }

  const body = (await res.json()) as ModelsResponse;
  const ids = new Set<string>(body.data?.map((m) => m.id) ?? []);

  cachedIds = ids;
  cachedAt = now;
  log('catalog refreshed: %d models', ids.size);
  return ids;
}

function listForProvider(allIds: Set<string>, provider: string): string[] {
  const prefix = `${provider}/`;
  const matches: string[] = [];
  for (const id of allIds) {
    if (id.startsWith(prefix)) matches.push(id);
  }
  return matches;
}

/**
 * Validate that a provider/modelName pair exists in the catalog.
 * Returns { ok: true } on success, or { ok: false, message } with a
 * human-readable error message in Russian for the LLM agent to consume.
 */
export async function assertModelValid(
  provider: string,
  modelName: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const id = `${provider}/${modelName}`;

  let allIds: Set<string>;
  try {
    allIds = await fetchValidModelIds();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('catalog fetch failed, rejecting setModel: %s', reason);
    return {
      ok: false,
      message: 'Не удалось проверить модель (каталог недоступен), попробуйте ещё раз позже.',
    };
  }

  if (allIds.has(id)) {
    return { ok: true };
  }

  // Build a helpful list: provider-matched models first, else first ~8
  const providerMatches = listForProvider(allIds, provider);
  let list: string;
  if (providerMatches.length > 0) {
    list = providerMatches.join(', ');
  } else {
    list = [...allIds].slice(0, 8).join(', ');
  }

  return {
    ok: false,
    message: `Модель «${id}» недоступна. Доступные: ${list}`,
  };
}
