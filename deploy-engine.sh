#!/usr/bin/env bash
# Выкладка движка чата (LobeChat без интерфейса) — экземпляр image-studio-lobechat-next, порт 3403.
#
# Отличия от deploy-arckep.sh (живой интерфейс на 3402):
#   * источник — worktree ветки arckep/engine, а не /opt/lobechat-src;
#   * интерфейс (vite SPA desktop+mobile) НИКОГДА не собирается (план lobechat-engine-studio-chat, D7);
#     public/_spa в каталоге выкладки остаётся как есть (старые артефакты, наружу не отдаются);
#   * health — GET /chat/ на 3403 (200/302) и GET /chat/api/v1/health/ → status ok.
#
# Usage: bash deploy-engine.sh [--install]   (--install форсирует pnpm install)
set -euo pipefail

SRC=${ENGINE_SRC:-/var/tmp/wt/lobechat-engine}
PROD=${ENGINE_PROD:-/opt/lobechat-next}
SERVICE=${ENGINE_SERVICE:-image-studio-lobechat-next}
PORT=${ENGINE_PORT:-3403}
STATE_COMMIT="$PROD/.deployed-commit"
STATE_LOCK_HASH="$PROD/.deployed-lockhash"

cd "$SRC"
FORCE_INSTALL=${1:-}

command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$PATH"

if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: uncommitted changes in $SRC — commit first (deploy is diff-driven)." >&2
    git status --porcelain | head >&2
    exit 1
fi

HEAD_COMMIT=$(git rev-parse HEAD)

LOCK_HASH=$(cat pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc packages/*/package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
if [[ "$FORCE_INSTALL" == "--install" || ! -f "$STATE_LOCK_HASH" || "$(cat "$STATE_LOCK_HASH")" != "$LOCK_HASH" ]]; then
    echo "[engine] pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
else
    echo "[engine] pnpm install skipped (lockfile/manifests unchanged)"
fi

if [[ ! -d public/_spa ]]; then
    echo "[engine] public/_spa отсутствует — беру готовые артефакты из /opt/lobechat-src/public/_spa (интерфейс не собираем)"
    rsync -a /opt/lobechat-src/public/_spa/ public/_spa/
fi

echo "[engine] next build only (SPA never rebuilt here)"
bun run build:next

rsync -a --delete "$SRC/.next/" "$PROD/.next/"
if id lobechat >/dev/null 2>&1; then
    chown -R lobechat:lobechat "$PROD/.next"
fi

systemctl restart "$SERVICE"
sleep 6
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: arckep.ru" "http://127.0.0.1:$PORT/chat/")
if [[ "$CODE" != "200" && "$CODE" != "302" ]]; then
    echo "ERROR: engine /chat/ returned HTTP $CODE after restart (expected 200/302)" >&2
    tail -n 40 "/var/log/$SERVICE.log" >&2
    exit 1
fi
HEALTH=$(curl -sS -H "Host: arckep.ru" "http://127.0.0.1:$PORT/chat/api/v1/health/" || true)
echo "[engine] health: $HEALTH"

echo "$HEAD_COMMIT" > "$STATE_COMMIT"
echo "$LOCK_HASH" > "$STATE_LOCK_HASH"
echo "[engine] OK: /chat/ HTTP $CODE, commit $HEAD_COMMIT deployed to $PROD"
