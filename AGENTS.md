# LobeHub Development Guidelines

This document serves as a comprehensive guide for all team members when developing LobeHub.

## Project Description

You are developing an open-source, modern-design AI Agent Workspace: LobeHub (previously LobeChat).

## Tech Stack

- **Frontend**: Next.js 16, React 19, TypeScript
- **UI Components**: Ant Design, @lobehub/ui, antd-style
- **State Management**: Zustand, SWR
- **Database**: PostgreSQL, PGLite, Drizzle ORM
- **Testing**: Vitest, Testing Library
- **Package Manager**: pnpm (monorepo structure)

## Directory Structure

```plaintext
lobehub/
├── apps/desktop/           # Electron desktop app
├── packages/               # Shared packages (@lobechat/*)
│   ├── database/           # Database schemas, models, repositories
│   ├── agent-runtime/      # Agent runtime
│   └── ...
├── src/
│   ├── app/                # Next.js app router
│   ├── spa/                # SPA entry points (entry.*.tsx) and router config
│   ├── routes/             # SPA page components (roots)
│   ├── features/           # Business components by domain
│   ├── store/              # Zustand stores
│   ├── services/           # Client services
│   ├── server/             # Server services and routers
│   └── ...
├── .agents/skills/         # AI development skills
└── e2e/                    # E2E tests (Cucumber + Playwright)
```

## Development Workflow

### Git Workflow

- **Branch strategy**: `canary` is the development branch (cloud production); `main` is the release branch (periodically cherry-picks from canary)
- New branches should be created from `canary`; PRs should target `canary`
- Use rebase for git pull
- Git commit messages should prefix with gitmoji
- Git branch name format: `feat/feature-name`
- Use `.github/PULL_REQUEST_TEMPLATE.md` for PR descriptions
- **Protection of local changes**: Never use `git restore`, `git checkout --`, `git reset --hard`, or any other command or workflow that can forcibly overwrite, discard, or silently replace user-owned uncommitted changes. Before any revert or restoration affecting existing files, inspect the working tree carefully and obtain explicit user confirmation.

### Package Management

- Use `pnpm` as the primary package manager
- Use `bun` to run npm scripts
- Use `bunx` to run executable npm packages

### Code Style Guidelines

#### TypeScript

- Prefer interfaces over types for object shapes

### Testing Strategy

```bash
# Web tests
bunx vitest run --silent='passed-only' '[file-path-pattern]'

# Package tests (e.g., database)
cd packages/[package-name] && bunx vitest run --silent='passed-only' '[file-path-pattern]'
```

**Important Notes**:

- Wrap file paths in single quotes to avoid shell expansion
- Never run `bun run test` - this runs all tests and takes \~10 minutes

### Type Checking

- Use `bun run type-check` to check for type errors

### i18n

- **Keys**: Add to `src/locales/default/namespace.ts`
- **Dev**: Translate `locales/zh-CN/namespace.json` locale file only for preview
- DON'T run `pnpm i18n`, let CI auto handle it

## SPA Routes and Features

- **`src/routes/`** holds only page segments (`_layout/index.tsx`, `index.tsx`, `[id]/index.tsx`). Keep route files **thin** — import from `@/features/*` and compose, no business logic.
- **`src/features/`** holds business components by **domain** (e.g. `Pages`, `PageEditor`, `Home`). Layout pieces, hooks, and domain UI go here.
- **Desktop router parity:** When changing the main SPA route tree, update **both** `src/spa/router/desktopRouter.config.tsx` (dynamic imports) and `src/spa/router/desktopRouter.config.desktop.tsx` (sync imports) so paths and nesting match. Changing only one can leave routes unregistered and cause **blank screens**.
- See the **spa-routes** skill (`.agents/skills/spa-routes/SKILL.md`) for the full convention and file-division rules.

## Code intelligence

This project is indexed by codegraph (`/root/codegraph-mcp-server`). Cached artifacts:

- `/var/cache/codegraph/lobechat/api-map.json` — HTTP routes + callers + external_callers
- `/var/cache/codegraph/lobechat/symbol-index.sqlite` — TS AST
- `/var/cache/codegraph/lobechat/schema.cache.json` — DB schema

### Reading artifacts (Codex / Grok / Gemini)

- `jq '.routes[] | select(.path == "/api/X")' /var/cache/codegraph/lobechat/api-map.json`
- `sqlite3 /var/cache/codegraph/lobechat/symbol-index.sqlite "SELECT * FROM symbols WHERE name='Foo' LIMIT 10"`

### Querying via Claude (mcp\_\_codegraph\_\_\*)

- `find_routes`, `find_symbol`, `endpoint_impact`, `find_doc_drift`, `impact_map`, etc.
- 12 safe tools — see /root/codegraph-mcp-server/CONTRACT.md

### Cross-project edges (external_hosts)

LobeChat вызывает image-studio backend по `http://127.0.0.1:8202` (loopback). Это прописано в `.agents/codegraph.json` как `external_hosts`. Работающая cross-project связка:

- `src/app/(backend)/api/bridge/route.ts:39` → image-studio `/api/auth/validate` GET

Billing-proxy (`${process.env.IMAGE_STUDIO_API_URL}/api/billing-proxy/*`) пока не резолвится через codegraph: URL строится через env-var, не literal. Ожидаем появления literal fetch для полноценного cross-project графа.

### When to use

- Cross-cutting feature (route + service + DB + UI)
- Refactor of shared util
- Doc-only fixes after a feature

### When NOT to use

- Trivial 1-2 line fixes
- Work-in-progress (artifacts may be stale)

## Skills (Auto-loaded)

All AI development skills are available in `.agents/skills/` directory and auto-loaded by Claude Code when relevant.

**IMPORTANT**: When reviewing PRs or code diffs, ALWAYS read `.agents/skills/code-review/SKILL.md` first.
