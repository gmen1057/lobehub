#!/usr/bin/env bash
# Smart deploy for the arckep LobeChat fork (chat.arckep.ru).
#
# Cuts the 15-20 min "rebuild everything" cycle down by:
#   1. skipping `pnpm install` when package.json/workspace config is unchanged
#      (the fork has NO lockfile — .npmrc sets lockfile=false upstream, so
#      `--frozen-lockfile` always errors out here; plain `pnpm install` only);
#   2. skipping BOTH vite SPA builds (desktop + mobile, ~half the wall time)
#      when every change since the last deployed commit is server-only
#      (src/app/, src/server/, next config, instrumentation, middleware);
#   3. relying on Turbopack filesystem cache for warm `next build` runs
#      (experimental.turbopackFileSystemCacheForBuild in next.config.ts).
#
# Usage: bash deploy-arckep.sh [--full]   (--full forces install + SPA builds)
set -euo pipefail

SRC=/opt/lobechat-src
PROD=/opt/lobechat
SERVICE=image-studio-lobechat
STATE_COMMIT="$PROD/.deployed-commit"
STATE_LOCK_HASH="$PROD/.deployed-lockhash"

cd "$SRC"
FORCE_FULL=${1:-}

if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: uncommitted changes in $SRC — commit first (deploy is diff-driven)." >&2
    git status --porcelain | head >&2
    exit 1
fi

HEAD_COMMIT=$(git rev-parse HEAD)

# --- 1. pnpm install only when dependency manifests changed -----------------
# No lockfile in this fork (.npmrc lockfile=false) — hash every package.json
# in the workspace plus the workspace config instead.
LOCK_HASH=$(cat package.json pnpm-workspace.yaml .npmrc packages/*/package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
if [[ "$FORCE_FULL" == "--full" || ! -f "$STATE_LOCK_HASH" || "$(cat "$STATE_LOCK_HASH")" != "$LOCK_HASH" ]]; then
    echo "[deploy] pnpm install (dependency manifests changed or --full)"
    pnpm install
else
    echo "[deploy] pnpm install skipped (dependency manifests unchanged)"
fi

# --- 2. what changed since the last deploy? ---------------------------------
NEED_SPA=1
if [[ "$FORCE_FULL" != "--full" && -f "$STATE_COMMIT" ]]; then
    LAST=$(cat "$STATE_COMMIT")
    if git cat-file -e "$LAST" 2>/dev/null; then
        CHANGED=$(git diff --name-only "$LAST" "$HEAD_COMMIT")
        if [[ -z "$CHANGED" ]]; then
            echo "[deploy] no changes since deployed commit $LAST — nothing to build"
        fi
        # Server-only paths: not part of the vite SPA bundle (SPA pulls in
        # src/{spa,features,store,components,...} and packages/* — anything
        # there forces the SPA builds).
        SERVER_ONLY_RE='^(src/app/|src/server/|src/middleware\.ts|next\.config\.ts|instrumentation|\.env|deploy-arckep\.sh|Dockerfile|docs/|README)'
        if [[ -n "$CHANGED" ]] && ! grep -qvE "$SERVER_ONLY_RE" <<<"$CHANGED"; then
            NEED_SPA=0
            echo "[deploy] all changes are server-only — skipping vite SPA builds:"
            sed 's/^/    /' <<<"$CHANGED"
        fi
    fi
fi

# --- 3. build ----------------------------------------------------------------
if [[ "$NEED_SPA" == 1 ]]; then
    echo "[deploy] full build (SPA desktop + mobile + next)"
    bun run build
else
    echo "[deploy] next build only"
    bun run build:next
fi

# --- 4. sync to prod ----------------------------------------------------------
rsync -a --delete "$SRC/.next/" "$PROD/.next/"
if [[ "$NEED_SPA" == 1 ]]; then
    rsync -a --delete "$SRC/public/_spa/" "$PROD/public/_spa/"
fi

# --- 5. restart + health ------------------------------------------------------
# Real entry point is arckep.ru/chat/ (basePath /chat, iframe ?embed=1);
# chat.arckep.ru is a legacy 301. Anonymous probe → 302 to login is healthy.
systemctl restart "$SERVICE"
sleep 6
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: arckep.ru" "http://127.0.0.1:3402/chat/")
if [[ "$CODE" != "200" && "$CODE" != "302" ]]; then
    echo "ERROR: LobeChat /chat/ returned HTTP $CODE after restart (expected 200/302)" >&2
    journalctl -u "$SERVICE" -n 30 --no-pager >&2
    exit 1
fi

echo "$HEAD_COMMIT" > "$STATE_COMMIT"
echo "$LOCK_HASH" > "$STATE_LOCK_HASH"
echo "[deploy] OK: /chat/ HTTP $CODE, commit $HEAD_COMMIT deployed"
