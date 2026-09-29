# Sonnet 5.5 and GPT-6.1 Sol

Companion to image-studio PR #240. Target: arckep/v2.1.46.

The builtin provider cards expose both models with provider prices and limits.
GPT-6.1 Sol uses Responses, valid low/medium/high/xhigh/max reasoning (medium
by default), $0.10 cached input and $2.50 cache writes per million tokens.
Sonnet 5.5 uses adaptive thinking and effort; obsolete budget/sampling controls
are omitted. It has $0.20 cached input and $2.50/$4 cache writes (5m/1h).
Both have base $2/$10 input/output per million tokens.

At release, append these to the existing server `.env` lists:
- OPENAI_MODEL_LIST: +gpt-6.1-sol=GPT-6.1 Sol<1050000:fc:vision:reasoning>
- ANTHROPIC_MODEL_LIST: +claude-sonnet-5-5=Claude Sonnet 5.5<1000000:fc:vision:reasoning>

Deploy the Studio backend first for model pricing and Sonnet request hygiene.
Build and sync both `.next/` and `public/_spa/` before restarting LobeChat.
Deployment requires owner approval; no production config is changed by this PR.

GPT-6.1 Sol requests above 272K input tokens use the full-request long tier:
$4/$15 input/output, $0.20 cache read and $5 cache write per million tokens.
