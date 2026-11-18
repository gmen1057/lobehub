#!/usr/bin/env bash
# Выкладка движка чата (LobeChat без интерфейса) — экземпляр image-studio-lobechat-next, порт 3403.
#
# Отличия от deploy-arckep.sh (остановленный старый интерфейс на 3402):
#   * источник — worktree ветки arckep/engine, а не /opt/lobechat-src;
#   * интерфейс (vite SPA desktop+mobile) НИКОГДА не собирается (план lobechat-engine-studio-chat, D7);
#     public/_spa в каталоге выкладки остаётся как есть (старые артефакты, наружу не отдаются);
#   * сборка идёт в режиме NEXT_BUILD_STANDALONE=1, чтобы вместе с .next/ атомарно доставлялись
#     свежий server.js и актуальные node_modules (включая next, undici и нативные sharp/@napi-rs/canvas)
#     без внешних симлинков в /var/tmp или /root (systemd: PrivateTmp=true, ProtectHome=true);
#   * перед переключением сохраняется полная резервная копия предыдущего слота ($PROD.prev) для мгновенного rollback,
#     а $PROD/.env переносится с сохранением прав root:root 0600 и сверкой побайтово;
#   * health — GET /chat/ на 3403 (200/302) и GET /chat/api/v1/health/ → status ok.
#
# Usage:
#   bash deploy-engine.sh                  # обычная сборка и выкладка
#   bash deploy-engine.sh --install        # форсирует pnpm install --frozen-lockfile перед сборкой
#   bash deploy-engine.sh --rollback       # мгновенный атомарный откат на предыдущий слот ($PROD.prev)
#   bash deploy-engine.sh --stage-only [D] # собрать и проверить standalone-слот в каталоге D без выкладки в $PROD
set -euo pipefail

SRC=${ENGINE_SRC:-/var/tmp/wt/lobechat-engine}
PROD=${ENGINE_PROD:-/opt/lobechat-next}
BACKUP_DIR="${ENGINE_BACKUP:-${PROD}.prev}"
SERVICE=${ENGINE_SERVICE:-image-studio-lobechat-next}
PORT=${ENGINE_PORT:-3403}

MODE=${1:-}
STAGE_TARGET=${2:-}

command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$PATH"

check_live_health() {
    local attempt code="" health=""
    for attempt in $(seq 1 15); do
        code=$(curl -sS -o /dev/null -w "%{http_code}" -H "Host: arckep.ru" "http://127.0.0.1:$PORT/chat/" 2>/dev/null || true)
        health=$(curl -sS -H "Host: arckep.ru" "http://127.0.0.1:$PORT/chat/api/v1/health/" 2>/dev/null || true)
        if [[ ("$code" == "200" || "$code" == "302") && "$health" == *'"status":"ok"'* ]]; then
            echo "[engine] health OK (attempt $attempt): /chat/ HTTP $code, health=$health"
            return 0
        fi
        sleep 2
    done
    echo "ERROR: engine health failed after restart (/chat/ HTTP ${code:-none}, health=${health:-none})" >&2
    tail -n 40 "/var/log/$SERVICE.log" >&2 || true
    return 1
}

if [[ "$MODE" == "--rollback" ]]; then
    if [[ ! -d "$BACKUP_DIR" || ! -f "$BACKUP_DIR/server.js" ]]; then
        echo "ERROR: backup slot $BACKUP_DIR is missing or incomplete — cannot rollback." >&2
        exit 1
    fi
    if [[ -f "$PROD/.env" ]]; then
        cp -pf "$PROD/.env" "$BACKUP_DIR/.env"
        cmp -s "$PROD/.env" "$BACKUP_DIR/.env"
    fi
    ROLLBACK_SAVE="${PROD}.rolled-back.$(date +%s)"
    echo "[engine] rolling back $PROD <- $BACKUP_DIR (saving current failed/active slot to $ROLLBACK_SAVE)"
    mv "$PROD" "$ROLLBACK_SAVE"
    mv "$BACKUP_DIR" "$PROD"
    systemctl restart "$SERVICE"
    check_live_health
    echo "[engine] ROLLBACK OK: restored $PROD (commit $(cat "$PROD/.deployed-commit" 2>/dev/null || echo unknown))"
    exit 0
fi

cd "$SRC"

if [[ "$MODE" != "--stage-only" && -n "$(git status --porcelain)" ]]; then
    echo "ERROR: uncommitted changes in $SRC — commit first (deploy is diff-driven)." >&2
    git status --porcelain | head >&2
    exit 1
fi

HEAD_COMMIT=$(git rev-parse HEAD)
STATE_COMMIT="$PROD/.deployed-commit"
STATE_LOCK_HASH="$PROD/.deployed-lockhash"

LOCK_HASH=$(cat pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc packages/*/package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
if [[ "$MODE" == "--install" || ( "$MODE" != "--stage-only" && ( ! -f "$STATE_LOCK_HASH" || "$(cat "$STATE_LOCK_HASH")" != "$LOCK_HASH" ) ) ]]; then
    echo "[engine] pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
else
    echo "[engine] pnpm install skipped (lockfile/manifests unchanged or stage-only)"
fi

if [[ ! -d public/_spa ]]; then
    echo "[engine] public/_spa отсутствует — беру готовые артефакты из /opt/lobechat-src/public/_spa (интерфейс не собираем)"
    rsync -a /opt/lobechat-src/public/_spa/ public/_spa/
fi

SPA_TEMPLATES="src/app/spa/[variants]/[[...path]]/spaHtmlTemplates.ts"
if [[ ! -f "$SPA_TEMPLATES" ]]; then
    for candidate in \
        "/var/tmp/wt/lobechat-engine/$SPA_TEMPLATES" \
        "/opt/lobechat-src/$SPA_TEMPLATES"; do
        if [[ -f "$candidate" ]]; then
            echo "[engine] $SPA_TEMPLATES отсутствует — беру готовый шаблон из $candidate"
            cp -a "$candidate" "$SPA_TEMPLATES"
            break
        fi
    done
fi

if [[ "${ENGINE_SKIP_BUILD:-0}" != "1" ]]; then
    echo "[engine] standalone next build (NEXT_BUILD_STANDALONE=1, SPA never rebuilt here)"
    rm -rf "$SRC/.next/standalone"
    if [[ -f "$SRC/.env" ]]; then
        NEXT_BUILD_STANDALONE=1 bun run build:next
    else
        NEXT_BUILD_STANDALONE=1 \
            APP_URL="${APP_URL:-https://arckep.ru/chat}" \
            DATABASE_DRIVER="${DATABASE_DRIVER:-node}" \
            DATABASE_URL="${DATABASE_URL:-postgres://postgres:password@127.0.0.1:5432/postgres}" \
            KEY_VAULTS_SECRET="${KEY_VAULTS_SECRET:-build-placeholder-key-vaults-secret-32c}" \
            AUTH_SECRET="${AUTH_SECRET:-build-placeholder-better-auth-secret-32c}" \
            bun run build:next
    fi
fi

STANDALONE_ROOT="$SRC/.next/standalone"
if [[ -f "$STANDALONE_ROOT/server.js" ]]; then
    STANDALONE_APP="$STANDALONE_ROOT"
elif [[ -f "$STANDALONE_ROOT/${SRC#/}/server.js" ]]; then
    STANDALONE_APP="$STANDALONE_ROOT/${SRC#/}"
else
    echo "ERROR: standalone server.js not found under $STANDALONE_ROOT" >&2
    exit 1
fi

if [[ ! -f "$SRC/.next/BUILD_ID" ]]; then
    echo "ERROR: $SRC/.next/BUILD_ID missing after build" >&2
    exit 1
fi

if [[ "$MODE" == "--stage-only" ]]; then
    STAGE_DIR="${STAGE_TARGET:-/var/tmp/lc-engine-stage-check}"
    rm -rf "$STAGE_DIR"
else
    STAGE_DIR="$(dirname "$PROD")/.$(basename "$PROD").stage.$$"
    rm -rf "$STAGE_DIR"
fi

cleanup_stage() {
    if [[ "$MODE" != "--stage-only" && -d "${STAGE_DIR:-}" ]]; then
        rm -rf "$STAGE_DIR"
    fi
}
trap cleanup_stage EXIT

mkdir -p "$STAGE_DIR"

echo "[engine] assembling standalone runtime in $STAGE_DIR"
if [[ "$STANDALONE_ROOT" != "$STANDALONE_APP" && -d "$STANDALONE_ROOT/node_modules" ]]; then
    mkdir -p "$STAGE_DIR/node_modules"
    rsync -a "$STANDALONE_ROOT/node_modules/" "$STAGE_DIR/node_modules/"
fi
rsync -a "$STANDALONE_APP/" "$STAGE_DIR/"
rm -f "$STAGE_DIR"/.env "$STAGE_DIR"/.env.*
mkdir -p "$STAGE_DIR/.next/static"
rsync -a --delete "$SRC/.next/static/" "$STAGE_DIR/.next/static/"

if [[ -d "$PROD/public" ]]; then
    mkdir -p "$STAGE_DIR/public"
    rsync -a "$PROD/public/" "$STAGE_DIR/public/"
elif [[ -d "$SRC/public" ]]; then
    mkdir -p "$STAGE_DIR/public"
    rsync -a "$SRC/public/" "$STAGE_DIR/public/"
fi

# Guarantee native Linux bindings (sharp + @img/* + @napi-rs/canvas*) exist in standalone node_modules
mkdir -p "$STAGE_DIR/node_modules/.pnpm"
shopt -s nullglob
for pkg_dir in \
    "$SRC"/node_modules/.pnpm/sharp* \
    "$SRC"/node_modules/.pnpm/@img+* \
    "$SRC"/node_modules/.pnpm/@napi-rs+canvas* \
    "$SRC"/node_modules/.pnpm/detect-libc* \
    "$SRC"/node_modules/.pnpm/semver*; do
    base_name=$(basename "$pkg_dir")
    if [[ ! -e "$STAGE_DIR/node_modules/.pnpm/$base_name" ]]; then
        cp -a "$pkg_dir" "$STAGE_DIR/node_modules/.pnpm/$base_name"
    fi
done
for top_entry in sharp @img @napi-rs; do
    if [[ -e "$SRC/node_modules/$top_entry" && ! -e "$STAGE_DIR/node_modules/$top_entry" ]]; then
        cp -a "$SRC/node_modules/$top_entry" "$STAGE_DIR/node_modules/$top_entry"
    fi
done
shopt -u nullglob

# Pre-flight verification BEFORE touching live $PROD
if [[ ! -f "$STAGE_DIR/server.js" || ! -f "$STAGE_DIR/.next/BUILD_ID" ]]; then
    echo "ERROR: staged slot is missing server.js or .next/BUILD_ID" >&2
    exit 1
fi
if ! cmp -s "$SRC/.next/BUILD_ID" "$STAGE_DIR/.next/BUILD_ID"; then
    echo "ERROR: BUILD_ID mismatch between $SRC/.next/BUILD_ID and $STAGE_DIR/.next/BUILD_ID" >&2
    exit 1
fi

EXPECTED_NEXT_VER=$(node -p "require('$SRC/node_modules/next/package.json').version")
STAGED_NEXT_VER=$(node -p "require('$STAGE_DIR/node_modules/next/package.json').version")
if [[ "$EXPECTED_NEXT_VER" != "$STAGED_NEXT_VER" ]]; then
    echo "ERROR: staged next version ($STAGED_NEXT_VER) != source next version ($EXPECTED_NEXT_VER)" >&2
    exit 1
fi

# Ensure no symlinks point outside $STAGE_DIR (systemd PrivateTmp=true / ProtectHome=true)
# and prune unused pnpm virtual-store hoist links left by Next output tracing
python3 - "$STAGE_DIR" <<'PY'
import os, sys

root = os.path.realpath(sys.argv[1])
pnpm_hoist = os.path.join(root, "node_modules", ".pnpm", "node_modules") + os.sep
bad = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in dirnames + filenames:
        full = os.path.join(dirpath, name)
        if os.path.islink(full):
            raw = os.readlink(full)
            # Compute lexical target without following final missing leaf across outside boundaries
            joined = os.path.normpath(os.path.join(dirpath, raw)) if not os.path.isabs(raw) else os.path.normpath(raw)
            target = os.path.realpath(full)
            if not (joined == root or joined.startswith(root + os.sep)) or not (target == root or target.startswith(root + os.sep)):
                bad.append((full, raw, target))
            elif not os.path.exists(target):
                if full.startswith(pnpm_hoist):
                    os.unlink(full)
                else:
                    bad.append((full, raw, target))
if bad:
    for full, raw, target in bad[:20]:
        print(f"ERROR: broken/external symlink in stage: {full} -> {raw} (resolved: {target})", file=sys.stderr)
    sys.exit(1)
PY

(
    cd "$STAGE_DIR"
    node -e "
      const nextVer = require('./node_modules/next/package.json').version;
      require('sharp');
      require('@napi-rs/canvas');
      console.log('[engine] pre-flight OK: next@' + nextVer + ', sharp=ok, @napi-rs/canvas=ok');
    "
)

if [[ "$MODE" == "--stage-only" ]]; then
    echo "[engine] stage-only complete at $STAGE_DIR (live $PROD untouched)"
    exit 0
fi

if [[ ! -f "$PROD/.env" ]]; then
    echo "ERROR: $PROD/.env is missing — refusing to swap production slot!" >&2
    exit 1
fi

echo "$HEAD_COMMIT" > "$STAGE_DIR/.deployed-commit"
echo "$LOCK_HASH" > "$STAGE_DIR/.deployed-lockhash"

if id lobechat >/dev/null 2>&1; then
    chown -R lobechat:lobechat "$STAGE_DIR"
fi

# Preserve .env and .env.bak* with exact ownership/permissions (root:root 0600) AFTER chown
shopt -s nullglob
for env_file in "$PROD"/.env "$PROD"/.env.bak*; do
    cp -pf "$env_file" "$STAGE_DIR/$(basename "$env_file")"
done
shopt -u nullglob

if ! cmp -s "$PROD/.env" "$STAGE_DIR/.env"; then
    echo "ERROR: .env verification failed in $STAGE_DIR — aborting before swap!" >&2
    exit 1
fi

# Atomic slot swap on same filesystem with previous-slot backup ($BACKUP_DIR)
OLD_BACKUP="${BACKUP_DIR}.old.$$"
rm -rf "$OLD_BACKUP"
if [[ -e "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$OLD_BACKUP"
fi

mv "$PROD" "$BACKUP_DIR"
if ! mv "$STAGE_DIR" "$PROD"; then
    echo "ERROR: failed to move $STAGE_DIR -> $PROD, restoring $BACKUP_DIR" >&2
    mv "$BACKUP_DIR" "$PROD"
    [[ -e "$OLD_BACKUP" ]] && mv "$OLD_BACKUP" "$BACKUP_DIR"
    exit 1
fi
rm -rf "$OLD_BACKUP"

systemctl restart "$SERVICE"
if ! check_live_health; then
    echo "[engine] CRITICAL: health check failed — performing automatic atomic rollback from $BACKUP_DIR!" >&2
    FAILED_SLOT="${PROD}.failed.$$"
    mv "$PROD" "$FAILED_SLOT"
    mv "$BACKUP_DIR" "$PROD"
    systemctl restart "$SERVICE"
    check_live_health || true
    echo "ERROR: deploy rolled back to previous slot; inspect $FAILED_SLOT and /var/log/$SERVICE.log" >&2
    exit 1
fi

echo "[engine] OK: next@$STAGED_NEXT_VER, commit $HEAD_COMMIT deployed to $PROD (backup at $BACKUP_DIR)"
