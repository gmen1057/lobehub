#!/usr/bin/env bash
# Бесшовная Blue-Green выкладка движка чата (LobeChat без интерфейса) за постоянным HTTP/SSE-роутером :3403.
#
# Архитектура:
#   * 127.0.0.1:3403 — постоянный умный роутер image-studio-lobechat-router.service (/opt/lobechat-next-router/engine-router.mjs);
#   * слоты: blue (/opt/lobechat-next-blue, :3404) и green (/opt/lobechat-next-green, :3405) под image-studio-lobechat@{blue,green};
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
#   bash deploy-engine.sh --status         # статус роутера :3403 и обоих слотов blue (3404) / green (3405)
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
  bash deploy-engine.sh --status            # Статус роутера :3403 и слотов blue (3404) / green (3405)
  bash deploy-engine.sh --stage-only [DIR]  # Собрать и проверить standalone-слот в DIR без касания прода
  bash deploy-engine.sh --help | -h         # Показать эту справку
EOF
}

# =============================================================================
# STRICT ARGUMENT VALIDATION (fail-fast BEFORE any locks, installs, or builds)
# =============================================================================
MODE=""
INIT_FORCE=""
RAW_STAGE_OUT="/var/tmp/lc-engine-stage-check"
STAGE_TARGET=""
STAGE_OUT=""

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
                RAW_STAGE_OUT="$2"
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

# #2: Resolve canonical absolute STAGE_TARGET BEFORE any `cd "$SRC"` so relative paths
# can NEVER be validated against caller CWD and later wiped relative to $SRC!
if [[ "$MODE" == "--stage-only" ]]; then
    if [[ -z "$RAW_STAGE_OUT" ]]; then
        err "Пустой путь для --stage-only."
        exit 1
    fi
    if [[ -L "${RAW_STAGE_OUT%/}" || -L "$RAW_STAGE_OUT" ]]; then
        err "Путь --stage-only '$RAW_STAGE_OUT' является симлинком — отказ!"
        exit 1
    fi
    STAGE_TARGET="$(realpath -m -- "$RAW_STAGE_OUT")"
    STAGE_OUT="$STAGE_TARGET"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${ENGINE_SRC:-$SCRIPT_DIR}"
PROD="${ENGINE_PROD:-/opt/lobechat-next}"
SLOT_BLUE_DIR="${ENGINE_SLOT_BLUE_DIR:-/opt/lobechat-next-blue}"
SLOT_GREEN_DIR="${ENGINE_SLOT_GREEN_DIR:-/opt/lobechat-next-green}"
BLUE_PORT="${ENGINE_BLUE_PORT:-3404}"
GREEN_PORT="${ENGINE_GREEN_PORT:-3405}"
ROUTER_DIR="${ENGINE_ROUTER_DIR:-/opt/lobechat-next-router}"
PORT="${ENGINE_PORT:-${LOBECHAT_PORT:-3403}}"

STATE_FILE="${ENGINE_STATE_FILE:-${LOBECHAT_STATE_FILE:-${ENGINE_STATE_DIR:-/var/lib/lobechat-engine}/state.json}}"
STATE_DIR="${ENGINE_STATE_DIR:-$(dirname "$STATE_FILE")}"
SWITCH_GUARD="$STATE_DIR/.switch-pending"

LEGACY_SERVICE="${ENGINE_SERVICE:-${LOBECHAT_SERVICE:-image-studio-lobechat-next}}"
ROUTER_SERVICE="${ENGINE_ROUTER_SERVICE:-image-studio-lobechat-router}"
ROUTER_SOCKET="${ROUTER_SERVICE}.socket"
SLOT_UNIT_PREFIX="${ENGINE_SLOT_UNIT_PREFIX:-image-studio-lobechat@}"
SYSTEMD_DIR="${ENGINE_SYSTEMD_DIR:-/etc/systemd/system}"
LOG_FILE="${ENGINE_LOG_FILE:-/var/log/image-studio-lobechat-next.log}"

DEPLOY_LOCK_FILE="${ENGINE_DEPLOY_LOCK:-/run/lock/lobechat-engine-deploy.lock}"
STATE_LOCK_FILE="${ENGINE_STATE_LOCK:-/run/lock/lobechat-engine-state.lock}"
BUILD_LOCK_FILE="${ENGINE_BUILD_LOCK:-/var/tmp/wt/.lobechat-build.lock}"
DRAIN_GRACE_SEC="${ENGINE_DRAIN_GRACE_SEC:-15}"
REPLAY_GRACE_SEC="${ENGINE_REPLAY_GRACE_SEC:-610}"
DRAIN_MAX_WAIT_SEC="${ENGINE_DRAIN_MAX_WAIT_SEC:-2100}"
NODE_BIN="${ENGINE_NODE_BIN:-/usr/bin/node}"

# Top-level globals read by EXIT traps (#5: NEVER declare trap variables `local` inside functions!)
HEAD_COMMIT=""
LOCK_HASH=""
STAGED_NEXT_VER=""
BUILD_LOCK_ACQUIRED_HERE=0
STAGE_DIR=""
INIT_CUTOVER_COMMITTED=0
INIT_BLUE_SVC=""
INIT_HAD_BLUE_DIR=0
INIT_ENV_DIR=""
INIT_READY_STATE=""
INIT_TMP_SYMLINK=""
ROUTER_CORE_PREV_BACKUP=""
DEPLOY_TARGET_DIR=""
DEPLOY_TARGET_SVC=""
DEPLOY_TARGET_SLOT=""
BACKUP_TARGET_DIR=""
HAD_PREVIOUS_TARGET_DIR=0
CANDIDATE_INSTALLED=0

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

acquire_build_lock() {
    mkdir -p "$(dirname "$BUILD_LOCK_FILE")"
    if already_holds_build_lock; then
        log "Замок сборки $BUILD_LOCK_FILE уже удерживается внешним flock — продолжаю без повторного захвата."
        BUILD_LOCK_ACQUIRED_HERE=0
        return 0
    fi
    exec 8>"$BUILD_LOCK_FILE"
    if ! flock -n -x 8; then
        log "Ожидание замка сборки $BUILD_LOCK_FILE..."
        flock -x 8
    fi
    BUILD_LOCK_ACQUIRED_HERE=1
}

release_build_lock() {
    if [[ "${BUILD_LOCK_ACQUIRED_HERE:-0}" == "1" ]]; then
        flock -u 8 2>/dev/null || true
        exec 8>&- 2>/dev/null || true
        BUILD_LOCK_ACQUIRED_HERE=0
    fi
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

build_state_json_file() {
    local dst_file="$1"
    local active_slot="$2" active_port="$3" draining_slot="${4:-}" draining_port="${5:-}" epoch="$6"
    local active_commit="${7:-__KEEP__}" prev_confirmed_slot="${8:-__KEEP__}" prev_confirmed_commit="${9:-__KEEP__}"
    mkdir -p "$STATE_DIR"
    chmod 0755 "$STATE_DIR"
    python3 - "$STATE_FILE" "$dst_file" "$active_slot" "$active_port" "$draining_slot" "$draining_port" "$epoch" \
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
    [[ -f "$dst_file" ]]
}

write_state_json_unlocked() {
    local tmp_file="${STATE_FILE}.tmp.$$"
    build_state_json_file "$tmp_file" "$@" || return 1
    mv -Tf "$tmp_file" "$STATE_FILE" || {
        rm -f "$tmp_file"
        return 1
    }
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

# Write minimal router service-key file(s) ($ROUTER_DIR/.service-key[-<slot>].env, root:lobechat 0640)
# so router SIGHUP reloads per-slot ARCKEP_ENGINE_SERVICE_KEY (#11) without needing access to 0600 .env
write_single_router_key_file() {
    local dst_key_file="$1" svc_key="$2"
    mkdir -p "$ROUTER_DIR"
    chmod 0755 "$ROUTER_DIR"
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

sync_slot_router_service_key_file() {
    local env_path="$1" slot_name="$2"
    [[ -f "$env_path" && -n "$slot_name" ]] || return 1
    local svc_key
    svc_key=$(read_service_key_from_env "$env_path" || true)
    if [[ -z "$svc_key" || "${#svc_key}" -lt 32 ]]; then
        err "ARCKEP_ENGINE_SERVICE_KEY в $env_path отсутствует или короче 32 символов!"
        return 1
    fi
    write_single_router_key_file "$ROUTER_DIR/.service-key-${slot_name}.env" "$svc_key"
}

sync_router_service_key_file() {
    local env_path="$1" slot_name="${2:-}"
    [[ -f "$env_path" ]] || return 1
    local svc_key
    svc_key=$(read_service_key_from_env "$env_path" || true)
    if [[ -z "$svc_key" || "${#svc_key}" -lt 32 ]]; then
        err "ARCKEP_ENGINE_SERVICE_KEY в $env_path отсутствует или короче 32 символов!"
        return 1
    fi
    write_single_router_key_file "$ROUTER_DIR/.service-key.env" "$svc_key"
    if [[ -n "$slot_name" ]]; then
        write_single_router_key_file "$ROUTER_DIR/.service-key-${slot_name}.env" "$svc_key"
    fi
}

# #1: Strict systemd unit state query via `systemctl show -p LoadState,ActiveState,SubState`.
# Outputs ONLY: `stopped` | `active` | `unknown`.
# Any D-Bus / systemctl error, missing output, or LoadState=error -> `unknown` (NEVER `stopped`!).
get_systemd_unit_state() {
    local unit_name="$1"
    local show_out show_rc=0
    show_out=$(systemctl show -p LoadState,ActiveState,SubState "$unit_name" 2>/dev/null) || show_rc=$?
    if [[ $show_rc -ne 0 || -z "$show_out" ]]; then
        echo "unknown"
        return 0
    fi

    python3 - "$show_out" <<'PY'
import sys

props = {}
for raw_line in sys.argv[1].splitlines():
    if "=" in raw_line:
        k, v = raw_line.split("=", 1)
        props[k.strip()] = v.strip()

load_st = props.get("LoadState", "")
active_st = props.get("ActiveState", "")
sub_st = props.get("SubState", "")

if not load_st or not active_st or not sub_st or load_st in ("error", "bad-setting"):
    print("unknown")
elif active_st == "inactive" and sub_st == "dead":
    print("stopped")
elif active_st == "failed" and sub_st in ("failed", "dead"):
    print("stopped")
elif active_st in ("active", "activating", "reloading", "deactivating"):
    print("active")
else:
    print("unknown")
PY
}

# #1: Stop a slot service and strictly verify exit code 0 + confirmed `ActiveState=inactive`
# BEFORE modifying, moving, or deleting any slot directory!
stop_slot_service_verified() {
    local svc="$1"
    local pre_st
    pre_st=$(get_systemd_unit_state "$svc")
    if [[ "$pre_st" == "unknown" ]]; then
        err "Не удалось проверить состояние systemd для '$svc' (state=unknown) — остановка и модификация каталога запрещены!"
        return 1
    fi
    if [[ "$pre_st" == "stopped" ]]; then
        systemctl reset-failed "$svc" 2>/dev/null || true
        return 0
    fi

    if ! systemctl stop "$svc"; then
        err "Команда 'systemctl stop $svc' завершилась с ошибкой — модификация каталога запрещена!"
        return 1
    fi

    local i show_out show_rc active_st sub_st
    for i in $(seq 1 70); do
        show_rc=0
        show_out=$(systemctl show -p LoadState,ActiveState,SubState "$svc" 2>/dev/null) || show_rc=$?
        if [[ $show_rc -eq 0 && -n "$show_out" ]]; then
            active_st=$(printf '%s\n' "$show_out" | awk -F= '$1=="ActiveState"{print $2; exit}')
            sub_st=$(printf '%s\n' "$show_out" | awk -F= '$1=="SubState"{print $2; exit}')
            if [[ "$active_st" == "inactive" && "$sub_st" == "dead" ]]; then
                return 0
            fi
            if [[ "$active_st" == "failed" && ( "$sub_st" == "failed" || "$sub_st" == "dead" ) ]]; then
                systemctl reset-failed "$svc" 2>/dev/null || true
                show_rc=0
                show_out=$(systemctl show -p ActiveState "$svc" 2>/dev/null) || show_rc=$?
                active_st=$(printf '%s\n' "$show_out" | awk -F= '$1=="ActiveState"{print $2; exit}')
                if [[ $show_rc -eq 0 && ( "$active_st" == "inactive" || "$active_st" == "failed" ) ]]; then
                    return 0
                fi
            fi
        fi
        sleep 0.5
    done

    err "Служба '$svc' не подтвердила ActiveState=inactive после systemctl stop — модификация каталога запрещена!"
    return 1
}

slot_name_from_port() {
    local port="$1"
    if [[ "$port" == "$BLUE_PORT" ]]; then
        echo "blue"
    elif [[ "$port" == "$GREEN_PORT" ]]; then
        echo "green"
    else
        echo ""
    fi
}

# Call engine-slot endpoint via stdin curl config so the service key never appears in argv/ps (#11)
slot_api_call() {
    local method="$1" port="$2" endpoint="$3" env_path="${4:-}"
    local slot_hint
    slot_hint=$(slot_name_from_port "$port")

    local -a key_files=()
    if [[ -n "$env_path" && -f "$env_path" ]]; then
        key_files+=("$env_path")
    fi
    if [[ -n "$slot_hint" ]]; then
        local s_dir
        s_dir=$(slot_dir "$slot_hint")
        [[ -f "$s_dir/.env" ]] && key_files+=("$s_dir/.env")
        [[ -f "$ROUTER_DIR/.service-key-${slot_hint}.env" ]] && key_files+=("$ROUTER_DIR/.service-key-${slot_hint}.env")
    fi
    local fallback_env
    fallback_env=$(resolve_live_env_file 2>/dev/null || true)
    [[ -n "$fallback_env" && -f "$fallback_env" ]] && key_files+=("$fallback_env")

    [[ ${#key_files[@]} -gt 0 ]] || return 1

    local tried_keys="|" kf svc_key raw_resp curl_rc body http_code
    for kf in "${key_files[@]}"; do
        svc_key=$(read_service_key_from_env "$kf" || true)
        [[ -n "$svc_key" && "${#svc_key}" -ge 32 ]] || continue
        [[ "$tried_keys" == *"|${svc_key}|"* ]] && continue
        tried_keys="${tried_keys}${svc_key}|"

        curl_rc=0
        raw_resp=$(
            printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$svc_key" | \
                curl -sS -w $'\n%{http_code}' --max-time 3 -X "$method" -K - \
                "http://127.0.0.1:${port}/chat/api/v1/arckep/engine-slot/${endpoint}/" 2>/dev/null
        ) || curl_rc=$?

        if [[ $curl_rc -ne 0 || -z "$raw_resp" ]]; then
            return 1
        fi
        http_code="${raw_resp##*$'\n'}"
        body="${raw_resp%$'\n'*}"
        if [[ "$http_code" == "200" ]]; then
            printf '%s' "$body"
            return 0
        fi
        if [[ "$http_code" != "401" ]]; then
            return 1
        fi
    done
    return 1
}

# P1 #1: Strict tri-state slot status query (`stopped` | `idle` | `busy` | `unknown`).
# Outputs: `<state> <activeTotal> <retainedCount> <drainingBool> <sandboxWorkerRunningBool>`
# NEVER treats systemd/D-Bus errors, HTTP errors, timeouts, missing keys, or malformed JSON as `stopped` or `0`!
query_slot_drain_state() {
    local slot="$1" port="$2" env_path="${3:-}"
    local svc unit_st
    svc=$(slot_service "$slot")
    unit_st=$(get_systemd_unit_state "$svc")
    if [[ "$unit_st" == "stopped" ]]; then
        echo "stopped 0 0 false false"
        return 0
    fi
    if [[ "$unit_st" != "active" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    local raw_body
    if ! raw_body=$(slot_api_call GET "$port" "status" "$env_path"); then
        echo "unknown -1 -1 false false"
        return 0
    fi
    if [[ -z "$raw_body" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    python3 - "$raw_body" <<'PY'
import json, sys

body = sys.argv[1]
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

# P1 #1 + #6: Wait until target slot is confirmed stopped OR completely idle (`activeTotal===0` AND
# `retainedTopicIds.length===0`, bounded by `REPLAY_GRACE_SEC` = 610s while `activeTotal===0` so
# rapid back-to-back deploys NEVER destroy the 10-minute reconnect replay window!).
# If status is `busy` or `unknown`, NEVER stop the slot; abort deploy if DRAIN_MAX_WAIT_SEC expires!
wait_slot_idle_before_overwrite() {
    local slot="$1" port="$2" env_path="$3"
    local waited=0 retained_waited=0 st="" active_total=0 retained_cnt=0 draining_flag="" sbx_flag=""
    while (( waited < DRAIN_MAX_WAIT_SEC )); do
        read -r st active_total retained_cnt draining_flag sbx_flag < <(query_slot_drain_state "$slot" "$port" "$env_path")
        case "$st" in
            stopped)
                return 0
                ;;
            idle)
                if (( retained_cnt == 0 )); then
                    return 0
                fi
                if (( retained_waited >= REPLAY_GRACE_SEC )); then
                    log "Окно реплея (${REPLAY_GRACE_SEC}s) на слоте $slot (:$port) при activeTotal=0 выдержано (retained=$retained_cnt) — разрешаю перезапись."
                    return 0
                fi
                local step_sec=5
                local rem=$((REPLAY_GRACE_SEC - retained_waited))
                if (( rem < step_sec )); then
                    step_sec=$rem
                fi
                (( step_sec < 1 )) && step_sec=1
                log "Целевой слот $slot (:$port) сохраняет окно реплея (activeTotal=0, retained=$retained_cnt, ждём ${retained_waited}/${REPLAY_GRACE_SEC}s)..."
                sleep "$step_sec"
                waited=$((waited + step_sec))
                retained_waited=$((retained_waited + step_sec))
                continue
                ;;
            busy)
                retained_waited=0
                log "Целевой слот $slot (:$port) ещё дорабатывает прошлую выкладку (activeTotal=$active_total, ждём ${waited}s)..."
                ;;
            *)
                retained_waited=0
                warn "Статус целевого слота $slot (:$port) неизвестен (state=$st) — останавливать живой слот нельзя, повтор через 5s (${waited}s)..."
                ;;
        esac
        sleep 5
        waited=$((waited + 5))
    done

    read -r st active_total retained_cnt draining_flag sbx_flag < <(query_slot_drain_state "$slot" "$port" "$env_path")
    if [[ "$st" == "stopped" ]] || { [[ "$st" == "idle" ]] && (( retained_cnt == 0 || retained_waited >= REPLAY_GRACE_SEC )); }; then
        return 0
    fi
    err "CRITICAL: целевой слот $slot (:$port) не подтвердил освобождение за ${DRAIN_MAX_WAIT_SEC}s (state=$st, activeTotal=$active_total, retained=$retained_cnt) — остановка запрещена!"
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
REPLAY_GRACE_SEC="${10:-610}"
STATE_LOCK_FILE="${11:-/run/lock/lobechat-engine-state.lock}"
DRAIN_TOKEN="${12:-}"
RESTORE_BACKUP_DIR="${13:-}"
TARGET_SLOT_DIR="${14:-}"

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

get_unit_state() {
    local show_out show_rc=0
    show_out=$(systemctl show -p LoadState,ActiveState,SubState "$SLOT_SERVICE" 2>/dev/null) || show_rc=$?
    if [[ $show_rc -ne 0 || -z "$show_out" ]]; then
        echo "unknown"
        return 0
    fi
    python3 - "$show_out" <<'PY'
import sys
props = {}
for raw_line in sys.argv[1].splitlines():
    if "=" in raw_line:
        k, v = raw_line.split("=", 1)
        props[k.strip()] = v.strip()
load_st = props.get("LoadState", "")
active_st = props.get("ActiveState", "")
sub_st = props.get("SubState", "")
if not load_st or not active_st or not sub_st or load_st in ("error", "bad-setting"):
    print("unknown")
elif active_st == "inactive" and sub_st == "dead":
    print("stopped")
elif active_st == "failed" and sub_st in ("failed", "dead"):
    print("stopped")
elif active_st in ("active", "activating", "reloading", "deactivating"):
    print("active")
else:
    print("unknown")
PY
}

read_service_key() {
    local path="$1"
    [[ -f "$path" ]] || return 1
    python3 - "$path" <<'PY'
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
if key:
    sys.stdout.write(key)
PY
}

send_drain_command() {
    local key
    key=$(read_service_key "$ENV_FILE" || true)
    [[ -n "$key" && "${#key}" -ge 32 ]] || return 1
    printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$key" | \
        curl -sS --fail --max-time 3 -X POST -K - \
        "http://127.0.0.1:${PORT}/chat/api/v1/arckep/engine-slot/drain/" >/dev/null 2>&1
}

# #1 + #8: Strict check (`stopped` | `idle` | `busy` | `unknown`) + retained count + draining + sandboxWorkerRunning
query_drain_status() {
    local unit_st
    unit_st=$(get_unit_state)
    if [[ "$unit_st" == "stopped" ]]; then
        echo "stopped 0 0 false false"
        return 0
    fi
    if [[ "$unit_st" != "active" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    local key
    key=$(read_service_key "$ENV_FILE" || true)
    if [[ -z "$key" || "${#key}" -lt 32 ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    local raw_resp curl_rc=0
    raw_resp=$(
        printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$key" | \
            curl -sS -w $'\n%{http_code}' --max-time 3 -K - \
            "http://127.0.0.1:${PORT}/chat/api/v1/arckep/engine-slot/status/" 2>/dev/null
    ) || curl_rc=$?

    if [[ $curl_rc -ne 0 || -z "$raw_resp" ]]; then
        echo "unknown -1 -1 false false"
        return 0
    fi

    python3 - "$raw_resp" <<'PY'
import json, sys

raw = sys.argv[1]
parts = raw.rsplit("\n", 1)
if len(parts) != 2 or parts[1].strip() != "200":
    print("unknown -1 -1 false false")
    sys.exit(0)

try:
    d = json.loads(parts[0])
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

log "Начат drain слота ${SLOT} (:${PORT}, epoch=${EXPECTED_EPOCH}, grace=${GRACE_SEC}s, replayGrace=${REPLAY_GRACE_SEC}s, max=${MAX_WAIT_SEC}s)"
elapsed=0
retained_waited=0
confirmed_ready_to_stop=0

while (( elapsed < MAX_WAIT_SEC )); do
    if ! state_matches; then
        log "Состояние изменилось (слот активирован заново или новая эпоха) — отменяю остановку ${SLOT}."
        exit 0
    fi

    read -r st active_total retained_cnt draining_flag sbx_flag < <(query_drain_status)

    if [[ "$st" == "stopped" ]]; then
        log "Служба ${SLOT_SERVICE} уже остановлена."
        confirmed_ready_to_stop=1
        break
    fi

    # #8: If slot restarted via systemd Restart=always or initial POST /drain failed, re-assert drain BEFORE checking 0!
    if [[ ( "$st" == "idle" || "$st" == "busy" ) && ( "$draining_flag" != "true" || "$sbx_flag" == "true" ) ]]; then
        log "У дренируемого слота ${SLOT} draining=${draining_flag}, sandboxWorkerRunning=${sbx_flag} — повторно вызываю POST /drain..."
        send_drain_command || true
        sleep 2
        elapsed=$((elapsed + 2))
        continue
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

        read -r st_after active_after retained_after drain_after sbx_after < <(query_drain_status)
        if [[ "$st_after" == "stopped" ]]; then
            confirmed_ready_to_stop=1
            break
        fi
        if [[ "$st_after" == "idle" && "$drain_after" == "true" && "$sbx_after" == "false" ]] && (( retained_after == 0 || retained_waited >= REPLAY_GRACE_SEC )); then
            confirmed_ready_to_stop=1
            break
        fi
        log "После паузы слот ещё не готов к остановке (state=${st_after}, activeTotal=${active_after}, retained=${retained_after}, draining=${drain_after}, sbx=${sbx_after}) — продолжаю ожидание."
        continue
    fi

    # busy or unknown — reset retained replay counter and keep waiting
    retained_waited=0
    sleep 3
    elapsed=$((elapsed + 3))
done

if [[ "$confirmed_ready_to_stop" != "1" ]]; then
    read -r st_final active_final retained_final drain_final sbx_final < <(query_drain_status)
    if [[ "$st_final" == "stopped" || ( "$st_final" == "idle" && "$drain_final" == "true" && "$sbx_final" == "false" && "$retained_final" -eq 0 ) ]]; then
        confirmed_ready_to_stop=1
    else
        crit "Достигнут потолок ожидания ${MAX_WAIT_SEC}s для ${SLOT}, но слот НЕ подтвердил завершение (state=${st_final}, activeTotal=${active_final}, retained=${retained_final}, draining=${drain_final}) — оставляю ${SLOT_SERVICE} ЖИВЫМ!"
        exit 1
    fi
fi

# Hold shared STATE_LOCK_FILE across final epoch verification, state update, and verified systemctl stop
mkdir -p "$(dirname "$STATE_LOCK_FILE")" 2>/dev/null || STATE_LOCK_FILE="/tmp/lobechat-engine-state.lock"
exec 6>>"$STATE_LOCK_FILE"
flock -w 15 6

if ! state_matches; then
    log "Состояние изменилось перед захватом замка завершения — отменяю остановку ${SLOT}."
    flock -u 6 || true
    exit 0
fi

read -r locked_st locked_active _locked_ret locked_drain locked_sbx < <(query_drain_status)
if [[ "$locked_st" != "stopped" ]] && [[ "$locked_st" != "idle" || "$locked_drain" != "true" || "$locked_sbx" != "false" ]]; then
    log "Перед остановкой обнаружена активность/неизвестность (state=${locked_st}, active=${locked_active}, draining=${locked_drain}, sbx=${locked_sbx}) — оставляю ${SLOT_SERVICE} живым."
    flock -u 6 || true
    exit 1
fi

systemctl disable "$SLOT_SERVICE" 2>/dev/null || true
log "Останавливаю доработавший слот ${SLOT_SERVICE}..."
if [[ "$locked_st" != "stopped" ]]; then
    if ! systemctl stop "$SLOT_SERVICE"; then
        crit "systemctl stop ${SLOT_SERVICE} завершился с ошибкой — сохраняю drainingSlot в state.json!"
        flock -u 6 || true
        exit 1
    fi
    stop_confirmed=0
    for _i in $(seq 1 60); do
        if [[ "$(get_unit_state)" == "stopped" ]]; then
            stop_confirmed=1
            break
        fi
        sleep 0.5
    done
    if [[ "$stop_confirmed" != "1" ]]; then
        crit "Служба ${SLOT_SERVICE} не перешла в ActiveState=inactive — сохраняю drainingSlot в state.json!"
        flock -u 6 || true
        exit 1
    fi
fi

# #7: If this drainer was finishing a rejected candidate with a preserved .rollback-bak, restore it now!
if [[ -n "$RESTORE_BACKUP_DIR" && -d "$RESTORE_BACKUP_DIR" && -n "$TARGET_SLOT_DIR" ]]; then
    rm -rf -- "$TARGET_SLOT_DIR"
    mv -Tf "$RESTORE_BACKUP_DIR" "$TARGET_SLOT_DIR"
    log "Восстановлен подтверждённый резервный слот ${TARGET_SLOT_DIR} из ${RESTORE_BACKUP_DIR}."
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
    log "Состояние изменилось при очистке drainingSlot — завершаю."
    flock -u 6 || true
    exit 0
fi

mv -Tf "$tmp" "$STATE_FILE"
systemctl reload "$ROUTER_SERVICE" 2>/dev/null || systemctl kill -s HUP "$ROUTER_SERVICE" 2>/dev/null || true
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
    local restore_bak_dir="${5:-}" target_slot_dir="${6:-}"
    local draining_svc
    draining_svc=$(slot_service "$draining_slot")

    if slot_api_call POST "$draining_port" "drain" "$env_path" >/dev/null 2>&1; then
        log "Слот $draining_slot (:$draining_port) переведён в режим drain"
    else
        warn "Не удалось вызвать /arckep/engine-slot/drain на :$draining_port (slot-drainer повторит попытку при проверке)"
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
            "$DRAIN_GRACE_SEC" "$DRAIN_MAX_WAIT_SEC" "$REPLAY_GRACE_SEC" "$STATE_LOCK_FILE" "$drain_token" \
            "$restore_bak_dir" "$target_slot_dir"; then
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
            "$restore_bak_dir" "$target_slot_dir" \
            >>"$LOG_FILE" 2>&1 </dev/null &
        printf '%s:%s\n' "$!" "$drain_token" > "$STATE_DIR/drain-${draining_slot}.pid"
    )
    local drain_entry
    drain_entry=$(cat "$STATE_DIR/drain-${draining_slot}.pid" 2>/dev/null || echo "?")
    log "Запущен фоновый доводчик nohup (${drain_entry%%:*})"
}

install_router_files() {
    mkdir -p "$ROUTER_DIR"
    if [[ "$(id -u)" -eq 0 ]]; then
        chown root:root "$ROUTER_DIR"
    fi
    chmod 0755 "$ROUTER_DIR"

    ROUTER_CORE_PREV_BACKUP=""
    if [[ ! -f "$ROUTER_DIR/engine-router.mjs" ]] || ! cmp -s "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs"; then
        cp -pf "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        if [[ "$(id -u)" -eq 0 ]]; then
            chown root:root "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        fi
        chmod 0755 "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        mv -Tf "$ROUTER_DIR/engine-router.mjs.tmp.$$" "$ROUTER_DIR/engine-router.mjs"
        log "Обновлён $ROUTER_DIR/engine-router.mjs"
    fi

    if [[ ! -f "$ROUTER_DIR/engine-router-core.mjs" ]] || ! cmp -s "$SRC/scripts/engine-router-core.mjs" "$ROUTER_DIR/engine-router-core.mjs"; then
        if [[ -f "$ROUTER_DIR/engine-router-core.mjs" ]]; then
            ROUTER_CORE_PREV_BACKUP="$ROUTER_DIR/.engine-router-core.mjs.prev.$$"
            cp -pf "$ROUTER_DIR/engine-router-core.mjs" "$ROUTER_CORE_PREV_BACKUP"
        fi
        cp -pf "$SRC/scripts/engine-router-core.mjs" "$ROUTER_DIR/engine-router-core.mjs.tmp.$$"
        if [[ "$(id -u)" -eq 0 ]]; then
            chown root:root "$ROUTER_DIR/engine-router-core.mjs.tmp.$$"
        fi
        chmod 0644 "$ROUTER_DIR/engine-router-core.mjs.tmp.$$"
        mv -Tf "$ROUTER_DIR/engine-router-core.mjs.tmp.$$" "$ROUTER_DIR/engine-router-core.mjs"
        log "Обновлён $ROUTER_DIR/engine-router-core.mjs"
    fi
}

install_systemd_units() {
    local mode="${1:-if-changed}"
    local reload_needed=0
    mkdir -p "$SYSTEMD_DIR"
    for unit_name in \
        image-studio-lobechat-router.socket \
        image-studio-lobechat-router.service \
        image-studio-lobechat@.service; do
        local src_unit="$SRC/deploy/systemd/$unit_name"
        local dst_unit="$SYSTEMD_DIR/$unit_name"
        [[ -f "$src_unit" ]] || continue
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

install_router_and_units() {
    local mode="${1:-if-changed}"
    install_router_files
    install_systemd_units "$mode"
}

# v3 #2: Hot-reload router logic (`engine-router-core.mjs`) via `SIGHUP` ONLY (<2ms, ZERO `systemctl restart`!).
# `systemctl restart` on a socket-activated service with `TimeoutStopSec=1800` would block new socket
# accepts for up to 30 minutes while any SSE stream is open. Instead, `engine-router.mjs` dynamically
# imports the new `engine-router-core.mjs` on `SIGHUP`, preserving `routerRuntime` in-memory state
# and updating `routerHash` in `/__router/health` immediately.
ensure_router_code_current() {
    [[ -f "$ROUTER_DIR/engine-router.mjs" && -f "$ROUTER_DIR/engine-router-core.mjs" ]] || return 1
    if [[ "$(get_systemd_unit_state "$ROUTER_SERVICE")" != "active" ]]; then
        rm -f -- "${ROUTER_CORE_PREV_BACKUP:-}"
        ROUTER_CORE_PREV_BACKUP=""
        return 0
    fi

    local disk_hash r_health r_hash="" sent_hup=0 attempt
    disk_hash=$(sha256sum "$ROUTER_DIR/engine-router-core.mjs" | awk '{print $1}')

    for attempt in $(seq 1 25); do
        r_health=$(curl -sS --max-time 2 "http://127.0.0.1:${PORT}/__router/health" 2>/dev/null || echo "")
        if [[ -n "$r_health" ]]; then
            r_hash=$(python3 - "$r_health" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
    print(d.get("routerHash") or "unknown")
except Exception:
    print("unknown")
PY
)
            if [[ "$r_hash" == "$disk_hash" ]]; then
                if [[ "$sent_hup" == "1" ]]; then
                    log "Горячая перезагрузка обработчика роутера по SIGHUP подтверждена (routerHash=${disk_hash:0:12})"
                fi
                rm -f -- "${ROUTER_CORE_PREV_BACKUP:-}"
                ROUTER_CORE_PREV_BACKUP=""
                return 0
            fi
        fi

        if [[ "$sent_hup" == "0" ]]; then
            log "Отправляю SIGHUP роутеру $ROUTER_SERVICE для горячей перезагрузки engine-router-core.mjs (${r_hash:0:12} -> ${disk_hash:0:12})..."
            notify_router_reload
            sent_hup=1
        elif (( attempt % 5 == 0 )); then
            notify_router_reload
        fi
        sleep 0.2
    done

    err "CRITICAL: роутер на :$PORT не подтвердил обновление routerHash после SIGHUP (live=${r_hash:-none}, disk=${disk_hash})!"
    if [[ -n "${ROUTER_CORE_PREV_BACKUP:-}" && -f "$ROUTER_CORE_PREV_BACKUP" ]]; then
        mv -Tf "$ROUTER_CORE_PREV_BACKUP" "$ROUTER_DIR/engine-router-core.mjs"
        ROUTER_CORE_PREV_BACKUP=""
        notify_router_reload
        warn "Восстановлен предыдущий $ROUTER_DIR/engine-router-core.mjs на диске после отказа горячей перезагрузки."
    fi
    return 1
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
SLOT_NAME=${slot_name}
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

# P1 #7 + #4: Fail-closed quietness check on legacy :$PORT before one-time --init cutover.
# Verifies TCP sockets, `/engine-slot/status` (if present), Redis `agent_runtime_step_lock:*`,
# AND Postgres `messages` (`role='assistant' AND content='...' AND error IS NULL` in last 35m).
check_legacy_sockets_quiet() {
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

check_legacy_port_quiet() {
    local env_path="$1"

    local leg_unit_st
    leg_unit_st=$(get_systemd_unit_state "$LEGACY_SERVICE")
    if [[ "$leg_unit_st" == "unknown" ]]; then
        err "Не удалось проверить состояние старой службы '$LEGACY_SERVICE' через systemd (fail-closed). Дождись восстановления или передай '--init --force'."
        return 1
    fi
    if [[ "$leg_unit_st" == "stopped" ]]; then
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

    # 2. Fast pre-check of established TCP sockets before spawning Node.js
    if ! check_legacy_sockets_quiet; then
        return 1
    fi

    # 3. #4: Background generation check in Redis (`agent_runtime_step_lock:*`) & Postgres (`messages`)
    # Reads $env_path inside Node WITHOUT printing any secrets/URLs to stdout or stderr!
    local bg_out bg_rc=0
    bg_out=$(
        ENV_FILE_PATH="$env_path" NODE_PATH="$SRC/node_modules" "$NODE_BIN" -e '
const fs = require("node:fs");
(async () => {
  const envMap = {};
  const raw = fs.readFileSync(process.env.ENV_FILE_PATH, "utf8");
  for (const lineRaw of raw.split(/\r?\n/)) {
    let line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "\"" || v[0] === "\x27")) {
      v = v.slice(1, -1);
    }
    envMap[k] = v;
  }

  const dbUrl = envMap.DATABASE_URL || "";
  if (!dbUrl) {
    process.stdout.write("ERR:missing_database_url");
    process.exit(1);
  }

  const redisUrl = envMap.REDIS_URL || "";
  const redisDisabled = envMap.REDIS_DISABLED === "1" || envMap.REDIS_DISABLED === "true";
  if (redisUrl && !redisDisabled) {
    const Redis = require("ioredis");
    const redis = new Redis(redisUrl, {
      connectTimeout: 3000,
      commandTimeout: 3000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    redis.on("error", () => {});
    try {
      await redis.connect();
      const patterns = ["agent_runtime_step_lock:*"];
      if (envMap.REDIS_PREFIX) {
        patterns.push(`${envMap.REDIS_PREFIX}*agent_runtime_step_lock:*`);
      }
      let lockCount = 0;
      for (const pat of patterns) {
        let cursor = "0";
        do {
          const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pat, "COUNT", 200);
          cursor = String(nextCursor);
          if (Array.isArray(keys)) lockCount += keys.length;
        } while (cursor !== "0" && lockCount === 0);
        if (lockCount > 0) break;
      }
      await redis.quit().catch(() => redis.disconnect());
      if (lockCount > 0) {
        process.stdout.write(`BUSY_REDIS:${lockCount}`);
        process.exit(2);
      }
    } catch {
      redis.disconnect();
      process.stdout.write("ERR:redis_check_failed");
      process.exit(1);
    }
  }

  const { Client } = require("pg");
  const pgClient = new Client({
    connectionString: dbUrl,
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
  });
  try {
    await pgClient.connect();
    const res = await pgClient.query(
      "SELECT COUNT(*)::int AS cnt FROM messages WHERE role = \x27assistant\x27 AND content = \x27...\x27 AND error IS NULL AND created_at > now() - interval \x2735 minutes\x27"
    );
    const cnt = Number(res.rows?.[0]?.cnt ?? 0);
    await pgClient.end().catch(() => {});
    if (cnt > 0) {
      process.stdout.write(`BUSY_PG:${cnt}`);
      process.exit(2);
    }
  } catch {
    await pgClient.end().catch(() => {});
    process.stdout.write("ERR:pg_check_failed");
    process.exit(1);
  }

  process.stdout.write("QUIET");
  process.exit(0);
})().catch(() => {
  process.stdout.write("ERR:unexpected");
  process.exit(1);
});
' 2>/dev/null
    ) || bg_rc=$?

    if [[ $bg_rc -ne 0 || "$bg_out" != "QUIET" ]]; then
        if [[ "$bg_out" == BUSY_REDIS:* ]]; then
            err "В Redis обнаружены активные фоновые шаги агентов (${bg_out#BUSY_REDIS:} шт. agent_runtime_step_lock:*). Дождись завершения или передай '--init --force'."
        elif [[ "$bg_out" == BUSY_PG:* ]]; then
            err "В БД lobechat.messages обнаружены незавершённые ответы ассистента за последние 35 мин (${bg_out#BUSY_PG:} шт. content='...'). Дождись завершения или передай '--init --force'."
        else
            err "Не удалось подтвердить отсутствие фоновых генераций старого движка (${bg_out:-node_failed}, fail-closed). Дождись завершения или передай '--init --force'."
        fi
        return 1
    fi

    # 4. Final sub-millisecond TCP socket re-check AFTER Redis/PG check so a connection
    # opened while Node.js queried Redis/Postgres cannot slip into `systemctl stop $LEGACY_SERVICE`.
    if ! check_legacy_sockets_quiet; then
        return 1
    fi

    return 0
}

check_legacy_engine_quiet() {
    check_legacy_port_quiet "$@"
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
    if [[ -f "$ROUTER_DIR/engine-router.mjs" && -f "$ROUTER_DIR/engine-router-core.mjs" ]]; then
        disk_router_hash=$(sha256sum "$ROUTER_DIR/engine-router-core.mjs" | awk '{print $1}')
    fi

    printf "  Router (127.0.0.1:%s): " "$PORT"
    local router_unit_st
    router_unit_st=$(get_systemd_unit_state "$ROUTER_SERVICE")
    if [[ "$router_unit_st" == "active" ]]; then
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
if st != "ok" or r_slot != expected_slot or not key_ok or r_hash != disk_hash:
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
    elif [[ "$router_unit_st" == "unknown" ]]; then
        echo "UNKNOWN (systemd/D-Bus query error)"
        status_rc=1
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

    local legacy_unit_st
    legacy_unit_st=$(get_systemd_unit_state "$LEGACY_SERVICE")
    if [[ "$legacy_unit_st" == "active" ]]; then
        echo "  WARNING: Legacy ($LEGACY_SERVICE): RUNNING alongside Blue-Green!"
        status_rc=1
    elif [[ "$legacy_unit_st" == "unknown" ]]; then
        echo "  WARNING: Legacy ($LEGACY_SERVICE): UNKNOWN systemd state!"
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
        local c_port c_dir c_svc c_commit="none" slot_status_env="$env_path"
        c_port=$(slot_port "$color")
        c_dir=$(slot_dir "$color")
        c_svc=$(slot_service "$color")
        [[ -f "$c_dir/.deployed-commit" ]] && c_commit=$(head -c 12 "$c_dir/.deployed-commit" 2>/dev/null || echo "unknown")
        [[ -f "$c_dir/.env" ]] && slot_status_env="$c_dir/.env"

        printf "  %-6s (port %s, commit %-12s): " "$color" "$c_port" "$c_commit"
        local st_kind st_active st_retained st_draining st_sbx
        read -r st_kind st_active st_retained st_draining st_sbx < <(query_slot_drain_state "$color" "$c_port" "$slot_status_env")
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
    sync_slot_router_service_key_file "$prev_dir/.env" "$prev"
    sync

    local started_prev_here=0
    if [[ "$(get_systemd_unit_state "$prev_svc")" == "stopped" ]]; then
        log "Поднимаю предыдущий подтверждённый слот $prev_svc (:$prev_port)..."
        systemctl start "$prev_svc"
        started_prev_here=1
    fi

    if ! check_port_health "$prev_port" "" 20; then
        err "Предыдущий слот $prev (:$prev_port) не прошёл проверку здоровья — оставляю $current активным!"
        if [[ "$started_prev_here" == "1" ]]; then
            stop_slot_service_verified "$prev_svc" || true
        fi
        exit 1
    fi

    # Resume SandboxJobWorker and clear draining flag BEFORE switching traffic!
    if ! slot_api_call POST "$prev_port" "undrain" "$prev_dir/.env" >/dev/null; then
        err "Не удалось выполнить /arckep/engine-slot/undrain на $prev (:$prev_port) — откат отменён!"
        if [[ "$started_prev_here" == "1" ]]; then
            stop_slot_service_verified "$prev_svc" || true
        fi
        exit 1
    fi

    local prev_st prev_active prev_ret prev_draining prev_sbx
    read -r prev_st prev_active prev_ret prev_draining prev_sbx < <(query_slot_drain_state "$prev" "$prev_port" "$prev_dir/.env")
    if [[ ( "$prev_st" != "idle" && "$prev_st" != "busy" ) || "$prev_draining" != "false" ]]; then
        err "Проверка /arckep/engine-slot/status на $prev (:$prev_port) не подтвердила готовность после undrain (state=$prev_st, draining=$prev_draining) — откат отменён!"
        if [[ "$started_prev_here" == "1" ]]; then
            stop_slot_service_verified "$prev_svc" || true
        fi
        exit 1
    fi

    log "Мгновенный откат роутера: $current (:$current_port) -> $prev (:$prev_port)..."
    systemctl enable "$prev_svc" 2>/dev/null || true
    begin_switch "$current" "$prev"
    atomic_symlink "$prev_dir" "$PROD"
    sync_router_service_key_file "$prev_dir/.env" "$prev"
    write_state_json "$prev" "$prev_port" "$current" "$current_port" "$next_epoch"
    notify_router_reload

    if ! check_port_health "$PORT" "$prev" 10; then
        err "CRITICAL: проверка :$PORT после отката на $prev не прошла — возвращаю маршрут на $current!"
        slot_api_call POST "$current_port" "undrain" "$current_dir/.env" >/dev/null 2>&1 || true
        atomic_symlink "$current_dir" "$PROD"
        sync_router_service_key_file "$current_dir/.env" "$current"
        write_state_json "$current" "$current_port" "$prev" "$prev_port" "$((next_epoch + 1))"
        notify_router_reload
        if check_port_health "$PORT" "$current" 10; then
            systemctl enable "$current_svc" 2>/dev/null || true
            systemctl disable "$prev_svc" 2>/dev/null || true
            clear_switch_guard
            start_slot_drain "$prev" "$prev_port" "$((next_epoch + 1))" "$prev_dir/.env"
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
    # #11: Always pass draining slot's OWN .env ($current_dir/.env) when draining $current!
    start_slot_drain "$current" "$current_port" "$next_epoch" "$current_dir/.env"
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
        { git status --porcelain || true; } | head >&2
        exit 1
    fi

    HEAD_COMMIT=$(git rev-parse HEAD)
    LOCK_HASH=$({ cat pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc packages/*/package.json 2>/dev/null || true; } | sha256sum | cut -d' ' -f1)
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
    expected_next_ver=$("$NODE_BIN" -p "require('$SRC/node_modules/next/package.json').version") || {
        err "Не удалось прочитать версию next из $SRC/node_modules/next/package.json"
        exit 1
    }
    STAGED_NEXT_VER=$("$NODE_BIN" -p "require('$stage_dir/node_modules/next/package.json').version") || {
        err "Не удалось прочитать версию next из $stage_dir/node_modules/next/package.json"
        exit 1
    }
    if [[ "$expected_next_ver" != "$STAGED_NEXT_VER" ]]; then
        err "staged next version ($STAGED_NEXT_VER) != source next version ($expected_next_ver)"
        exit 1
    fi

    # Ensure no symlinks point outside $stage_dir (systemd PrivateTmp=true / ProtectHome=true)
    python3 - "$stage_dir" <<'PY' || exit 1
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
        "$NODE_BIN" -e "
          const nextVer = require('./node_modules/next/package.json').version;
          require('sharp');
          require('@napi-rs/canvas');
          console.log('[engine] pre-flight OK: next@' + nextVer + ', sharp=ok, @napi-rs/canvas=ok');
        "
    ) || {
        err "Проверка нативных модулей (sharp / @napi-rs/canvas) в $stage_dir завершилась ошибкой!"
        exit 1
    }

    if [[ "$is_stage_only" == "1" ]]; then
        printf 'created=%s commit=%s\n' "$(date -Iseconds)" "$HEAD_COMMIT" > "$stage_dir/.stage-only-marker"
    fi
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
# NOTE (--init, v3 #1): Как и однократный `backend-init` у основного API студии, самый первый
# перенос уже занятого порта :$PORT со старой одиночной службы ($LEGACY_SERVICE) на постоянный
# systemd-сокет ($ROUTER_SOCKET + $ROUTER_SERVICE) выполняется ровно один раз в тихую минуту.
# Все подготовительные операции (установка файлов роутера и unit-файлов, `systemctl enable`,
# прогрев `blue` на :$BLUE_PORT, `/undrain`, подготовка `state.json.init-ready` и симлинка)
# выполняются ДО финальной двойной проверки тишины (`check_legacy_engine_quiet` -> 0.3s -> повтор),
# после которой буквально следующей строкой идут `systemctl stop "$LEGACY_SERVICE"`, `mv -Tf` state
# и `systemctl start "$ROUTER_SOCKET" "$ROUTER_SERVICE"`. Для полного ограждения микроокна на
# уровне внешнего прокси при желании можно передать `ENGINE_INIT_PRE_STOP_HOOK`.
cleanup_init_stage() {
    release_build_lock
    rm -rf -- "${STAGE_DIR:-}"
    rm -f -- "${INIT_READY_STATE:-}" "${INIT_TMP_SYMLINK:-}" "${ROUTER_CORE_PREV_BACKUP:-}"
    if [[ "${INIT_CUTOVER_COMMITTED:-0}" != "1" ]]; then
        systemctl disable "$ROUTER_SOCKET" "$ROUTER_SERVICE" 2>/dev/null || true
        if [[ -n "${INIT_BLUE_SVC:-}" ]]; then
            systemctl stop "$INIT_BLUE_SVC" 2>/dev/null || true
            systemctl disable "$INIT_BLUE_SVC" 2>/dev/null || true
        fi
        if [[ "${INIT_HAD_BLUE_DIR:-0}" == "0" && "${INIT_ENV_DIR:-}" != "$SLOT_BLUE_DIR" ]]; then
            rm -rf -- "$SLOT_BLUE_DIR"
        fi
    fi
}

cmd_init() {
    local force_flag="${1:-}"
    acquire_deploy_lock "init"
    check_switch_allowed

    # Align strictly with Studio deploy.sh: refuse whenever STATE_FILE exists unless --init --force recovery
    if [[ -f "$STATE_FILE" ]]; then
        if [[ "$(get_systemd_unit_state "$ROUTER_SERVICE")" == "active" && -L "$PROD" ]]; then
            err "Blue-Green уже инициализирован ($STATE_FILE существует, $ROUTER_SERVICE запущен). Используй обычный 'bash deploy-engine.sh'."
            exit 1
        fi
        if [[ "$force_flag" != "--force" ]]; then
            err "Обнаружен существующий $STATE_FILE при остановленном $ROUTER_SERVICE. Проверь '--status' или передай '--init --force' для восстановления."
            exit 1
        fi
        warn "Восстановление прерванной инициализации (--init --force)..."
    fi

    INIT_ENV_DIR="$PROD"
    if [[ ! -f "$INIT_ENV_DIR/.env" && -f "$SLOT_BLUE_DIR/.env" && "$force_flag" == "--force" ]]; then
        INIT_ENV_DIR="$SLOT_BLUE_DIR"
    fi
    if [[ ! -f "$INIT_ENV_DIR/.env" ]]; then
        err "$PROD/.env не найден — инициализация невозможна."
        exit 1
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_engine_quiet "$INIT_ENV_DIR/.env"
    fi

    local green_svc
    INIT_BLUE_SVC=$(slot_service "blue")
    green_svc=$(slot_service "green")
    INIT_HAD_BLUE_DIR=0
    [[ -d "$SLOT_BLUE_DIR" ]] && INIT_HAD_BLUE_DIR=1
    INIT_CUTOVER_COMMITTED=0
    INIT_READY_STATE=""
    INIT_TMP_SYMLINK=""

    STAGE_DIR="$(dirname "$SLOT_BLUE_DIR")/.lobechat-engine.stage.$$"
    trap cleanup_init_stage EXIT

    # #3: Acquire build lock directly in current shell so `set -euo pipefail` stays 100% active!
    acquire_build_lock
    build_into_stage_dir_locked "$STAGE_DIR" "0" "$INIT_ENV_DIR"

    install_router_files
    install_systemd_units "force-reload"
    rm -f -- "${ROUTER_CORE_PREV_BACKUP:-}"
    ROUTER_CORE_PREV_BACKUP=""
    sync_router_service_key_file "$INIT_ENV_DIR/.env" "blue"

    stop_background_drainer "blue"
    stop_slot_service_verified "$INIT_BLUE_SVC"
    systemctl disable "$green_svc" 2>/dev/null || true

    populate_slot_from_stage "$STAGE_DIR" "$SLOT_BLUE_DIR" "blue" "$BLUE_PORT" "$INIT_ENV_DIR"
    rm -rf -- "${STAGE_DIR:-}"
    STAGE_DIR=""
    release_build_lock

    log "Запускаю слот $INIT_BLUE_SVC на 127.0.0.1:$BLUE_PORT (в безопасном режиме drain до переключения)..."
    systemctl start "$INIT_BLUE_SVC"

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

    # v3 #1: Complete ALL slow preparation BEFORE the final double quietness check!
    if ! slot_api_call POST "$BLUE_PORT" "undrain" "$SLOT_BLUE_DIR/.env" >/dev/null; then
        err "Не удалось активировать воркеры (/undrain) на blue (:$BLUE_PORT) — старый $LEGACY_SERVICE не затронут!"
        exit 1
    fi

    local legacy_backup="${PROD}.legacy-pre-bg"
    if [[ -e "$legacy_backup" ]]; then
        legacy_backup="${PROD}.legacy-pre-bg.$(date +%s)"
    fi

    INIT_READY_STATE="${STATE_FILE}.init-ready"
    rm -f -- "$INIT_READY_STATE"
    if ! build_state_json_file "$INIT_READY_STATE" "blue" "$BLUE_PORT" "" "" 1 "$HEAD_COMMIT" "null" "null"; then
        err "Не удалось подготовить $INIT_READY_STATE — старый $LEGACY_SERVICE не затронут!"
        exit 1
    fi

    INIT_TMP_SYMLINK="${PROD}.symlink.$$"
    rm -f -- "$INIT_TMP_SYMLINK"
    ln -sfn "$SLOT_BLUE_DIR" "$INIT_TMP_SYMLINK"
    # If recovering via --init --force when $PROD was missing, restore symlink now so EnvironmentFile=$PROD/.env exists
    if [[ ! -e "$PROD" && ! -L "$PROD" ]]; then
        mv -Tf "$INIT_TMP_SYMLINK" "$PROD"
        ln -sfn "$SLOT_BLUE_DIR" "$INIT_TMP_SYMLINK"
    fi

    systemctl enable "$INIT_BLUE_SVC" 2>/dev/null || true
    systemctl enable "$ROUTER_SOCKET" "$ROUTER_SERVICE" 2>/dev/null || true

    log "Готов к переключению со старой службы $LEGACY_SERVICE на blue (:$BLUE_PORT) + роутер (:$PORT)..."
    if [[ -n "${ENGINE_INIT_PRE_STOP_HOOK:-}" ]]; then
        log "Выполняю ENGINE_INIT_PRE_STOP_HOOK перед финальной проверкой тишины..."
        /bin/bash -c "$ENGINE_INIT_PRE_STOP_HOOK"
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_engine_quiet "$SLOT_BLUE_DIR/.env"
        sleep 0.3
        check_legacy_engine_quiet "$SLOT_BLUE_DIR/.env"
    fi
    systemctl stop "$LEGACY_SERVICE" 2>/dev/null || true
    mv -Tf "$INIT_READY_STATE" "$STATE_FILE"
    local router_start_ok=1
    systemctl start "$ROUTER_SOCKET" "$ROUTER_SERVICE" || router_start_ok=0
    INIT_READY_STATE=""

    if [[ -L "$PROD" ]]; then
        mv -Tf "$INIT_TMP_SYMLINK" "$PROD"
    elif [[ -d "$PROD" ]]; then
        mv "$PROD" "$legacy_backup"
        mv -Tf "$INIT_TMP_SYMLINK" "$PROD"
    else
        mv -Tf "$INIT_TMP_SYMLINK" "$PROD"
    fi
    INIT_TMP_SYMLINK=""
    systemctl disable "$LEGACY_SERVICE" 2>/dev/null || true

    if [[ "$router_start_ok" != "1" ]] || ! check_port_health "$PORT" "blue" 15 || ! ensure_router_code_current; then
        err "CRITICAL: роутер на :$PORT не прошёл проверку здоровья — откатываю к старой службе $LEGACY_SERVICE!"
        slot_api_call POST "$BLUE_PORT" "drain" "$SLOT_BLUE_DIR/.env" >/dev/null 2>&1 || true
        systemctl stop "$ROUTER_SERVICE" 2>/dev/null || true
        systemctl disable "$ROUTER_SERVICE" 2>/dev/null || true
        systemctl stop "$ROUTER_SOCKET" 2>/dev/null || true
        systemctl disable "$ROUTER_SOCKET" 2>/dev/null || true
        stop_slot_service_verified "$INIT_BLUE_SVC" || true
        systemctl disable "$INIT_BLUE_SVC" 2>/dev/null || true
        rm -f "$PROD" "$STATE_FILE"
        if [[ -d "$legacy_backup" ]]; then
            mv "$legacy_backup" "$PROD"
        fi
        systemctl enable --now "$LEGACY_SERVICE" || true
        check_port_health "$PORT" "" 15 || true
        reload_auditd_watches
        exit 1
    fi

    INIT_CUTOVER_COMMITTED=1
    trap - EXIT
    reload_auditd_watches
    log "INIT OK: роутер слушает :$PORT, активен слот blue (:$BLUE_PORT, commit $HEAD_COMMIT); старый каталог сохранён в $legacy_backup"
}

# =============================================================================
# BLUE-GREEN DEPLOY (default & --install)
# =============================================================================
# #1 + #7: Restore previous confirmed `.rollback-bak` ONLY AFTER verified service stop!
# NEVER deletes `.rollback-bak`; deletes `$DEPLOY_TARGET_DIR` ONLY when `.rollback-bak` did not exist.
restore_target_slot_backup() {
    systemctl disable "$DEPLOY_TARGET_SVC" 2>/dev/null || true
    if ! stop_slot_service_verified "$DEPLOY_TARGET_SVC"; then
        err "CRITICAL: не удалось подтвердить остановку $DEPLOY_TARGET_SVC — сохраняю $BACKUP_TARGET_DIR и не трогаю работающий каталог!"
        return 1
    fi
    if [[ -n "${BACKUP_TARGET_DIR:-}" && -d "$BACKUP_TARGET_DIR" ]]; then
        rm -rf -- "$DEPLOY_TARGET_DIR"
        mv -Tf "$BACKUP_TARGET_DIR" "$DEPLOY_TARGET_DIR"
        BACKUP_TARGET_DIR=""
        log "Восстановлен предыдущий резервный слот $DEPLOY_TARGET_SLOT ($DEPLOY_TARGET_DIR)."
    elif [[ "${HAD_PREVIOUS_TARGET_DIR:-0}" == "0" && "${CANDIDATE_INSTALLED:-0}" == "1" ]]; then
        rm -rf -- "$DEPLOY_TARGET_DIR"
        log "Удалён каталог неподтверждённого кандидата $DEPLOY_TARGET_SLOT ($DEPLOY_TARGET_DIR)."
    fi
}

cleanup_deploy_stage() {
    release_build_lock
    rm -rf -- "${STAGE_DIR:-}"
    rm -f -- "${ROUTER_CORE_PREV_BACKUP:-}"
    # #7: NEVER delete $BACKUP_TARGET_DIR inside EXIT trap! Only restore it if target slot dir is incomplete.
    if [[ -n "${BACKUP_TARGET_DIR:-}" && -d "$BACKUP_TARGET_DIR" && -n "${DEPLOY_TARGET_DIR:-}" ]]; then
        if [[ ! -f "$DEPLOY_TARGET_DIR/server.js" ]]; then
            rm -rf -- "$DEPLOY_TARGET_DIR"
            mv -Tf "$BACKUP_TARGET_DIR" "$DEPLOY_TARGET_DIR" 2>/dev/null || true
        fi
    fi
}

cmd_deploy() {
    acquire_deploy_lock "$MODE"
    check_switch_allowed

    if [[ ! -f "$STATE_FILE" ]]; then
        err "Состояние $STATE_FILE не найдено (Blue-Green ещё не инициализирован)."
        err "Выполни однократный переход: bash deploy-engine.sh --init"
        exit 1
    fi

    local active target active_port target_port active_dir target_dir active_svc target_svc epoch next_epoch
    local active_commit orig_prev_slot orig_prev_commit target_check_env
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

    DEPLOY_TARGET_SLOT="$target"
    DEPLOY_TARGET_DIR="$target_dir"
    DEPLOY_TARGET_SVC="$target_svc"

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
    trap cleanup_deploy_stage EXIT

    # #3: Acquire build lock directly in current shell so `set -euo pipefail` stays 100% active!
    acquire_build_lock
    build_into_stage_dir_locked "$STAGE_DIR" "0" "$active_dir"
    prepare_staged_slot_metadata "$STAGE_DIR" "$target" "$target_port" "$active_dir"
    release_build_lock

    # #1 + #6 + #11: Query target slot with its OWN .env (if present), wait for BOTH activeTotal===0
    # AND retainedTopicIds.length===0 (up to 610s), then verify ActiveState=inactive before touching files!
    target_check_env="$active_dir/.env"
    [[ -f "$target_dir/.env" ]] && target_check_env="$target_dir/.env"
    wait_slot_idle_before_overwrite "$target" "$target_port" "$target_check_env"
    stop_background_drainer "$target"
    log "Останавливаю неактивный слот $target_svc перед обновлением файлов..."
    stop_slot_service_verified "$target_svc"
    systemctl disable "$target_svc" 2>/dev/null || true

    install_router_and_units "if-changed"
    sync_slot_router_service_key_file "$STAGE_DIR/.env" "$target"
    [[ -f "$ROUTER_DIR/.service-key-${active}.env" ]] || sync_slot_router_service_key_file "$active_dir/.env" "$active" || true

    mkdir -p "$(dirname "$target_dir")"
    if [[ -d "$target_dir" ]]; then
        HAD_PREVIOUS_TARGET_DIR=1
        BACKUP_TARGET_DIR="${target_dir}.rollback-bak"
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

    # #8: Candidate starts with SLOT_NAME=$target while state.json activeSlot=$active -> boots paused in drain=true!
    log "Запускаю свежий слот $target_svc (:$target_port, стартует на паузе в режиме drain)..."
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

    local cand_st _ca _cr _cd _csbx
    read -r cand_st _ca _cr _cd _csbx < <(query_slot_drain_state "$target" "$target_port" "$target_dir/.env")
    if [[ "$cand_st" != "idle" && "$cand_st" != "busy" ]]; then
        err "Служебная ручка /arckep/engine-slot/status на :$target_port не прошла проверку (state=$cand_st) — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    if [[ "$(get_systemd_unit_state "$ROUTER_SERVICE")" != "active" ]]; then
        log "Роутер $ROUTER_SERVICE не активен — запускаю сокет и службу..."
        systemctl enable --now "$ROUTER_SOCKET" 2>/dev/null || true
        systemctl enable --now "$ROUTER_SERVICE"
    fi
    if ! ensure_router_code_current; then
        err "Не удалось применить обновлённый код роутера по SIGHUP — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    # Enable target slot for boot right before switching; keep previousConfirmedSlot unchanged until :$PORT passes!
    systemctl enable "$target_svc" 2>/dev/null || true
    log "Переключаю роутер :$PORT на $target (:$target_port), старый $active (:$active_port) уходит в drain..."
    begin_switch "$active" "$target"
    atomic_symlink "$target_dir" "$PROD"
    sync_router_service_key_file "$target_dir/.env" "$target"
    write_state_json "$target" "$target_port" "$active" "$active_port" "$next_epoch"
    notify_router_reload

    # #8: Immediately activate SandboxJobWorker on $target via POST /undrain and verify :$PORT!
    local undrain_ok=1
    if ! slot_api_call POST "$target_port" "undrain" "$target_dir/.env" >/dev/null; then
        undrain_ok=0
    else
        local post_undrain_st _pua _pur post_undrain_draining _pus
        read -r post_undrain_st _pua _pur post_undrain_draining _pus < <(query_slot_drain_state "$target" "$target_port" "$target_dir/.env")
        if [[ ( "$post_undrain_st" != "idle" && "$post_undrain_st" != "busy" ) || "$post_undrain_draining" != "false" ]]; then
            undrain_ok=0
        fi
    fi

    if [[ "$undrain_ok" != "1" ]] || ! check_port_health "$PORT" "$target" 15; then
        # #6 + #7: Safe emergency revert — restore route to $active first, drain rejected $target
        # across both activeTotal===0 AND retainedTopicIds.length===0 (up to 610s), and ALWAYS
        # restore .rollback-bak back onto $target_dir so previousConfirmedCommit stays valid!
        err "CRITICAL: активация или проверка :$PORT после переключения на $target не прошла — возвращаю маршрут на $active!"
        local revert_epoch=$((next_epoch + 1))
        slot_api_call POST "$active_port" "undrain" "$active_dir/.env" >/dev/null 2>&1 || true
        atomic_symlink "$active_dir" "$PROD"
        sync_router_service_key_file "$active_dir/.env" "$active"
        write_state_json "$active" "$active_port" "$target" "$target_port" "$revert_epoch" \
            "$active_commit" "${orig_prev_slot:-null}" "${orig_prev_commit:-null}"
        notify_router_reload

        if ! check_port_health "$PORT" "$active" 10; then
            err "CRITICAL: возврат маршрута на $active также не прошёл проверку :$PORT! Оставляю оба слота ($active_svc и $target_svc), резерв $BACKUP_TARGET_DIR и сторож $SWITCH_GUARD живыми для ручной диагностики!"
            reload_auditd_watches
            exit 1
        fi

        systemctl enable "$active_svc" 2>/dev/null || true
        systemctl disable "$target_svc" 2>/dev/null || true
        clear_switch_guard

        slot_api_call POST "$target_port" "drain" "$target_dir/.env" >/dev/null 2>&1 || true
        local drain_wait=0 rev_ret_wait=0 rev_ready=0 rev_st="" rev_active=0 rev_ret=0 rev_drain="" rev_sbx=""
        while (( drain_wait < DRAIN_MAX_WAIT_SEC )); do
            read -r rev_st rev_active rev_ret rev_drain rev_sbx < <(query_slot_drain_state "$target" "$target_port" "$target_dir/.env")
            if [[ "$rev_st" == "stopped" ]]; then
                rev_ready=1
                break
            fi
            if [[ ( "$rev_st" == "idle" || "$rev_st" == "busy" ) && ( "$rev_drain" != "true" || "$rev_sbx" == "true" ) ]]; then
                slot_api_call POST "$target_port" "drain" "$target_dir/.env" >/dev/null 2>&1 || true
                sleep 2
                drain_wait=$((drain_wait + 2))
                continue
            fi
            if [[ "$rev_st" == "idle" ]]; then
                if (( rev_ret == 0 || rev_ret_wait >= REPLAY_GRACE_SEC )); then
                    rev_ready=1
                    break
                fi
                local r_step=3
                local r_rem=$((REPLAY_GRACE_SEC - rev_ret_wait))
                (( r_rem < r_step )) && r_step=$r_rem
                (( r_step < 1 )) && r_step=1
                sleep "$r_step"
                drain_wait=$((drain_wait + r_step))
                rev_ret_wait=$((rev_ret_wait + r_step))
                continue
            fi
            rev_ret_wait=0
            sleep 3
            drain_wait=$((drain_wait + 3))
        done

        if [[ "$rev_ready" == "1" ]]; then
            if restore_target_slot_backup; then
                write_state_json "$active" "$active_port" "" "" "$revert_epoch" \
                    "$active_commit" "${orig_prev_slot:-null}" "${orig_prev_commit:-null}"
                notify_router_reload
            fi
        else
            warn "Неудачный кандидат $target всё ещё занят после ожидания (state=$rev_st, activeTotal=$rev_active, retained=$rev_ret) — передаю фоновому drainer с сохранением $BACKUP_TARGET_DIR для автоматического восстановления после остановки!"
            start_slot_drain "$target" "$target_port" "$revert_epoch" "$target_dir/.env" "$BACKUP_TARGET_DIR" "$target_dir"
            BACKUP_TARGET_DIR=""
        fi
        trap - EXIT
        reload_auditd_watches
        exit 1
    fi

    # Switch confirmed! Persist previousConfirmedSlot/Commit and disable old slot autostart
    write_state_json "$target" "$target_port" "$active" "$active_port" "$next_epoch" \
        "$HEAD_COMMIT" "$active" "${active_commit:-null}"
    systemctl disable "$active_svc" 2>/dev/null || true
    clear_switch_guard

    if [[ -n "$BACKUP_TARGET_DIR" && -d "$BACKUP_TARGET_DIR" ]]; then
        rm -rf -- "$BACKUP_TARGET_DIR"
        BACKUP_TARGET_DIR=""
    fi

    # #11: Always pass old slot's OWN .env ($active_dir/.env) when draining $active!
    start_slot_drain "$active" "$active_port" "$next_epoch" "$active_dir/.env"
    trap - EXIT
    reload_auditd_watches

    log "OK: next@$STAGED_NEXT_VER, commit $HEAD_COMMIT активен на слоте $target (:$target_port); старый $active переведён в drain."
}

# =============================================================================
# DISPATCH
# =============================================================================
case "$MODE" in
    --stage-only)
        validate_stage_only_dir "$STAGE_TARGET"
        trap 'release_build_lock' EXIT
        acquire_build_lock
        build_into_stage_dir_locked "$STAGE_TARGET" "1" ""
        release_build_lock
        trap - EXIT
        log "stage-only complete at $STAGE_TARGET (live $PROD untouched)"
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
