# Claude Haiku 5.5

Companion to the image-studio PR "feat(chat): Claude Haiku 5.5". Target: arckep/v2.1.46.

The builtin Anthropic provider gets a `claude-haiku-5-5` card (1M context, 128K output,
function calling, reasoning, search, structured output, vision). The picker label for Haiku 4.5
becomes "Claude Haiku 4.5 (legacy)"; the card stays enabled and its description points to 5.5.

## Prices (per million tokens)

|                  | prompt <=100K | prompt >100K |
| ---------------- | ------------- | ------------ |
| input            | $0.10         | $0.50        |
| output           | $0.50         | $2.50        |
| cache read       | $0.01         | $0.05        |
| cache write (5m) | $0.125        | $0.625       |
| cache write (1h) | $0.20         | $1.00        |

A prompt over 100K tokens (input + cache read + cache write) moves the WHOLE request to the
long tier (x5). Anthropic does not say whether cache tokens count towards the threshold; we count
all of them. The card expresses the long tier with `tiered` pricing for input, output and cache
read (tier picked by `totalInputTokens`). Cache write is a `ttl` lookup and cannot also be tiered,
so it keeps the short-tier price in the card. The studio billing proxy charges the real long tier
server-side (sell 11/55 RUB -> 55/275 RUB per 1M input/output).

## Request shape (`buildDefaultAnthropicPayload`)

Haiku 5.5 has its own branch; it does not reuse the Sonnet 5.5 one.

- No `temperature`/`top_p`/`top_k` and never `budget_tokens` (all return 400).
- Effort goes to `output_config.effort` and defaults to `low` (chat default; the API default is
  `medium`). The picker slider shows `low` for Haiku 5.5 when nothing is stored, so the UI matches.
- Thinking is `{ type: 'adaptive', display: 'summarized' }` by default and when thinking is
  enabled (without `summarized` the thinking blocks come back empty). An explicit
  `thinking: disabled` is kept only with effort low/medium/high; with xhigh/max it falls back to
  adaptive (disabled + xhigh/max is a 400). The chat UI has no thinking toggle for this card.
- A trailing assistant turn (prefill, 400) is dropped before the messages are built, so the
  cache breakpoint stays on the last user turn. Messages are never emptied.
- Tools, the search tool, system prompts and caching work as in the generic path. The chat
  builder sends no `tool_choice`; `generateObject` forces a tool, which Haiku 5.5 accepts.

## Release

Append to the existing server `.env` list, and put it BEFORE `+claude-haiku-4-5-20251001` so the
picker shows 5.5 first (order follows the env list):

- ANTHROPIC_MODEL_LIST: +claude-haiku-5-5=Claude Haiku 5.5<1000000:fc:vision:reasoning>

Keep `+claude-haiku-4-5-20251001`. Without `=name` it takes the card label "Claude Haiku 4.5
(legacy)"; add `=Claude Haiku 4.5 (legacy)` only if you want the label pinned in the env.

FYI, not changed here: the live list (`-all,...`) has no `claude-sonnet-5-5`, `claude-opus-5-5` or
`claude-fable-5-1`.

Deploy the studio backend first (request normalization and the >100K billing tier). Then build
and sync both `.next/` and `public/_spa/` before restarting LobeChat (the effort slider default
is in the SPA). Deployment requires owner approval; no production config is changed by this PR.

## Tests

`packages/model-runtime/src/core/usageConverters/utils/computeChatCost.test.ts` reads the card
through `model-bank`, so it needs a workspace-linked `model-bank` (CI). In a worktree whose
`node_modules` point at another checkout it sees the old card and fails.
