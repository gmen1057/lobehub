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

/** Convert USD → RUB at arckep display rate. */
export const usdToRub = (usd: number): number => usd * ARCKEP_RUB_PER_USD;
