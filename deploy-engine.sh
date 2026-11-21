#!/usr/bin/env bash
# Бесшовная Blue-Green выкладка движка чата (LobeChat без интерфейса) за постоянным HTTP/SSE-роутером :3403.
#
# Архитектура:
#   * 127.0.0.1:3403 — постоянный умный роутер image-studio-lobechat-router.service (/opt/lobechat-next-router/engine-router.mjs);
#   * слоты: blue (/opt/lobechat-next-blue, :3411) и green (/opt/lobechat-next-green, :3412) под image-studio-lobechat@{blue,green};
#   * /opt/lobechat-next — атомарный симлинк на активный слот (совместимость с nginx alias, .deployed-commit, env-check, auditd);
#   * /var/lib/lobechat-engine/state.json — состояние слотов + previousConfirmedSlot/Commit + сторож .switch-pending;
#   * старый слот уходит в drain (POST /arckep/engine-slot/drain): все идущие ответы, _chat_wait, боты, cron и задачи E2B
#     спокойно доходят до конца + сохраняется окно реплея 10 мин, после чего фоновый доводчик гасит старый слот.
#
# Usage:
#   bash deploy-engine.sh                  # бесшовная Blue-Green сборка и переключение слотов
#   bash deploy-engine.sh --install        # форсирует pnpm install --frozen-lockfile перед сборкой
#   bash deploy-engine.sh --init [--force] # однократный переход со старой image-studio-lobechat-next на blue + router
#   bash deploy-engine.sh --rollback       # мгновенный откат (< 2 с) на подтверждённый слот с undrain + drain текущего
#   bash deploy-engine.sh --status         # статус роутера :3403 и обоих слотов blue (3411) / green (3412)
#   bash deploy-engine.sh --stage-only [D] # собрать и проверить standalone-слот в каталоге D без касания прода
#   bash deploy-engine.sh --help | -h      # показать справку
set -euo pipefail

log()  { echo "[engine $(date '+%H:%M:%S')] $*"; }
warn() { echo "[engine $(date '+%H:%M:%S')] WARN: $*" >&2; }
err()  { echo "[engine $(date '+%H:%M:%S')] ERROR: $*" >&2; }

usage() {
    cat <<'EOF'
Usage:
  bash deploy-engine.sh                     # Бесшовная Blue-Green сборка и переключение слотов
  bash deploy-engine.sh --install           # Принудительный pnpm install --frozen-lockfile перед сборкой
  bash deploy-engine.sh --init [--force]    # Однократный переход со старой службы на blue + router
  bash deploy-engine.sh --rollback          # Мгновенный откат (< 2 с) на предыдущий подтверждённый слот
  bash deploy-engine.sh --status            # Статус роутера :3403 и слотов blue (3411) / green (3412)
  bash deploy-engine.sh --stage-only [DIR]  # Собрать и проверить standalone-слот в DIR без касания прода
  bash deploy-engine.sh --help | -h         # Показать эту справку
EOF
}

# =============================================================================
# STRICT ARGUMENT VALIDATION (fail-fast BEFORE any locks, installs, or builds)
# =============================================================================
MODE=""
INIT_FORCE=""
STAGE_OUT="/var/tmp/lc-engine-stage-check"

if [[ $# -eq 0 ]]; then
    MODE="deploy"
else
    case "$1" in
        --help|-h)
            if [[ $# -ne 1 ]]; then
                err "Лишние аргументы для '$1': ${*:2}"
                usage >&2
                exit 1
            fi
            usage
            exit 0
            ;;
        --install)
            if [[ $# -ne 1 ]]; then
                err "Лишние аргументы для '--install': ${*:2}"
                usage >&2
                exit 1
            fi
            MODE="--install"
            ;;
        --init)
            if [[ $# -eq 1 ]]; then
                MODE="--init"
            elif [[ $# -eq 2 && "$2" == "--force" ]]; then
                MODE="--init"
                INIT_FORCE="--force"
            else
                err "Недопустимые аргументы для '--init': ${*:2} (ожидалось пусто или --force)"
                usage >&2
                exit 1
            fi
            ;;
        --rollback)
            if [[ $# -ne 1 ]]; then
                err "Лишние аргументы для '--rollback': ${*:2}"
                usage >&2
                exit 1
            fi
            MODE="--rollback"
            ;;
        --status)
            if [[ $# -ne 1 ]]; then
                err "Лишние аргументы для '--status': ${*:2}"
                usage >&2
                exit 1
            fi
            MODE="--status"
            ;;
        --stage-only)
            if [[ $# -eq 1 ]]; then
                MODE="--stage-only"
            elif [[ $# -eq 2 && -n "$2" && "$2" != -* ]]; then
                MODE="--stage-only"
                STAGE_OUT="$2"
            else
                err "Недопустимые аргументы для '--stage-only': ${*:2} (ожидался максимум один путь каталога)"
                usage >&2
                exit 1
            fi
            ;;
        *)
            err "Неизвестный аргумент или режим: $*"
            usage >&2
            exit 1
            ;;
    esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${ENGINE_SRC:-$SCRIPT_DIR}"
PROD="${ENGINE_PROD:-/opt/lobechat-next}"
SLOT_BLUE_DIR="${ENGINE_SLOT_BLUE_DIR:-/opt/lobechat-next-blue}"
SLOT_GREEN_DIR="${ENGINE_SLOT_GREEN_DIR:-/opt/lobechat-next-green}"
BLUE_PORT="${ENGINE_BLUE_PORT:-3411}"
GREEN_PORT="${ENGINE_GREEN_PORT:-3412}"
ROUTER_DIR="${ENGINE_ROUTER_DIR:-/opt/lobechat-next-router}"
PORT="${ENGINE_PORT:-${LOBECHAT_PORT:-3403}}"

STATE_FILE="${ENGINE_STATE_FILE:-${LOBECHAT_STATE_FILE:-${ENGINE_STATE_DIR:-/var/lib/lobechat-engine}/state.json}}"
STATE_DIR="${ENGINE_STATE_DIR:-$(dirname "$STATE_FILE")}"
SWITCH_GUARD="$STATE_DIR/.switch-pending"

LEGACY_SERVICE="${ENGINE_SERVICE:-${LOBECHAT_SERVICE:-image-studio-lobechat-next}}"
ROUTER_SERVICE="${ENGINE_ROUTER_SERVICE:-image-studio-lobechat-router}"
SLOT_UNIT_PREFIX="${ENGINE_SLOT_UNIT_PREFIX:-image-studio-lobechat@}"
SYSTEMD_DIR="${ENGINE_SYSTEMD_DIR:-/etc/systemd/system}"
LOG_FILE="${ENGINE_LOG_FILE:-/var/log/image-studio-lobechat-next.log}"

DEPLOY_LOCK_FILE="${ENGINE_DEPLOY_LOCK:-/run/lock/lobechat-engine-deploy.lock}"
STATE_LOCK_FILE="${ENGINE_STATE_LOCK:-/run/lock/lobechat-engine-state.lock}"
BUILD_LOCK_FILE="${ENGINE_BUILD_LOCK:-/var/tmp/wt/.lobechat-build.lock}"
DRAIN_GRACE_SEC="${ENGINE_DRAIN_GRACE_SEC:-15}"
REPLAY_GRACE_SEC="${ENGINE_REPLAY_GRACE_SEC:-605}"
DRAIN_MAX_WAIT_SEC="${ENGINE_DRAIN_MAX_WAIT_SEC:-2100}"

HEAD_COMMIT=""
LOCK_HASH=""
STAGED_NEXT_VER=""

command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$PATH"

slot_port() {
    [[ "$1" == "blue" ]] && echo "$BLUE_PORT" || echo "$GREEN_PORT"
}

slot_dir() {
    [[ "$1" == "blue" ]] && echo "$SLOT_BLUE_DIR" || echo "$SLOT_GREEN_DIR"
}

slot_service() {
    echo "${SLOT_UNIT_PREFIX}${1}"
}

other_slot() {
    [[ "$1" == "blue" ]] && echo "green" || echo "blue"
}

# =============================================================================
# STAGE-ONLY PATH VALIDATION (P2 #18: prevent wiping arbitrary directories)
# =============================================================================
validate_stage_only_dir() {
    local target="$1"
    if [[ -z "$target" ]]; then
        err "Пустой путь для --stage-only."
        exit 1
    fi
    if [[ -L "$target" ]]; then
        err "Путь --stage-only '$target' является симлинком — отказ!"
        exit 1
    fi
    if [[ -e "$target" && ! -d "$target" ]]; then
        err "Путь --stage-only '$target' существует и не является каталогом — отказ!"
        exit 1
    fi

    python3 - "$target" "$SRC" "$PROD" "$SLOT_BLUE_DIR" "$SLOT_GREEN_DIR" "$ROUTER_DIR" "$STATE_DIR" <<'PY'
import os, sys

raw_target, src, prod, blue, green, router, state_dir = sys.argv[1:8]
if not os.path.isabs(raw_target):
    raw_target = os.path.abspath(raw_target)

parent = os.path.dirname(raw_target.rstrip("/")) or "/"
base = os.path.basename(raw_target.rstrip("/"))
if not base or base in (".", ".."):
    print(f"ERROR: недопустимый путь --stage-only: {raw_target}", file=sys.stderr)
    sys.exit(1)

real_parent = os.path.realpath(parent) if os.path.exists(parent) else os.path.normpath(parent)
resolved = os.path.normpath(os.path.join(real_parent, base))

parts = [p for p in resolved.split("/") if p]
if len(parts) < 2:
    print(f"ERROR: путь --stage-only слишком близко к корню: {resolved}", file=sys.stderr)
    sys.exit(1)

forbidden_exact = {
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64",
    "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/tmp",
    "/usr", "/var", "/var/tmp", "/var/lib", "/var/log", "/var/run",
}
if resolved in forbidden_exact:
    print(f"ERROR: системный каталог запрещён для --stage-only: {resolved}", file=sys.stderr)
    sys.exit(1)

forbidden_prefixes = [
    "/bin/", "/boot/", "/dev/", "/etc/", "/lib/", "/lib64/",
    "/opt/", "/proc/", "/root/", "/sbin/", "/sys/", "/usr/",
    "/var/lib/", "/var/log/",
]
for pref in forbidden_prefixes:
    if resolved.startswith(pref):
        print(f"ERROR: каталог внутри защищённого дерева '{pref}' запрещён для --stage-only: {resolved}", file=sys.stderr)
        sys.exit(1)

protected_trees = [
    os.path.realpath(p) if os.path.exists(p) else os.path.abspath(p)
    for p in (src, prod, blue, green, router, state_dir)
    if p
]
for tree in protected_trees:
    if resolved == tree or resolved.startswith(tree + "/") or tree.startswith(resolved + "/"):
        print(f"ERROR: путь --stage-only '{resolved}' пересекается с рабочим каталогом '{tree}'!", file=sys.stderr)
        sys.exit(1)

if os.path.isdir(resolved):
    entries = os.listdir(resolved)
    if entries and ".stage-only-marker" not in entries:
        print(
            f"ERROR: каталог '{resolved}' уже существует, не пуст и не содержит .stage-only-marker — отказ удалять чужие данные!",
            file=sys.stderr,
        )
        sys.exit(1)
PY
}

# =============================================================================
# LOCKING HELPERS (FD 7 deploy, FD 6 short state transition, FD 8 build+stage)
# =============================================================================
# Uses FD 7 so inherited FD 9 (/run/lock/image-studio-deploy.lock from Studio deploy.sh) stays intact
acquire_deploy_lock() {
    local label="${1:-deploy}"
    mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")" 2>/dev/null || DEPLOY_LOCK_FILE="/tmp/lobechat-engine-deploy.lock"
    exec 7>>"$DEPLOY_LOCK_FILE"
    if ! flock -n 7; then
        local holder
        holder=$(cat "$DEPLOY_LOCK_FILE" 2>/dev/null || echo "unknown process")
        err "Другой deploy-engine.sh уже выполняется ($holder)."
        exit 1
    fi
    printf 'pid=%s started=%s mode=%s\n' "$$" "$(date -Iseconds)" "$label" > "$DEPLOY_LOCK_FILE"
}

with_state_lock() {
    mkdir -p "$(dirname "$STATE_LOCK_FILE")" 2>/dev/null || STATE_LOCK_FILE="/tmp/lobechat-engine-state.lock"
    exec 6>>"$STATE_LOCK_FILE"
    flock -w 15 6
    local rc=0
    "$@" || rc=$?
    flock -u 6 || true
    exec 6>&-
    return $rc
}

already_holds_build_lock() {
    [[ -e "$BUILD_LOCK_FILE" && -d "/proc/$BASHPID/fd" ]] || return 1
    python3 - "$BASHPID" "$BUILD_LOCK_FILE" <<'PY'
import os, sys

pid, lock_path = sys.argv[1], sys.argv[2]
try:
    target = os.stat(lock_path)
except OSError:
    sys.exit(1)

fd_dir = f"/proc/{pid}/fd"
for fd in os.listdir(fd_dir):
    try:
        st = os.stat(f"{fd_dir}/{fd}")
    except OSError:
        continue
    if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
        try:
            with open(f"/proc/{pid}/fdinfo/{fd}", "r", encoding="utf-8", errors="replace") as fh:
                info = fh.read()
        except OSError:
            info = ""
        if "lock:" in info and "FLOCK" in info:
            sys.exit(0)
sys.exit(1)
PY
}

run_with_build_lock() {
    mkdir -p "$(dirname "$BUILD_LOCK_FILE")"
    if already_holds_build_lock; then
        log "Замок сборки $BUILD_LOCK_FILE уже удерживается внешним flock — продолжаю без повторного захвата."
        "$@"
        return $?
    fi
    exec 8>>"$BUILD_LOCK_FILE"
    if ! flock -n 8; then
        log "Ожидание замка сборки $BUILD_LOCK_FILE..."
        flock 8
    fi
    local rc=0
    "$@" || rc=$?
    flock -u 8 || true
    exec 8>&-
    return $rc
}

reload_auditd_watches() {
    if command -v augenrules >/dev/null 2>&1; then
        if augenrules --load >/dev/null 2>&1; then
            log "auditd rules reloaded (augenrules --load)"
        else
            warn "augenrules --load failed — auditd inode watch for $PROD/.env may need manual reload"
        fi
    fi
}

atomic_symlink() {
    local target_path="$1" link_path="$2"
    local tmp_link="${link_path}.symlink.$$"
    rm -f "$tmp_link"
    ln -sfn "$target_path" "$tmp_link"
    mv -Tf "$tmp_link" "$link_path"
}

check_switch_allowed() {
    if [[ -e "$SWITCH_GUARD" || -L "$SWITCH_GUARD" ]]; then
        err "Обнаружено незавершённое переключение ($SWITCH_GUARD): $(cat "$SWITCH_GUARD" 2>/dev/null || true)"
        err "Проверь 'deploy-engine.sh --status', $STATE_FILE и симлинк $PROD перед продолжением."
        exit 1
    fi
}

begin_switch() {
    local prev_slot="$1" next_slot="$2"
    mkdir -p "$STATE_DIR"
    if ! (set -C; printf 'previous=%s target=%s ts=%s\n' "$prev_slot" "$next_slot" "$(date -Iseconds)" > "$SWITCH_GUARD"); then
        err "Не удалось создать сторож переключения $SWITCH_GUARD"
        return 1
    fi
    sync -f "$SWITCH_GUARD" || true
}

clear_switch_guard() {
    rm -f -- "$SWITCH_GUARD"
}

write_state_json_unlocked() {
    local active_slot="$1" active_port="$2" draining_slot="${3:-}" draining_port="${4:-}" epoch="$5"
    local active_commit="${6:-__KEEP__}" prev_confirmed_slot="${7:-__KEEP__}" prev_confirmed_commit="${8:-__KEEP__}"
    mkdir -p "$STATE_DIR"
    chmod 0755 "$STATE_DIR"
    local tmp_file="${STATE_FILE}.tmp.$$"
    python3 - "$STATE_FILE" "$tmp_file" "$active_slot" "$active_port" "$draining_slot" "$draining_port" "$epoch" \
        "$active_commit" "$prev_confirmed_slot" "$prev_confirmed_commit" <<'PY'
import json, os, sys

(
    src_path,
    dst_path,
    a_slot,
    a_port,
    d_slot,
    d_port,
    epoch,
    a_commit,
    prev_slot,
    prev_commit,
) = sys.argv[1:11]

existing = {}
if os.path.isfile(src_path):
    try:
        with open(src_path, "r", encoding="utf-8") as fh:
            existing = json.load(fh)
    except Exception:
        existing = {}

def resolve_opt(val, key):
    if val == "__KEEP__":
        return existing.get(key)
    if val == "" or val == "null":
        return None
    return val

payload = {
    "activeSlot": a_slot,
    "activePort": int(a_port),
    "drainingSlot": d_slot if d_slot else None,
    "drainingPort": int(d_port) if d_port else None,
    "switchEpoch": int(epoch),
    "activeCommit": resolve_opt(a_commit, "activeCommit"),
    "previousConfirmedSlot": resolve_opt(prev_slot, "previousConfirmedSlot"),
    "previousConfirmedCommit": resolve_opt(prev_commit, "previousConfirmedCommit"),
}

with open(dst_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
    fh.flush()
    os.fsync(fh.fileno())
os.chmod(dst_path, 0o644)
PY
    mv -Tf "$tmp_file" "$STATE_FILE"
}

write_state_json() {
    with_state_lock write_state_json_unlocked "$@"
}

read_state_field() {
    local field="$1"
    [[ -f "$STATE_FILE" ]] || return 1
    python3 - "$STATE_FILE" "$field" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    data = json.load(fh)
val = data.get(sys.argv[2])
print("" if val is None else val)
PY
}

read_slot_commit() {
    local dir="$1"
    if [[ -f "$dir/.deployed-commit" ]]; then
        tr -d '[:space:]' < "$dir/.deployed-commit"
    fi
}

notify_router_reload() {
    if systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        systemctl reload "$ROUTER_SERVICE" 2>/dev/null || systemctl kill -s HUP "$ROUTER_SERVICE" 2>/dev/null || true
    fi
}

# Read ARCKEP_ENGINE_SERVICE_KEY from an .env file without echoing it anywhere
read_service_key_from_env() {
    local env_path="$1"
    [[ -f "$env_path" ]] || return 1
    python3 - "$env_path" <<'PY'
import sys
path = sys.argv[1]
key = ""
with open(path, "r", encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if line.startswith("ARCKEP_ENGINE_SERVICE_KEY="):
            val = line.split("=", 1)[1].strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            key = val.strip()
if key:
    sys.stdout.write(key)
PY
}

resolve_live_env_file() {
    if [[ -f "$PROD/.env" ]]; then
        echo "$PROD/.env"
    elif [[ -f "$SLOT_BLUE_DIR/.env" ]]; then
        echo "$SLOT_BLUE_DIR/.env"
    elif [[ -f "$SLOT_GREEN_DIR/.env" ]]; then
        echo "$SLOT_GREEN_DIR/.env"
    else
        return 1
    fi
}

# Write minimal router service-key file ($ROUTER_DIR/.service-key.env, root:lobechat 0640)
# so router SIGHUP reloads rotated ARCKEP_ENGINE_SERVICE_KEY without needing access to 0600 .env
sync_router_service_key_file() {
    local env_path="$1"
    [[ -f "$env_path" ]] || return 1
    local svc_key
    svc_key=$(read_service_key_from_env "$env_path" || true)
    if [[ -z "$svc_key" || "${#svc_key}" -lt 32 ]]; then
        err "ARCKEP_ENGINE_SERVICE_KEY в $env_path отсутствует или короче 32 символов!"
        return 1
    fi
    mkdir -p "$ROUTER_DIR"
    chmod 0755 "$ROUTER_DIR"
    local dst_key_file="$ROUTER_DIR/.service-key.env"
    local tmp_key_file="${dst_key_file}.tmp.$$"
    install -m 0600 /dev/null "$tmp_key_file"
    printf 'ARCKEP_ENGINE_SERVICE_KEY=%s\n' "$svc_key" > "$tmp_key_file"
    if [[ "$(id -u)" -eq 0 ]]; then
        if getent group lobechat >/dev/null 2>&1; then
            chown root:lobechat "$tmp_key_file"
            chmod 0640 "$tmp_key_file"
        else
            chown root:root "$tmp_key_file"
            chmod 0600 "$tmp_key_file"
        fi
    fi
    mv -Tf "$tmp_key_file" "$dst_key_file"
}

# Call engine-slot endpoint via stdin curl config so the service key never appears in argv/ps
slot_api_call() {
    local method="$1" port="$2" endpoint="$3" env_path="${4:-}"
    if [[ -z "$env_path" ]]; then
        env_path=$(resolve_live_env_file 2>/dev/null || true)
    fi
    [[ -n "$env_path" && -f "$env_path" ]] || return 1
    local svc_key
    svc_key=$(read_service_key_from_env "$env_path" || true)
    [[ -n "$svc_key" && "${#svc_key}" -ge 32 ]] || return 1
    printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$svc_key" | \
        curl -sS --fail --max-time 3 -X "$method" -K - \
        "http://127.0.0.1:${port}/chat/api/v1/arckep/engine-slot/${endpoint}/" 2>/dev/null
}

# P1 #1: Strict tri-state slot status query (`stopped` | `idle` | `busy` | `unknown`).
# Outputs: `<state> <activeTotal> <retainedCount> <drainingBool> <sandboxWorkerRunningBool>`
# NEVER treats HTTP errors, timeouts, missing keys, or malformed JSON as `activeTotal=0`!
query_slot_drain_state() {
    local slot="$1" port="$2" env_path="${3:-}"
    local svc
    svc=$(slot_service "$slot")
    if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo "stopped 0 0 false false"
        return 0
    fi

    if [[ -z "$env_path" ]]; then
        env_path=$(resolve_live_env_file 2>/dev/null || true)
    fi
    if [[ -z "$env_path" || ! -f "$env_path" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    local svc_key
    svc_key=$(read_service_key_from_env "$env_path" || true)
    if [[ -z "$svc_key" || "${#svc_key}" -lt 32 ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    local raw_resp curl_rc=0
    raw_resp=$(
        printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$svc_key" | \
            curl -sS -w $'\n%{http_code}' --max-time 3 -K - \
            "http://127.0.0.1:${port}/chat/api/v1/arckep/engine-slot/status/" 2>/dev/null
    ) || curl_rc=$?

    if [[ $curl_rc -ne 0 || -z "$raw_resp" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    python3 - "$raw_resp" <<'PY'
import json, sys

raw = sys.argv[1]
lines = raw.rsplit("\n", 1)
if len(lines) != 2:
    print("unknown -1 -1 false false")
    sys.exit(0)

body, http_code = lines[0], lines[1].strip()
if http_code != "200":
    print("unknown -1 -1 false false")
    sys.exit(0)

try:
    d = json.loads(body)
except Exception:
    print("unknown -1 -1 false false")
    sys.exit(0)

if not isinstance(d, dict):
    print("unknown -1 -1 false false")
    sys.exit(0)

active_total = d.get("activeTotal")
retained = d.get("retainedTopicIds")
draining = d.get("draining")
sbx_running = d.get("sandboxWorkerRunning", True)

if (
    type(active_total) is not int
    or active_total < 0
    or not isinstance(retained, list)
    or not isinstance(draining, bool)
):
    print("unknown -1 -1 false false")
    sys.exit(0)

state = "idle" if active_total == 0 else "busy"
print(
    f"{state} {active_total} {len(retained)} "
    f"{'true' if draining else 'false'} {'true' if sbx_running else 'false'}"
)
PY
}

check_port_health() {
    local check_port="$1" expected_slot="${2:-}" max_attempts="${3:-20}"
    local attempt code="" health="" headers="" actual_slot=""
    for attempt in $(seq 1 "$max_attempts"); do
        headers=$(curl -sS -D - -o /dev/null --max-time 3 -H "Host: arckep.ru" "http://127.0.0.1:${check_port}/chat/api/v1/health/" 2>/dev/null || true)
        code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 -H "Host: arckep.ru" "http://127.0.0.1:${check_port}/chat/" 2>/dev/null || true)
        health=$(curl -sS --max-time 3 -H "Host: arckep.ru" "http://127.0.0.1:${check_port}/chat/api/v1/health/" 2>/dev/null || true)
        actual_slot=$(printf '%s\n' "$headers" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lobechat-slot"{print $2; exit}')

        if [[ ("$code" == "200" || "$code" == "302" || "$code" == "307" || "$code" == "308") && "$health" == *'"status":"ok"'* ]]; then
            if [[ -z "$expected_slot" || "$actual_slot" == "$expected_slot" ]]; then
                log "health OK on :${check_port} (attempt ${attempt}): /chat/ HTTP ${code}, slot=${actual_slot:-direct}"
                return 0
            fi
        fi
        sleep 1
    done
    err "health check failed on :${check_port} (/chat/ HTTP ${code:-none}, expected_slot=${expected_slot:-any}, actual_slot=${actual_slot:-none}, health=${health:-none})"
    tail -n 40 "$LOG_FILE" >&2 2>/dev/null || true
    return 1
}

# P2 #13: Synchronous drainer cancellation with /proc/$pid/cmdline token verification
stop_background_drainer() {
    local slot="$1"
    local unit="lobechat-drain-${slot}.service"
    systemctl stop "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true

    local pid_file="$STATE_DIR/drain-${slot}.pid"
    if [[ -f "$pid_file" ]]; then
        local raw_entry old_pid old_token
        raw_entry=$(cat "$pid_file" 2>/dev/null || true)
        old_pid="${raw_entry%%:*}"
        old_token="${raw_entry#*:}"
        if [[ "$old_token" == "$raw_entry" ]]; then
            old_token=""
        fi

        if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
            local matches=0
            if [[ -r "/proc/$old_pid/cmdline" ]]; then
                if python3 - "$old_pid" "$old_token" <<'PY'
import sys
pid, token = sys.argv[1], sys.argv[2]
try:
    with open(f"/proc/{pid}/cmdline", "rb") as fh:
        cmd = fh.read().decode("utf-8", errors="replace").replace("\x00", " ")
except OSError:
    sys.exit(1)
if "slot-drainer.sh" in cmd and (not token or token in cmd):
    sys.exit(0)
sys.exit(1)
PY
                then
                    matches=1
                fi
            fi

            if [[ "$matches" == "1" ]]; then
                kill -TERM "$old_pid" 2>/dev/null || true
                local i
                for i in $(seq 1 50); do
                    if ! kill -0 "$old_pid" 2>/dev/null; then
                        break
                    fi
                    sleep 0.1
                done
                if kill -0 "$old_pid" 2>/dev/null; then
                    kill -KILL "$old_pid" 2>/dev/null || true
                    for i in $(seq 1 20); do
                        if ! kill -0 "$old_pid" 2>/dev/null; then
                            break
                        fi
                        sleep 0.05
                    done
                fi
            fi
        fi
        rm -f "$pid_file"
    fi
}

# P1 #1: Wait until target slot is confirmed stopped or idle (activeTotal===0).
# If status is `busy` or `unknown`, NEVER stop the slot; abort deploy if DRAIN_MAX_WAIT_SEC expires!
wait_slot_idle_before_overwrite() {
    local slot="$1" port="$2" env_path="$3"
    local waited=0 st="" active_total=0 retained_cnt=0 draining_flag="" sbx_flag=""
    while (( waited < DRAIN_MAX_WAIT_SEC )); do
        read -r st active_total retained_cnt draining_flag sbx_flag < <(query_slot_drain_state "$slot" "$port" "$env_path")
        case "$st" in
            stopped|idle)
                return 0
                ;;
            busy)
                log "Целевой слот $slot (:$port) ещё дорабатывает прошлую выкладку (activeTotal=$active_total, ждём ${waited}s)..."
                ;;
            *)
                warn "Статус целевого слота $slot (:$port) неизвестен (state=$st) — останавливать живой слот нельзя, повтор через 5s (${waited}s)..."
                ;;
        esac
        sleep 5
        waited=$((waited + 5))
    done

    read -r st active_total retained_cnt draining_flag sbx_flag < <(query_slot_drain_state "$slot" "$port" "$env_path")
    if [[ "$st" == "stopped" || "$st" == "idle" ]]; then
        return 0
    fi
    err "CRITICAL: целевой слот $slot (:$port) не подтвердил освобождение за ${DRAIN_MAX_WAIT_SEC}s (state=$st, activeTotal=$active_total) — остановка запрещена!"
    exit 1
}

write_slot_drainer_helper() {
    mkdir -p "$ROUTER_DIR"
    chmod 0755 "$ROUTER_DIR"
    local helper="$ROUTER_DIR/slot-drainer.sh"
    cat > "${helper}.tmp.$$" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# Never inherit flock / deploy lock file descriptors from parent deploy-engine.sh or deploy.sh
if [[ -d "/proc/$$/fd" ]]; then
    for _fd_entry in "/proc/$$/fd/"*; do
        _fd_num="${_fd_entry##*/}"
        if [[ "$_fd_num" =~ ^[0-9]+$ ]] && (( _fd_num > 2 )); then
            eval "exec ${_fd_num}>&-" 2>/dev/null || true
        fi
    done
fi

SLOT="$1"
PORT="$2"
EXPECTED_EPOCH="$3"
STATE_FILE="$4"
ROUTER_SERVICE="$5"
SLOT_SERVICE="$6"
ENV_FILE="$7"
GRACE_SEC="${8:-15}"
MAX_WAIT_SEC="${9:-2100}"
REPLAY_GRACE_SEC="${10:-605}"
STATE_LOCK_FILE="${11:-/run/lock/lobechat-engine-state.lock}"
DRAIN_TOKEN="${12:-}"

PID_FILE="$(dirname "$STATE_FILE")/drain-${SLOT}.pid"

cleanup_pid_file() {
    if [[ -n "$DRAIN_TOKEN" && -f "$PID_FILE" ]]; then
        local cur
        cur=$(cat "$PID_FILE" 2>/dev/null || true)
        if [[ "$cur" == "$$:${DRAIN_TOKEN}" ]]; then
            rm -f "$PID_FILE"
        fi
    fi
}
trap cleanup_pid_file EXIT

log()  { echo "[engine-drain:${SLOT} $(date '+%H:%M:%S')] $*"; }
crit() { echo "[engine-drain:${SLOT} $(date '+%H:%M:%S')] CRITICAL: $*" >&2; }

state_matches() {
    [[ -f "$STATE_FILE" ]] || return 1
    python3 - "$STATE_FILE" "$SLOT" "$EXPECTED_EPOCH" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    d = json.load(fh)
ok = (
    d.get("activeSlot") != sys.argv[2]
    and d.get("drainingSlot") == sys.argv[2]
    and int(d.get("switchEpoch", -1)) == int(sys.argv[3])
)
sys.exit(0 if ok else 1)
PY
}

# P1 #1: Tri-state check (`stopped` | `idle` | `busy` | `unknown`) + retainedTopicIds count.
query_drain_status() {
    if ! systemctl is-active --quiet "$SLOT_SERVICE" 2>/dev/null; then
        echo "stopped 0 0"
        return 0
    fi

    [[ -f "$ENV_FILE" ]] || { echo "unknown -1 -1"; return 0; }
    local key
    key=$(python3 - "$ENV_FILE" <<'PY'
import sys
key = ""
with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if line.startswith("ARCKEP_ENGINE_SERVICE_KEY="):
            v = line.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            key = v.strip()
sys.stdout.write(key)
PY
)
    if [[ -z "$key" || "${#key}" -lt 32 ]]; then
        echo "unknown -1 -1"
        return 0
    fi

    local raw_resp curl_rc=0
    raw_resp=$(
        printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$key" | \
            curl -sS -w $'\n%{http_code}' --max-time 3 -K - \
            "http://127.0.0.1:${PORT}/chat/api/v1/arckep/engine-slot/status/" 2>/dev/null
    ) || curl_rc=$?

    if [[ $curl_rc -ne 0 || -z "$raw_resp" ]]; then
        echo "unknown -1 -1"
        return 0
    fi

    python3 - "$raw_resp" <<'PY'
import json, sys

raw = sys.argv[1]
parts = raw.rsplit("\n", 1)
if len(parts) != 2 or parts[1].strip() != "200":
    print("unknown -1 -1")
    sys.exit(0)

try:
    d = json.loads(parts[0])
except Exception:
    print("unknown -1 -1")
    sys.exit(0)

if not isinstance(d, dict):
    print("unknown -1 -1")
    sys.exit(0)

active_total = d.get("activeTotal")
retained = d.get("retainedTopicIds")
if type(active_total) is not int or active_total < 0 or not isinstance(retained, list):
    print("unknown -1 -1")
    sys.exit(0)

state = "idle" if active_total == 0 else "busy"
print(f"{state} {active_total} {len(retained)}")
PY
}

log "Начат drain слота ${SLOT} (:${PORT}, epoch=${EXPECTED_EPOCH}, grace=${GRACE_SEC}s, replayGrace=${REPLAY_GRACE_SEC}s, max=${MAX_WAIT_SEC}s)"
elapsed=0
retained_waited=0
confirmed_ready_to_stop=0
last_state="unknown"
last_active=-1

while (( elapsed < MAX_WAIT_SEC )); do
    if ! state_matches; then
        log "Состояние изменилось (слот активирован заново или новая эпоха) — отменяю остановку ${SLOT}."
        exit 0
    fi

    read -r st active_total retained_cnt < <(query_drain_status)
    last_state="$st"
    last_active="$active_total"

    if [[ "$st" == "stopped" ]]; then
        log "Служба ${SLOT_SERVICE} уже остановлена."
        confirmed_ready_to_stop=1
        break
    fi

    if [[ "$st" == "idle" ]]; then
        if (( retained_cnt > 0 && retained_waited < REPLAY_GRACE_SEC )); then
            step_sec=3
            rem=$((REPLAY_GRACE_SEC - retained_waited))
            if (( rem < step_sec )); then
                step_sec=$rem
            fi
            (( step_sec < 1 )) && step_sec=1
            sleep "$step_sec"
            elapsed=$((elapsed + step_sec))
            retained_waited=$((retained_waited + step_sec))
            continue
        fi

        if (( GRACE_SEC > 0 )); then
            log "activeTotal=0 (retained=${retained_cnt}) за ${elapsed}s; выдерживаю финальную паузу ${GRACE_SEC}s..."
            sleep "$GRACE_SEC"
            elapsed=$((elapsed + GRACE_SEC))
        fi

        if ! state_matches; then
            log "Состояние изменилось во время паузы — отменяю остановку ${SLOT}."
            exit 0
        fi

        read -r st_after active_after retained_after < <(query_drain_status)
        last_state="$st_after"
        last_active="$active_after"
        if [[ "$st_after" == "stopped" ]]; then
            confirmed_ready_to_stop=1
            break
        fi
        if [[ "$st_after" == "idle" ]] && (( retained_after == 0 || retained_waited >= REPLAY_GRACE_SEC )); then
            confirmed_ready_to_stop=1
            break
        fi
        log "После паузы слот ещё не пуст (state=${st_after}, activeTotal=${active_after}, retained=${retained_after}) — продолжаю ожидание."
        continue
    fi

    # busy or unknown — reset retained replay counter and keep waiting
    retained_waited=0
    sleep 3
    elapsed=$((elapsed + 3))
done

if [[ "$confirmed_ready_to_stop" != "1" ]]; then
    read -r st_final active_final retained_final < <(query_drain_status)
    if [[ "$st_final" == "stopped" || ( "$st_final" == "idle" && "$retained_final" -eq 0 ) ]]; then
        confirmed_ready_to_stop=1
    else
        crit "Достигнут потолок ожидания ${MAX_WAIT_SEC}s для ${SLOT}, но слот НЕ подтвердил завершение (state=${st_final}, activeTotal=${active_final}, retained=${retained_final}) — оставляю ${SLOT_SERVICE} ЖИВЫМ!"
        exit 1
    fi
fi

# P2 #13: Hold shared STATE_LOCK_FILE across final epoch verification, state update, and systemctl stop
mkdir -p "$(dirname "$STATE_LOCK_FILE")" 2>/dev/null || STATE_LOCK_FILE="/tmp/lobechat-engine-state.lock"
exec 6>>"$STATE_LOCK_FILE"
flock -w 15 6

if ! state_matches; then
    log "Состояние изменилось перед захватом замка завершения — отменяю остановку ${SLOT}."
    flock -u 6 || true
    exit 0
fi

read -r locked_st locked_active _locked_ret < <(query_drain_status)
if [[ "$locked_st" != "stopped" && "$locked_st" != "idle" ]]; then
    log "Перед остановкой обнаружена активность/неизвестность (state=${locked_st}, active=${locked_active}) — оставляю ${SLOT_SERVICE} живым."
    flock -u 6 || true
    exit 1
fi

tmp="${STATE_FILE}.drain.tmp.$$"
rc=0
python3 - "$STATE_FILE" "$tmp" "$SLOT" "$EXPECTED_EPOCH" <<'PY' || rc=$?
import json, os, sys
src, dst, slot, epoch = sys.argv[1:5]
with open(src, "r", encoding="utf-8") as fh:
    d = json.load(fh)
if d.get("activeSlot") == slot or d.get("drainingSlot") != slot or int(d.get("switchEpoch", -1)) != int(epoch):
    sys.exit(2)
d["drainingSlot"] = None
d["drainingPort"] = None
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
    fh.flush()
    os.fsync(fh.fileno())
os.chmod(dst, 0o644)
PY

if [[ $rc -ne 0 ]]; then
    rm -f "$tmp"
    log "Состояние изменилось при очистке drainingSlot — отменяю остановку ${SLOT}."
    flock -u 6 || true
    exit 0
fi

mv -Tf "$tmp" "$STATE_FILE"
systemctl reload "$ROUTER_SERVICE" 2>/dev/null || systemctl kill -s HUP "$ROUTER_SERVICE" 2>/dev/null || true
systemctl disable "$SLOT_SERVICE" 2>/dev/null || true

log "Останавливаю доработавший слот ${SLOT_SERVICE}..."
systemctl stop "$SLOT_SERVICE" 2>/dev/null || true
flock -u 6 || true
exec 6>&-
log "Слот ${SLOT} штатно погашен."
EOF
    if [[ "$(id -u)" -eq 0 ]]; then
        chown root:root "${helper}.tmp.$$"
    fi
    chmod 0755 "${helper}.tmp.$$"
    mv -Tf "${helper}.tmp.$$" "$helper"
}

start_slot_drain() {
    local draining_slot="$1" draining_port="$2" epoch="$3" env_path="$4"
    local draining_svc
    draining_svc=$(slot_service "$draining_slot")

    if slot_api_call POST "$draining_port" "drain" "$env_path" >/dev/null 2>&1; then
        log "Слот $draining_slot (:$draining_port) переведён в режим drain"
    else
        warn "Не удалось вызвать /arckep/engine-slot/drain на :$draining_port (возможно, слот уже остановлен или старый релиз)"
    fi

    write_slot_drainer_helper
    stop_background_drainer "$draining_slot"

    local helper="$ROUTER_DIR/slot-drainer.sh"
    local unit="lobechat-drain-${draining_slot}"
    local drain_token="drain-${draining_slot}-epoch-${epoch}-$$-$(date +%s)"

    if [[ "${ENGINE_FORCE_NOHUP_DRAINER:-0}" != "1" ]] && [[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1; then
        if systemd-run --quiet --collect --unit="$unit" \
            --property="StandardOutput=append:${LOG_FILE}" \
            --property="StandardError=append:${LOG_FILE}" \
            /bin/bash "$helper" \
            "$draining_slot" "$draining_port" "$epoch" "$STATE_FILE" \
            "$ROUTER_SERVICE" "$draining_svc" "$env_path" \
            "$DRAIN_GRACE_SEC" "$DRAIN_MAX_WAIT_SEC" "$REPLAY_GRACE_SEC" "$STATE_LOCK_FILE" "$drain_token"; then
            log "Запущен фоновый доводчик systemd ($unit.service)"
            return 0
        fi
    fi

    mkdir -p "$STATE_DIR"
    # Explicitly close all lock FDs (>2) in subshell so detached reaper NEVER holds deploy/build locks for 35m
    (
        exec 6>&- 7>&- 8>&- 9>&- 2>/dev/null || true
        if [[ -d "/proc/$BASHPID/fd" ]]; then
            for _fd_entry in "/proc/$BASHPID/fd/"*; do
                _fd_num="${_fd_entry##*/}"
                if [[ "$_fd_num" =~ ^[0-9]+$ ]] && (( _fd_num > 2 )); then
                    eval "exec ${_fd_num}>&-" 2>/dev/null || true
                fi
            done
        fi
        nohup /bin/bash "$helper" \
            "$draining_slot" "$draining_port" "$epoch" "$STATE_FILE" \
            "$ROUTER_SERVICE" "$draining_svc" "$env_path" \
            "$DRAIN_GRACE_SEC" "$DRAIN_MAX_WAIT_SEC" "$REPLAY_GRACE_SEC" "$STATE_LOCK_FILE" "$drain_token" \
            >>"$LOG_FILE" 2>&1 </dev/null &
        printf '%s:%s\n' "$!" "$drain_token" > "$STATE_DIR/drain-${draining_slot}.pid"
    )
    local drain_entry
    drain_entry=$(cat "$STATE_DIR/drain-${draining_slot}.pid" 2>/dev/null || echo "?")
    log "Запущен фоновый доводчик nohup (${drain_entry%%:*})"
}

install_router_and_units() {
    local mode="${1:-if-changed}"
    mkdir -p "$ROUTER_DIR"
    if [[ "$(id -u)" -eq 0 ]]; then
        chown root:root "$ROUTER_DIR"
    fi
    chmod 0755 "$ROUTER_DIR"
    if [[ ! -f "$ROUTER_DIR/engine-router.mjs" ]] || ! cmp -s "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs"; then
        cp -pf "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        if [[ "$(id -u)" -eq 0 ]]; then
            chown root:root "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        fi
        chmod 0755 "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        mv -Tf "$ROUTER_DIR/engine-router.mjs.tmp.$$" "$ROUTER_DIR/engine-router.mjs"
        log "Обновлён $ROUTER_DIR/engine-router.mjs"
    fi

    local reload_needed=0
    mkdir -p "$SYSTEMD_DIR"
    for unit_name in image-studio-lobechat-router.service image-studio-lobechat@.service; do
        local src_unit="$SRC/deploy/systemd/$unit_name"
        local dst_unit="$SYSTEMD_DIR/$unit_name"
        if [[ ! -f "$dst_unit" ]] || ! cmp -s "$src_unit" "$dst_unit"; then
            cp -pf "$src_unit" "${dst_unit}.tmp.$$"
            if [[ "$(id -u)" -eq 0 ]]; then
                chown root:root "${dst_unit}.tmp.$$"
            fi
            chmod 0644 "${dst_unit}.tmp.$$"
            mv -Tf "${dst_unit}.tmp.$$" "$dst_unit"
            reload_needed=1
            log "Установлен unit $dst_unit"
        fi
    done

    if [[ "$reload_needed" == "1" || "$mode" == "force-reload" ]]; then
        systemctl daemon-reload
        log "systemctl daemon-reload выполнен"
    fi
}

# P1 #8: .slot.env is owned root:root 0600 (read by systemd as root before dropping to User=lobechat)
write_slot_env_file() {
    local target_dir="$1" slot_name="$2" port="$3"
    local slot_env="$target_dir/.slot.env"
    local tmp_slot="${slot_env}.tmp.$$"
    install -m 0600 /dev/null "$tmp_slot"
    cat > "$tmp_slot" <<EOF
# Auto-generated by deploy-engine.sh — overrides PORT=3403 from .env while keeping INTERNAL_APP_URL on :3403
PORT=${port}
HOSTNAME=127.0.0.1
LOBECHAT_SLOT=${slot_name}
EOF
    if [[ "$(id -u)" -eq 0 ]]; then
        chown root:root "$tmp_slot"
    fi
    chmod 0600 "$tmp_slot"
    mv -Tf "$tmp_slot" "$slot_env"
}

# P1 #8: Ensure slot root & code stay root:root 0755, while ONLY .next/cache is writable by lobechat:lobechat
enforce_slot_permissions() {
    local slot_root="$1"
    mkdir -p "$slot_root/.next/cache"
    chmod 0755 "$slot_root" "$slot_root/.next" "$slot_root/.next/cache"
    if [[ "$(id -u)" -eq 0 ]]; then
        chown -R root:root "$slot_root"
        if id lobechat >/dev/null 2>&1; then
            chown -R lobechat:lobechat "$slot_root/.next/cache"
        fi
        [[ -f "$slot_root/.env" ]] && chmod 0600 "$slot_root/.env"
        [[ -f "$slot_root/.slot.env" ]] && chmod 0600 "$slot_root/.slot.env"
    fi
}

copy_verified_env_to_slot() {
    local src_env_dir="$1" dst_slot_dir="$2"
    if [[ ! -f "$src_env_dir/.env" ]]; then
        err "Исходный $src_env_dir/.env не найден!"
        return 1
    fi
    shopt -s nullglob
    for env_file in "$src_env_dir"/.env "$src_env_dir"/.env.bak*; do
        local dst_env="$dst_slot_dir/$(basename "$env_file")"
        local tmp_env="${dst_env}.tmp.$$"
        install -m 0600 /dev/null "$tmp_env"
        cp -pf "$env_file" "$tmp_env"
        if [[ "$(id -u)" -eq 0 ]]; then
            chown root:root "$tmp_env"
        fi
        chmod 0600 "$tmp_env"
        if ! cmp -s "$env_file" "$tmp_env"; then
            rm -f "$tmp_env"
            shopt -u nullglob
            err "Побайтовая сверка $(basename "$env_file") не сошлась в $dst_slot_dir!"
            return 1
        fi
        mv -Tf "$tmp_env" "$dst_env"
    done
    shopt -u nullglob

    if ! cmp -s "$src_env_dir/.env" "$dst_slot_dir/.env"; then
        err "Побайтовая сверка .env не сошлась в $dst_slot_dir!"
        return 1
    fi
}

# P1 #7: Fail-closed quietness check on legacy :$PORT before one-time --init cutover
check_legacy_port_quiet() {
    local env_path="$1"

    # If legacy service is not active and nothing listens on :$PORT, it is quiet
    if ! systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null; then
        if ! curl -sS --max-time 1 "http://127.0.0.1:${PORT}/chat/api/v1/health/" >/dev/null 2>&1; then
            return 0
        fi
    fi

    # 1. Try /arckep/engine-slot/status if legacy already exposes it
    local status_json=""
    status_json=$(slot_api_call GET "$PORT" "status" "$env_path" || true)
    if [[ -n "$status_json" ]]; then
        local parsed_state
        parsed_state=$(python3 - "$status_json" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
    t = d.get("activeTotal")
    if type(t) is int and t >= 0:
        print(f"ok:{t}")
    else:
        print("bad")
except Exception:
    print("bad")
PY
)
        if [[ "$parsed_state" == ok:* ]]; then
            local active_total="${parsed_state#ok:}"
            if (( active_total > 0 )); then
                err "На :$PORT сейчас активны операции (activeTotal=$active_total). Дождись завершения или передай '--init --force'."
                return 1
            fi
        fi
    fi

    # 2. Fail-closed established TCP socket check via ss with separate arguments
    if ! command -v ss >/dev/null 2>&1; then
        err "Утилита 'ss' недоступна — невозможно безопасно проверить отсутствие активных соединений на :$PORT (fail-closed)."
        return 1
    fi

    local ss_out ss_rc=0
    ss_out=$(ss -Htan state established "( sport = :$PORT )" 2>/dev/null) || ss_rc=$?
    if [[ $ss_rc -ne 0 ]]; then
        err "Команда 'ss -Htan state established ( sport = :$PORT )' завершилась с кодом $ss_rc (fail-closed)."
        return 1
    fi

    local established_count=0
    if [[ -n "$ss_out" ]]; then
        established_count=$(printf '%s\n' "$ss_out" | awk 'NF > 0 {c++} END {print c+0}')
    fi
    if (( established_count > 0 )); then
        err "На :$PORT обнаружены открытые клиентские соединения ($established_count). Дождись тихого окна или передай '--init --force'."
        return 1
    fi

    return 0
}

# =============================================================================
# STATUS (P2 #15 routerHash + P2 #17 non-zero exit when stopped/unhealthy/mismatched)
# =============================================================================
cmd_status() {
    local status_rc=0
    echo ""
    echo "=== LobeChat Engine Deploy Status (Blue-Green) ==="
    echo ""

    local active_slot="none" draining_slot="" epoch="0" prev_confirmed="" prev_commit=""
    if [[ -f "$STATE_FILE" ]]; then
        active_slot=$(read_state_field activeSlot || echo "none")
        draining_slot=$(read_state_field drainingSlot || echo "")
        epoch=$(read_state_field switchEpoch || echo "0")
        prev_confirmed=$(read_state_field previousConfirmedSlot || echo "")
        prev_commit=$(read_state_field previousConfirmedCommit || echo "")
    else
        echo "  WARNING: state file $STATE_FILE not found (not initialized)"
        status_rc=1
    fi

    if [[ "$active_slot" != "blue" && "$active_slot" != "green" ]]; then
        status_rc=1
    fi

    local disk_router_hash="missing"
    if [[ -f "$ROUTER_DIR/engine-router.mjs" ]]; then
        disk_router_hash=$(sha256sum "$ROUTER_DIR/engine-router.mjs" | awk '{print $1}')
    fi

    printf "  Router (127.0.0.1:%s): " "$PORT"
    if systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        local r_health
        r_health=$(curl -sS --max-time 2 "http://127.0.0.1:${PORT}/__router/health" 2>/dev/null || echo "")
        if [[ -z "$r_health" ]]; then
            echo "UNHEALTHY (process active, /__router/health unreachable)"
            status_rc=1
        else
            local parsed_router
            parsed_router=$(python3 - "$r_health" "$active_slot" "$disk_router_hash" <<'PY'
import json, sys
raw, expected_slot, disk_hash = sys.argv[1:4]
try:
    d = json.loads(raw)
except Exception:
    print("ERR|invalid JSON")
    sys.exit(0)
st = d.get("status")
r_slot = d.get("activeSlot")
r_hash = d.get("routerHash") or "unknown"
key_ok = d.get("serviceKeyConfigured", False)
hash_note = f"hash=match({r_hash[:12]})" if r_hash == disk_hash else f"hash=MISMATCH(live={r_hash[:12]},disk={disk_hash[:12]})"
if st != "ok" or r_slot != expected_slot or not key_ok:
    print(f"ERR|activeSlot={r_slot} expected={expected_slot} keyConfigured={key_ok} {hash_note}")
else:
    print(f"OK|activeSlot={r_slot} epoch={d.get('switchEpoch')} {hash_note}")
PY
)
            if [[ "$parsed_router" == OK\|* ]]; then
                echo "RUNNING — ${parsed_router#OK|}"
            else
                echo "DEGRADED — ${parsed_router#ERR|}"
                status_rc=1
            fi
        fi
    else
        echo "stopped"
        status_rc=1
    fi

    # Verify end-to-end health through router :$PORT -> declared active_slot
    if [[ "$status_rc" -eq 0 ]]; then
        local e2e_headers e2e_body e2e_slot
        e2e_headers=$(curl -sS -D - -o /dev/null --max-time 3 -H "Host: arckep.ru" "http://127.0.0.1:${PORT}/chat/api/v1/health/" 2>/dev/null || true)
        e2e_body=$(curl -sS --max-time 3 -H "Host: arckep.ru" "http://127.0.0.1:${PORT}/chat/api/v1/health/" 2>/dev/null || true)
        e2e_slot=$(printf '%s\n' "$e2e_headers" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-lobechat-slot"{print $2; exit}')
        if [[ "$e2e_body" != *'"status":"ok"'* || "$e2e_slot" != "$active_slot" ]]; then
            echo "  ERROR: End-to-end check on :$PORT failed (slot='${e2e_slot:-none}', expected='$active_slot')"
            status_rc=1
        fi
    fi

    if systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null; then
        echo "  WARNING: Legacy ($LEGACY_SERVICE): RUNNING alongside Blue-Green!"
        status_rc=1
    fi

    if [[ -e "$SWITCH_GUARD" || -L "$SWITCH_GUARD" ]]; then
        echo "  WARNING: Незавершённое переключение ($SWITCH_GUARD): $(cat "$SWITCH_GUARD" 2>/dev/null || true)"
        status_rc=1
    fi

    if [[ -L "$PROD" ]]; then
        echo "  Symlink $PROD -> $(readlink "$PROD")"
    elif [[ -d "$PROD" ]]; then
        echo "  Directory $PROD (legacy non-symlink)"
    fi
    echo "  Active slot: $active_slot (switchEpoch=$epoch, previousConfirmed=${prev_confirmed:-none}${prev_commit:+:${prev_commit:0:12}})"
    echo ""

    local env_path
    env_path=$(resolve_live_env_file 2>/dev/null || true)

    for color in blue green; do
        local c_port c_dir c_svc c_commit="none"
        c_port=$(slot_port "$color")
        c_dir=$(slot_dir "$color")
        c_svc=$(slot_service "$color")
        [[ -f "$c_dir/.deployed-commit" ]] && c_commit=$(head -c 12 "$c_dir/.deployed-commit" 2>/dev/null || echo "unknown")

        printf "  %-6s (port %s, commit %-12s): " "$color" "$c_port" "$c_commit"
        local st_kind st_active st_retained st_draining st_sbx
        read -r st_kind st_active st_retained st_draining st_sbx < <(query_slot_drain_state "$color" "$c_port" "$env_path")
        if [[ "$st_kind" == "stopped" ]]; then
            echo "stopped"
            if [[ "$color" == "$active_slot" ]]; then
                status_rc=1
            fi
        elif [[ "$st_kind" == "unknown" ]]; then
            echo "RUNNING [STATUS UNKNOWN — /engine-slot/status failed]"
            if [[ "$color" == "$active_slot" ]]; then
                status_rc=1
            fi
        else
            if [[ "$color" == "$active_slot" ]]; then
                echo "RUNNING [ACTIVE: active=${st_active}, retained=${st_retained}, draining=${st_draining}]"
                if [[ "$st_draining" == "true" ]]; then
                    status_rc=1
                fi
            elif [[ "$color" == "$draining_slot" ]]; then
                echo "RUNNING [DRAINING: active=${st_active}, retained=${st_retained}]"
            else
                echo "RUNNING [STANDBY: active=${st_active}]"
            fi
        fi
    done
    echo ""
    return "$status_rc"
}

# =============================================================================
# ROLLBACK (< 2s instant switch to previousConfirmedSlot + undrain + safe drain)
# =============================================================================
cmd_rollback() {
    acquire_deploy_lock "rollback"
    check_switch_allowed

    if [[ ! -f "$STATE_FILE" ]]; then
        err "Файл состояния $STATE_FILE не найден — сначала выполни '--init'."
        exit 1
    fi

    local current prev expected_prev_commit current_commit
    local current_port prev_port current_dir prev_dir current_svc prev_svc epoch next_epoch env_path
    current=$(read_state_field activeSlot || true)
    if [[ "$current" != "blue" && "$current" != "green" ]]; then
        err "Некорректный activeSlot='$current' в $STATE_FILE"
        exit 1
    fi

    prev=$(read_state_field previousConfirmedSlot || true)
    expected_prev_commit=$(read_state_field previousConfirmedCommit || true)
    local expected_other
    expected_other=$(other_slot "$current")

    if [[ -z "$prev" || "$prev" != "$expected_other" || -z "$expected_prev_commit" ]]; then
        err "Откат отклонён: нет подтверждённого предыдущего релиза (previousConfirmedSlot='${prev:-none}', previousConfirmedCommit='${expected_prev_commit:-none}')."
        exit 1
    fi

    current_port=$(slot_port "$current")
    prev_port=$(slot_port "$prev")
    current_dir=$(slot_dir "$current")
    prev_dir=$(slot_dir "$prev")
    current_svc=$(slot_service "$current")
    prev_svc=$(slot_service "$prev")
    current_commit=$(read_state_field activeCommit || true)
    [[ -z "$current_commit" ]] && current_commit=$(read_slot_commit "$current_dir" || true)
    epoch=$(read_state_field switchEpoch || echo 0)
    next_epoch=$((epoch + 1))

    if [[ ! -f "$prev_dir/server.js" || ! -f "$prev_dir/.next/BUILD_ID" || ! -f "$prev_dir/.deployed-commit" ]]; then
        err "Предыдущий слот $prev ($prev_dir) отсутствует или неполон — откат невозможен."
        exit 1
    fi

    local actual_prev_commit
    actual_prev_commit=$(read_slot_commit "$prev_dir")
    if [[ "$actual_prev_commit" != "$expected_prev_commit" ]]; then
        err "Откат отклонён: коммит в $prev_dir ($actual_prev_commit) не совпадает с подтверждённым previousConfirmedCommit ($expected_prev_commit)!"
        exit 1
    fi

    env_path=$(resolve_live_env_file) || {
        err "Не найден .env для синхронизации перед откатом."
        exit 1
    }

    stop_background_drainer "$prev"

    if [[ "$env_path" != "$prev_dir/.env" ]]; then
        copy_verified_env_to_slot "$(dirname "$env_path")" "$prev_dir"
    fi
    write_slot_env_file "$prev_dir" "$prev" "$prev_port"
    enforce_slot_permissions "$prev_dir"
    sync_router_service_key_file "$prev_dir/.env"
    sync

    local started_prev_here=0
    if ! systemctl is-active --quiet "$prev_svc" 2>/dev/null; then
        log "Поднимаю предыдущий подтверждённый слот $prev_svc (:$prev_port)..."
        systemctl start "$prev_svc"
        started_prev_here=1
    fi

    if ! check_port_health "$prev_port" "" 20; then
        err "Предыдущий слот $prev (:$prev_port) не прошёл проверку здоровья — оставляю $current активным!"
        if [[ "$started_prev_here" == "1" ]]; then
            systemctl stop "$prev_svc" 2>/dev/null || true
        fi
        exit 1
    fi

    # P1 #3: Resume SandboxJobWorker and clear draining flag BEFORE switching traffic!
    if ! slot_api_call POST "$prev_port" "undrain" "$prev_dir/.env" >/dev/null; then
        err "Не удалось выполнить /arckep/engine-slot/undrain на $prev (:$prev_port) — откат отменён!"
        if [[ "$started_prev_here" == "1" ]]; then
            systemctl stop "$prev_svc" 2>/dev/null || true
        fi
        exit 1
    fi

    local prev_st prev_active prev_ret prev_draining prev_sbx
    read -r prev_st prev_active prev_ret prev_draining prev_sbx < <(query_slot_drain_state "$prev" "$prev_port" "$prev_dir/.env")
    if [[ ( "$prev_st" != "idle" && "$prev_st" != "busy" ) || "$prev_draining" != "false" ]]; then
        err "Проверка /arckep/engine-slot/status на $prev (:$prev_port) не подтвердила готовность после undrain (state=$prev_st, draining=$prev_draining) — откат отменён!"
        if [[ "$started_prev_here" == "1" ]]; then
            systemctl stop "$prev_svc" 2>/dev/null || true
        fi
        exit 1
    fi

    log "Мгновенный откат роутера: $current (:$current_port) -> $prev (:$prev_port)..."
    systemctl enable "$prev_svc" 2>/dev/null || true
    begin_switch "$current" "$prev"
    atomic_symlink "$prev_dir" "$PROD"
    write_state_json "$prev" "$prev_port" "$current" "$current_port" "$next_epoch"
    notify_router_reload

    if ! check_port_health "$PORT" "$prev" 10; then
        err "CRITICAL: проверка :$PORT после отката на $prev не прошла — возвращаю маршрут на $current!"
        slot_api_call POST "$current_port" "undrain" "$current_dir/.env" >/dev/null 2>&1 || true
        atomic_symlink "$current_dir" "$PROD"
        write_state_json "$current" "$current_port" "$prev" "$prev_port" "$((next_epoch + 1))"
        notify_router_reload
        if check_port_health "$PORT" "$current" 10; then
            systemctl enable "$current_svc" 2>/dev/null || true
            systemctl disable "$prev_svc" 2>/dev/null || true
            clear_switch_guard
            start_slot_drain "$prev" "$prev_port" "$((next_epoch + 1))" "$current_dir/.env"
        else
            err "CRITICAL: возврат на $current также не прошёл проверку :$PORT! Оставляю оба процесса и $SWITCH_GUARD для ручной проверки!"
        fi
        reload_auditd_watches
        exit 1
    fi

    # Confirmed switch! Update confirmed metadata & keep ONLY active slot enabled across reboot (P2 #14)
    write_state_json "$prev" "$prev_port" "$current" "$current_port" "$next_epoch" \
        "$actual_prev_commit" "$current" "$current_commit"
    systemctl disable "$current_svc" 2>/dev/null || true
    clear_switch_guard
    start_slot_drain "$current" "$current_port" "$next_epoch" "$prev_dir/.env"
    reload_auditd_watches

    log "ROLLBACK OK: активен слот $prev (:$prev_port, commit $actual_prev_commit); $current переведён в drain."
}

# =============================================================================
# BUILD & STAGE HELPER (P2 #18: entire clean + build + stage runs under build.lock)
# =============================================================================
build_into_stage_dir_locked() {
    local stage_dir="$1" is_stage_only="$2" lock_hash_ref_dir="${3:-}"

    cd "$SRC"

    if [[ "$is_stage_only" != "1" && -n "$(git status --porcelain)" ]]; then
        err "Незакоммиченные изменения в $SRC — сначала закоммить (deploy is diff-driven)."
        git status --porcelain | head >&2
        exit 1
    fi

    HEAD_COMMIT=$(git rev-parse HEAD)
    LOCK_HASH=$(cat pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc packages/*/package.json 2>/dev/null | sha256sum | cut -d' ' -f1)
    local prev_lock_file="${lock_hash_ref_dir:+$lock_hash_ref_dir/.deployed-lockhash}"

    if [[ "$MODE" == "--install" || ( "$is_stage_only" != "1" && ( -z "$prev_lock_file" || ! -f "$prev_lock_file" || "$(cat "$prev_lock_file")" != "$LOCK_HASH" ) ) ]]; then
        log "pnpm install --frozen-lockfile"
        CI=true npm_config_package_manager_strict=false pnpm install --frozen-lockfile --config.confirmModulesPurge=false
    else
        log "pnpm install skipped (lockfile/manifests unchanged or stage-only)"
    fi

    if [[ ! -d public/_spa ]]; then
        if [[ "$is_stage_only" != "1" && -d /opt/lobechat-src/public/_spa ]]; then
            log "public/_spa отсутствует — беру готовые артефакты из /opt/lobechat-src/public/_spa"
            rsync -a /opt/lobechat-src/public/_spa/ public/_spa/
        else
            mkdir -p public/_spa
        fi
    fi

    local spa_templates="src/app/spa/[variants]/[[...path]]/spaHtmlTemplates.ts"
    if [[ ! -f "$spa_templates" ]]; then
        local copied_template=0
        if [[ "$is_stage_only" != "1" ]]; then
            for candidate in \
                "/var/tmp/wt/lobechat-engine/$spa_templates" \
                "/opt/lobechat-src/$spa_templates"; do
                if [[ -f "$candidate" ]]; then
                    log "$spa_templates отсутствует — беру готовый шаблон из $candidate"
                    cp -a "$candidate" "$spa_templates"
                    copied_template=1
                    break
                fi
            done
        fi
        if [[ "$copied_template" == "0" ]]; then
            log "Генерирую минимальный headless-шаблон $spa_templates (SPA не используется)"
            cat > "$spa_templates" <<'TS'
// Auto-generated headless stub when SPA is not built
import { mobileHtmlTemplate } from './mobileHtmlTemplate.source';

export const desktopHtmlTemplate = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

export { mobileHtmlTemplate };
TS
        fi
    fi

    if [[ "${ENGINE_SKIP_BUILD:-0}" != "1" ]]; then
        log "standalone next build (NEXT_BUILD_STANDALONE=1, SPA never rebuilt here)"
        rm -rf "$SRC/.next/standalone"
        if [[ -f "$SRC/.env" ]]; then
            env NEXT_BUILD_STANDALONE=1 bun run build:next
        else
            env \
                NEXT_BUILD_STANDALONE=1 \
                APP_URL="${APP_URL:-https://arckep.ru/chat}" \
                DATABASE_DRIVER="${DATABASE_DRIVER:-node}" \
                DATABASE_URL="${DATABASE_URL:-postgres://postgres:password@127.0.0.1:5432/postgres}" \
                KEY_VAULTS_SECRET="${KEY_VAULTS_SECRET:-build-placeholder-key-vaults-secret-32c}" \
                AUTH_SECRET="${AUTH_SECRET:-build-placeholder-better-auth-secret-32c}" \
                bun run build:next
        fi
    fi

    local standalone_root="$SRC/.next/standalone"
    local standalone_app=""
    if [[ -f "$standalone_root/server.js" ]]; then
        standalone_app="$standalone_root"
    elif [[ -f "$standalone_root/${SRC#/}/server.js" ]]; then
        standalone_app="$standalone_root/${SRC#/}"
    else
        err "standalone server.js not found under $standalone_root"
        exit 1
    fi

    if [[ ! -f "$SRC/.next/BUILD_ID" ]]; then
        err "$SRC/.next/BUILD_ID missing after build"
        exit 1
    fi

    rm -rf "$stage_dir"
    mkdir -p "$stage_dir/.next/cache"

    log "Собираю standalone runtime в $stage_dir"
    if [[ "$standalone_root" != "$standalone_app" && -d "$standalone_root/node_modules" ]]; then
        mkdir -p "$stage_dir/node_modules"
        rsync -a "$standalone_root/node_modules/" "$stage_dir/node_modules/"
    fi
    rsync -a "$standalone_app/" "$stage_dir/"
    rm -f "$stage_dir"/.env "$stage_dir"/.env.* "$stage_dir"/.slot.env
    mkdir -p "$stage_dir/.next/static" "$stage_dir/.next/cache"
    rsync -a --delete "$SRC/.next/static/" "$stage_dir/.next/static/"

    if [[ "$is_stage_only" != "1" && -d "$PROD/public" ]]; then
        mkdir -p "$stage_dir/public"
        rsync -a "$PROD/public/" "$stage_dir/public/"
    elif [[ -d "$SRC/public" ]]; then
        mkdir -p "$stage_dir/public"
        rsync -a "$SRC/public/" "$stage_dir/public/"
    fi

    # Guarantee native Linux bindings (sharp + @img/* + @napi-rs/canvas*) exist in standalone node_modules
    mkdir -p "$stage_dir/node_modules/.pnpm"
    shopt -s nullglob
    for pkg_dir in \
        "$SRC"/node_modules/.pnpm/sharp* \
        "$SRC"/node_modules/.pnpm/@img+* \
        "$SRC"/node_modules/.pnpm/@napi-rs+canvas* \
        "$SRC"/node_modules/.pnpm/detect-libc* \
        "$SRC"/node_modules/.pnpm/semver*; do
        local base_name
        base_name=$(basename "$pkg_dir")
        if [[ ! -e "$stage_dir/node_modules/.pnpm/$base_name" ]]; then
            cp -a "$pkg_dir" "$stage_dir/node_modules/.pnpm/$base_name"
        fi
    done
    for top_entry in sharp @img @napi-rs; do
        if [[ -e "$SRC/node_modules/$top_entry" && ! -e "$stage_dir/node_modules/$top_entry" ]]; then
            cp -a "$SRC/node_modules/$top_entry" "$stage_dir/node_modules/$top_entry"
        fi
    done
    shopt -u nullglob

    # Pre-flight verification
    if [[ ! -f "$stage_dir/server.js" || ! -f "$stage_dir/.next/BUILD_ID" ]]; then
        err "staged slot is missing server.js or .next/BUILD_ID"
        exit 1
    fi
    if ! cmp -s "$SRC/.next/BUILD_ID" "$stage_dir/.next/BUILD_ID"; then
        err "BUILD_ID mismatch between $SRC/.next/BUILD_ID and $stage_dir/.next/BUILD_ID"
        exit 1
    fi

    local expected_next_ver
    expected_next_ver=$(node -p "require('$SRC/node_modules/next/package.json').version")
    STAGED_NEXT_VER=$(node -p "require('$stage_dir/node_modules/next/package.json').version")
    if [[ "$expected_next_ver" != "$STAGED_NEXT_VER" ]]; then
        err "staged next version ($STAGED_NEXT_VER) != source next version ($expected_next_ver)"
        exit 1
    fi

    # Ensure no symlinks point outside $stage_dir (systemd PrivateTmp=true / ProtectHome=true)
    python3 - "$stage_dir" <<'PY'
import os, sys

root = os.path.realpath(sys.argv[1])
pnpm_hoist = os.path.join(root, "node_modules", ".pnpm", "node_modules") + os.sep
bad = []
for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
    for name in dirnames + filenames:
        full = os.path.join(dirpath, name)
        if os.path.islink(full):
            raw = os.readlink(full)
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
        cd "$stage_dir"
        node -e "
          const nextVer = require('./node_modules/next/package.json').version;
          require('sharp');
          require('@napi-rs/canvas');
          console.log('[engine] pre-flight OK: next@' + nextVer + ', sharp=ok, @napi-rs/canvas=ok');
        "
    )

    if [[ "$is_stage_only" == "1" ]]; then
        printf 'created=%s commit=%s\n' "$(date -Iseconds)" "$HEAD_COMMIT" > "$stage_dir/.stage-only-marker"
    fi
}

build_into_stage_dir() {
    run_with_build_lock build_into_stage_dir_locked "$@"
}

prepare_staged_slot_metadata() {
    local stage_dir="$1" slot_name="$2" slot_port_num="$3" env_source_dir="$4"

    echo "$HEAD_COMMIT" > "$stage_dir/.deployed-commit"
    echo "$LOCK_HASH" > "$stage_dir/.deployed-lockhash"
    rm -f "$stage_dir/.stage-only-marker"

    write_slot_env_file "$stage_dir" "$slot_name" "$slot_port_num"
    copy_verified_env_to_slot "$env_source_dir" "$stage_dir"
    enforce_slot_permissions "$stage_dir"
    sync
}

populate_slot_from_stage() {
    local stage_dir="$1" dst_slot_dir="$2" slot_name="$3" slot_port_num="$4" env_source_dir="$5"

    prepare_staged_slot_metadata "$stage_dir" "$slot_name" "$slot_port_num" "$env_source_dir"

    mkdir -p "$(dirname "$dst_slot_dir")"
    if [[ ! -e "$dst_slot_dir" ]] && mv -Tf "$stage_dir" "$dst_slot_dir" 2>/dev/null; then
        enforce_slot_permissions "$dst_slot_dir"
        sync
        return 0
    fi

    mkdir -p "$dst_slot_dir"
    rsync -a --delete --exclude='.env' --exclude='.env.bak*' "$stage_dir/" "$dst_slot_dir/"
    copy_verified_env_to_slot "$env_source_dir" "$dst_slot_dir"
    write_slot_env_file "$dst_slot_dir" "$slot_name" "$slot_port_num"
    enforce_slot_permissions "$dst_slot_dir"
    sync
}

# =============================================================================
# INIT: one-time cutover from legacy image-studio-lobechat-next -> blue + router
# =============================================================================
cmd_init() {
    local force_flag="${1:-}"
    acquire_deploy_lock "init"
    check_switch_allowed

    # P1 #7: Align strictly with Studio deploy.sh: refuse whenever STATE_FILE exists unless --init --force recovery
    if [[ -f "$STATE_FILE" ]]; then
        if systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null && [[ -L "$PROD" ]]; then
            err "Blue-Green уже инициализирован ($STATE_FILE существует, $ROUTER_SERVICE запущен). Используй обычный 'bash deploy-engine.sh'."
            exit 1
        fi
        if [[ "$force_flag" != "--force" ]]; then
            err "Обнаружен существующий $STATE_FILE при остановленном $ROUTER_SERVICE. Проверь '--status' или передай '--init --force' для восстановления."
            exit 1
        fi
        warn "Восстановление прерванной инициализации (--init --force)..."
    fi

    local init_env_dir="$PROD"
    if [[ ! -f "$init_env_dir/.env" && -f "$SLOT_BLUE_DIR/.env" && "$force_flag" == "--force" ]]; then
        init_env_dir="$SLOT_BLUE_DIR"
    fi
    if [[ ! -f "$init_env_dir/.env" ]]; then
        err "$PROD/.env не найден — инициализация невозможна."
        exit 1
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_port_quiet "$init_env_dir/.env"
    fi

    local blue_svc green_svc
    blue_svc=$(slot_service "blue")
    green_svc=$(slot_service "green")
    local had_blue_dir=0
    [[ -d "$SLOT_BLUE_DIR" ]] && had_blue_dir=1
    local cutover_committed=0

    STAGE_DIR="$(dirname "$SLOT_BLUE_DIR")/.lobechat-engine.stage.$$"
    cleanup_init() {
        rm -rf -- "${STAGE_DIR:-}"
        if [[ "$cutover_committed" != "1" ]]; then
            systemctl stop "$blue_svc" 2>/dev/null || true
            systemctl disable "$blue_svc" 2>/dev/null || true
            if [[ "$had_blue_dir" == "0" && "$init_env_dir" != "$SLOT_BLUE_DIR" ]]; then
                rm -rf -- "$SLOT_BLUE_DIR"
            fi
        fi
    }
    trap cleanup_init EXIT

    build_into_stage_dir "$STAGE_DIR" "0" "$init_env_dir"

    install_router_and_units "force-reload"
    sync_router_service_key_file "$init_env_dir/.env"

    stop_background_drainer "blue"
    systemctl stop "$blue_svc" 2>/dev/null || true
    systemctl disable "$green_svc" 2>/dev/null || true

    populate_slot_from_stage "$STAGE_DIR" "$SLOT_BLUE_DIR" "blue" "$BLUE_PORT" "$init_env_dir"
    rm -rf -- "${STAGE_DIR:-}"
    STAGE_DIR=""

    log "Запускаю слот $blue_svc на 127.0.0.1:$BLUE_PORT (без автозапуска до подтверждения переключения)..."
    systemctl start "$blue_svc"

    if ! check_port_health "$BLUE_PORT" "" 25; then
        err "Слот blue (:$BLUE_PORT) не прошёл проверку здоровья — старый $LEGACY_SERVICE на :$PORT не затронут!"
        exit 1
    fi

    local blue_st _ba _br _bd _bs
    read -r blue_st _ba _br _bd _bs < <(query_slot_drain_state "blue" "$BLUE_PORT" "$SLOT_BLUE_DIR/.env")
    if [[ "$blue_st" != "idle" && "$blue_st" != "busy" ]]; then
        err "Служебная ручка /arckep/engine-slot/status на :$BLUE_PORT недоступна (state=$blue_st) — отменяю переход!"
        exit 1
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_port_quiet "$SLOT_BLUE_DIR/.env"
    fi

    local legacy_backup="${PROD}.legacy-pre-bg"
    if [[ -e "$legacy_backup" ]]; then
        legacy_backup="${PROD}.legacy-pre-bg.$(date +%s)"
    fi

    log "Выполняю переключение со старой службы $LEGACY_SERVICE на blue (:$BLUE_PORT) + роутер (:$PORT)..."
    systemctl enable "$blue_svc" 2>/dev/null || true
    write_state_json "blue" "$BLUE_PORT" "" "" 1 "$HEAD_COMMIT" "null" "null"

    systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
    systemctl disable "$LEGACY_SERVICE" 2>/dev/null || true

    if [[ -L "$PROD" ]]; then
        rm -f "$PROD"
    elif [[ -d "$PROD" ]]; then
        mv "$PROD" "$legacy_backup"
    fi
    atomic_symlink "$SLOT_BLUE_DIR" "$PROD"

    if ! systemctl enable --now "$ROUTER_SERVICE" || ! check_port_health "$PORT" "blue" 15; then
        err "CRITICAL: роутер на :$PORT не прошёл проверку здоровья — откатываю к старой службе $LEGACY_SERVICE!"
        systemctl stop "$ROUTER_SERVICE" 2>/dev/null || true
        systemctl disable "$ROUTER_SERVICE" 2>/dev/null || true
        systemctl stop "$blue_svc" 2>/dev/null || true
        systemctl disable "$blue_svc" 2>/dev/null || true
        rm -f "$PROD" "$STATE_FILE"
        if [[ -d "$legacy_backup" ]]; then
            mv "$legacy_backup" "$PROD"
        fi
        systemctl enable --now "$LEGACY_SERVICE" || true
        check_port_health "$PORT" "" 15 || true
        reload_auditd_watches
        exit 1
    fi

    cutover_committed=1
    reload_auditd_watches
    log "INIT OK: роутер слушает :$PORT, активен слот blue (:$BLUE_PORT, commit $HEAD_COMMIT); старый каталог сохранён в $legacy_backup"
}

# =============================================================================
# BLUE-GREEN DEPLOY (default & --install)
# =============================================================================
cmd_deploy() {
    acquire_deploy_lock "$MODE"
    check_switch_allowed

    if [[ ! -f "$STATE_FILE" ]]; then
        err "Состояние $STATE_FILE не найдено (Blue-Green ещё не инициализирован)."
        err "Выполни однократный переход: bash deploy-engine.sh --init"
        exit 1
    fi

    local active target active_port target_port active_dir target_dir active_svc target_svc epoch next_epoch
    local active_commit orig_prev_slot orig_prev_commit
    active=$(read_state_field activeSlot || true)
    if [[ "$active" != "blue" && "$active" != "green" ]]; then
        err "Некорректный activeSlot='$active' в $STATE_FILE"
        exit 1
    fi
    target=$(other_slot "$active")
    active_port=$(slot_port "$active")
    target_port=$(slot_port "$target")
    active_dir=$(slot_dir "$active")
    target_dir=$(slot_dir "$target")
    active_svc=$(slot_service "$active")
    target_svc=$(slot_service "$target")
    epoch=$(read_state_field switchEpoch || echo 1)
    next_epoch=$((epoch + 1))

    active_commit=$(read_state_field activeCommit || true)
    [[ -z "$active_commit" ]] && active_commit=$(read_slot_commit "$active_dir" || true)
    orig_prev_slot=$(read_state_field previousConfirmedSlot || true)
    orig_prev_commit=$(read_state_field previousConfirmedCommit || true)

    if [[ ! -f "$active_dir/.env" ]]; then
        err "Не найден $active_dir/.env — выкладка остановлена!"
        exit 1
    fi

    log "Активный слот: $active (:$active_port) -> Собираю целевой слот: $target (:$target_port)"

    STAGE_DIR="$(dirname "$target_dir")/.lobechat-engine.stage.$$"
    BACKUP_TARGET_DIR=""
    HAD_PREVIOUS_TARGET_DIR=0
    CANDIDATE_INSTALLED=0

    # P1 #9: On failure before/after switch, restore previous confirmed backup OR wipe unconfirmed candidate dir!
    restore_target_slot_backup() {
        systemctl stop "$target_svc" 2>/dev/null || true
        systemctl disable "$target_svc" 2>/dev/null || true
        if [[ -n "${BACKUP_TARGET_DIR:-}" && -d "$BACKUP_TARGET_DIR" ]]; then
            rm -rf -- "$target_dir"
            mv -Tf "$BACKUP_TARGET_DIR" "$target_dir"
            BACKUP_TARGET_DIR=""
            log "Восстановлен предыдущий резервный слот $target ($target_dir)."
        elif [[ "$HAD_PREVIOUS_TARGET_DIR" == "0" && "$CANDIDATE_INSTALLED" == "1" ]]; then
            rm -rf -- "$target_dir"
            log "Удалён каталог неподтверждённого кандидата $target ($target_dir)."
        fi
    }

    cleanup_deploy_stage() {
        rm -rf -- "${STAGE_DIR:-}"
        if [[ -n "${BACKUP_TARGET_DIR:-}" && -d "$BACKUP_TARGET_DIR" ]]; then
            if [[ ! -f "$target_dir/server.js" ]]; then
                rm -rf -- "$target_dir"
                mv -Tf "$BACKUP_TARGET_DIR" "$target_dir" 2>/dev/null || true
            else
                rm -rf -- "$BACKUP_TARGET_DIR"
            fi
        fi
    }
    trap cleanup_deploy_stage EXIT

    build_into_stage_dir "$STAGE_DIR" "0" "$active_dir"
    prepare_staged_slot_metadata "$STAGE_DIR" "$target" "$target_port" "$active_dir"

    # P1 #1: Wait until target slot is confirmed stopped or idle (activeTotal===0); never stop on unknown/busy!
    wait_slot_idle_before_overwrite "$target" "$target_port" "$active_dir/.env"
    stop_background_drainer "$target"
    log "Останавливаю неактивный слот $target_svc перед обновлением файлов..."
    systemctl stop "$target_svc" 2>/dev/null || true
    systemctl disable "$target_svc" 2>/dev/null || true

    install_router_and_units "if-changed"
    sync_router_service_key_file "$active_dir/.env"
    notify_router_reload

    mkdir -p "$(dirname "$target_dir")"
    if [[ -d "$target_dir" ]]; then
        HAD_PREVIOUS_TARGET_DIR=1
        BACKUP_TARGET_DIR="${target_dir}.rollback-bak.$$"
        rm -rf -- "$BACKUP_TARGET_DIR"
        mv -Tf "$target_dir" "$BACKUP_TARGET_DIR"
    fi

    CANDIDATE_INSTALLED=1
    if mv -Tf "$STAGE_DIR" "$target_dir" 2>/dev/null; then
        STAGE_DIR=""
    else
        mkdir -p "$target_dir"
        rsync -a --delete --exclude='.env' --exclude='.env.bak*' "$STAGE_DIR/" "$target_dir/"
        copy_verified_env_to_slot "$active_dir" "$target_dir"
        write_slot_env_file "$target_dir" "$target" "$target_port"
        rm -rf -- "$STAGE_DIR"
        STAGE_DIR=""
    fi
    enforce_slot_permissions "$target_dir"
    sync

    # P2 #14: Start candidate WITHOUT enabling for boot yet; enable ONLY right before switch!
    log "Запускаю свежий слот $target_svc (:$target_port)..."
    if ! systemctl start "$target_svc"; then
        err "Не удалось запустить $target_svc — восстанавливаю резервный слот $target!"
        restore_target_slot_backup
        exit 1
    fi

    if ! check_port_health "$target_port" "" 25; then
        err "Свежий слот $target (:$target_port) не прошёл проверку здоровья — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    local cand_st _ca _cr cand_draining _csbx
    read -r cand_st _ca _cr cand_draining _csbx < <(query_slot_drain_state "$target" "$target_port" "$target_dir/.env")
    if [[ ( "$cand_st" != "idle" && "$cand_st" != "busy" ) || "$cand_draining" != "false" ]]; then
        err "Служебная ручка /arckep/engine-slot/status на :$target_port не прошла проверку (state=$cand_st, draining=$cand_draining) — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    if ! systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        log "Роутер $ROUTER_SERVICE был остановлен — запускаю..."
        systemctl enable --now "$ROUTER_SERVICE"
    fi

    # Enable target slot for boot right before switching; keep previousConfirmedSlot unchanged until :$PORT passes!
    systemctl enable "$target_svc" 2>/dev/null || true
    log "Переключаю роутер :$PORT на $target (:$target_port), старый $active (:$active_port) уходит в drain..."
    begin_switch "$active" "$target"
    atomic_symlink "$target_dir" "$PROD"
    write_state_json "$target" "$target_port" "$active" "$active_port" "$next_epoch"
    notify_router_reload

    if ! check_port_health "$PORT" "$target" 15; then
        # P1 #6: Safe emergency revert — restore route to $active first, keep both alive if :$PORT fails,
        # and drain $target before stopping/restoring if $target accepted any requests!
        err "CRITICAL: проверка :$PORT после переключения на $target не прошла — возвращаю маршрут на $active!"
        local revert_epoch=$((next_epoch + 1))
        slot_api_call POST "$active_port" "undrain" "$active_dir/.env" >/dev/null 2>&1 || true
        atomic_symlink "$active_dir" "$PROD"
        write_state_json "$active" "$active_port" "$target" "$target_port" "$revert_epoch" \
            "$active_commit" "${orig_prev_slot:-null}" "${orig_prev_commit:-null}"
        notify_router_reload

        if ! check_port_health "$PORT" "$active" 10; then
            err "CRITICAL: возврат маршрута на $active также не прошёл проверку :$PORT! Оставляю оба слота ($active_svc и $target_svc) и сторож $SWITCH_GUARD живыми для ручной диагностики!"
            reload_auditd_watches
            exit 1
        fi

        systemctl enable "$active_svc" 2>/dev/null || true
        systemctl disable "$target_svc" 2>/dev/null || true
        clear_switch_guard

        slot_api_call POST "$target_port" "drain" "$target_dir/.env" >/dev/null 2>&1 || true
        local drain_wait=0 rev_st="" rev_active=0 _rr=0 _rd="" _rs=""
        while (( drain_wait < 30 )); do
            read -r rev_st rev_active _rr _rd _rs < <(query_slot_drain_state "$target" "$target_port" "$target_dir/.env")
            if [[ "$rev_st" == "stopped" || "$rev_st" == "idle" ]]; then
                break
            fi
            sleep 2
            drain_wait=$((drain_wait + 2))
        done

        if [[ "$rev_st" == "stopped" || "$rev_st" == "idle" ]]; then
            write_state_json "$active" "$active_port" "" "" "$revert_epoch" \
                "$active_commit" "${orig_prev_slot:-null}" "${orig_prev_commit:-null}"
            notify_router_reload
            restore_target_slot_backup
        else
            warn "Неудачный кандидат $target успел принять работу (state=$rev_st, activeTotal=$rev_active) — передаю фоновому drainer без перезаписи рабочего каталога!"
            rm -rf -- "${BACKUP_TARGET_DIR:-}"
            BACKUP_TARGET_DIR=""
            start_slot_drain "$target" "$target_port" "$revert_epoch" "$active_dir/.env"
        fi
        reload_auditd_watches
        exit 1
    fi

    # Switch confirmed! Persist previousConfirmedSlot/Commit and disable old slot autostart (P1 #9 + P2 #14)
    write_state_json "$target" "$target_port" "$active" "$active_port" "$next_epoch" \
        "$HEAD_COMMIT" "$active" "${active_commit:-null}"
    systemctl disable "$active_svc" 2>/dev/null || true
    clear_switch_guard

    if [[ -n "$BACKUP_TARGET_DIR" && -d "$BACKUP_TARGET_DIR" ]]; then
        rm -rf -- "$BACKUP_TARGET_DIR"
        BACKUP_TARGET_DIR=""
    fi

    start_slot_drain "$active" "$active_port" "$next_epoch" "$target_dir/.env"
    reload_auditd_watches

    log "OK: next@$STAGED_NEXT_VER, commit $HEAD_COMMIT активен на слоте $target (:$target_port); старый $active переведён в drain."
}

# =============================================================================
# DISPATCH
# =============================================================================
case "$MODE" in
    --stage-only)
        validate_stage_only_dir "$STAGE_OUT"
        build_into_stage_dir "$STAGE_OUT" "1" ""
        log "stage-only complete at $STAGE_OUT (live $PROD untouched)"
        ;;
    --status)
        cmd_status
        ;;
    --rollback)
        cmd_rollback
        ;;
    --init)
        cmd_init "$INIT_FORCE"
        ;;
    deploy|--install)
        cmd_deploy
        ;;
    *)
        err "Неизвестный режим: $MODE"
        usage >&2
        exit 1
        ;;
esac
