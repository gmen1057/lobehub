/**
 * arckep: shared pricing constants for stats display.
 *
 * LobeChat stores `messages.metadata.cost` in USD (computed from tokens ×
 * upstream model pricing). Our billing-proxy charges the user in RUB at our
 * own rate (custom per-model, typically ×1.1 markup over upstream). The stats
 * page wouldn't match actual balance deductions if we kept dollars.
 *
 * This constant is what we multiply LobeChat's stored USD cost by when
 * rendering the `/settings/stats` page so it matches user expectations and
 * balance widget. It's a display-only conversion — real billing happens in
 * our FastAPI billing_proxy with per-model precision.
 */
export const ARCKEP_RUB_PER_USD = 110;
export const ARCKEP_CURRENCY_SYMBOL = '₽';

/**
 * A request that goes through OpenRouter is charged 5.5% more (OpenRouter's card
 * top-up fee, owner decision 2026-10-13). Mirrors image-studio
 * `backend/app/data/llm_routes.py` (`is_openrouter_transport`) and
 * `sell_pricing.OPENROUTER_FEE_MULTIPLIER` — change both sides together.
 */
export const ARCKEP_OPENROUTER_FEE = 1.055;

/**
 * Billing started charging the fee when image-studio PR #552 went live
 * (backend deploy 2026-10-13 13:06:47 CEST). Older requests were charged without it.
 */
export const ARCKEP_OPENROUTER_FEE_FROM = Date.parse('2026-10-13T11:06:47Z');

// Vendor prefixes that only go through OpenRouter (backend `OPENROUTER_PREFIXES`).
const OPENROUTER_PREFIXES = new Set([
  'openrouter',
  'moonshotai',
  'z-ai',
  'minimax',
  'tencent',
  'xiaomi',
  'mistral',
  'meta',
]);

/**
 * Provider `openrouter` is sent to openrouter.ai by the billing proxy (even `openai/...`
 * models); otherwise the vendor prefix of the model id decides.
 */
export const isOpenRouterRoute = (provider?: string | null, model?: string | null): boolean => {
  if ((provider || '').trim().toLowerCase() === 'openrouter') return true;
  if (!model || !model.includes('/')) return false;
  return OPENROUTER_PREFIXES.has(model.split('/')[0]);
};

/** Convert USD → RUB at arckep display rate. */
export const usdToRub = (usd: number): number => usd * ARCKEP_RUB_PER_USD;

interface SpendRecord {
  createdAt?: Date | string | number | null;
  model?: string | null;
  provider?: string | null;
  spend?: number | null;
}

// A request without a date is treated as a current one.
const chargedWithFee = (createdAt: SpendRecord['createdAt']): boolean => {
  if (createdAt === null || createdAt === undefined) return true;
  const at = new Date(createdAt).getTime();
  return Number.isNaN(at) || at >= ARCKEP_OPENROUTER_FEE_FROM;
};

/** USD → RUB of one request, as charged: ×1.055 when it went through OpenRouter after the switch. */
export const spendToRub = (usd: number, record: Omit<SpendRecord, 'spend'>): number =>
  usdToRub(usd) *
  (isOpenRouterRoute(record.provider, record.model) && chargedWithFee(record.createdAt)
    ? ARCKEP_OPENROUTER_FEE
    : 1);

/** RUB total of several requests, each at its own route rate. */
export const recordsSpendRub = (records?: SpendRecord[] | null): number =>
  (records || []).reduce((acc, record) => acc + spendToRub(record.spend || 0, record), 0);
