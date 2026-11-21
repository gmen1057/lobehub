#!/usr/bin/env bash
# Бесшовная Blue-Green выкладка движка чата (LobeChat без интерфейса) за постоянным HTTP/SSE-роутером :3403.
#
# Архитектура:
#   * 127.0.0.1:3403 — постоянный умный роутер image-studio-lobechat-router.service (/opt/lobechat-next-router/engine-router.mjs);
#   * слоты: blue (/opt/lobechat-next-blue, :3411) и green (/opt/lobechat-next-green, :3412) под image-studio-lobechat@{blue,green};
#   * /opt/lobechat-next — атомарный симлинк на активный слот (совместимость с nginx alias, .deployed-commit, env-check, auditd);
#   * /var/lib/lobechat-engine/state.json — состояние слотов + сторож .switch-pending;
#   * старый слот уходит в drain (POST /arckep/engine-slot/drain): все идущие ответы, _chat_wait, cron и задачи E2B
#     спокойно доходят до конца без единого обрыва, после чего фоновый доводчик гасит старый слот.
#
# Usage:
#   bash deploy-engine.sh                  # бесшовная Blue-Green сборка и переключение слотов
#   bash deploy-engine.sh --install        # форсирует pnpm install --frozen-lockfile перед сборкой
#   bash deploy-engine.sh --init [--force] # однократный переход со старой image-studio-lobechat-next на blue + router
#   bash deploy-engine.sh --rollback       # мгновенный откат (< 2 с) на предыдущий слот с drain текущего
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
  bash deploy-engine.sh --rollback          # Мгновенный откат (< 2 с) на предыдущий слот с drain текущего
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
BUILD_LOCK_FILE="${ENGINE_BUILD_LOCK:-/var/tmp/wt/.lobechat-build.lock}"
DRAIN_GRACE_SEC="${ENGINE_DRAIN_GRACE_SEC:-15}"
DRAIN_MAX_WAIT_SEC="${ENGINE_DRAIN_MAX_WAIT_SEC:-2100}"

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

write_state_json() {
    local active_slot="$1" active_port="$2" draining_slot="${3:-}" draining_port="${4:-}" epoch="$5"
    mkdir -p "$STATE_DIR"
    chmod 0755 "$STATE_DIR"
    local tmp_file="${STATE_FILE}.tmp.$$"
    python3 - "$tmp_file" "$active_slot" "$active_port" "$draining_slot" "$draining_port" "$epoch" <<'PY'
import json, os, sys

path, a_slot, a_port, d_slot, d_port, epoch = sys.argv[1:7]
payload = {
    "activeSlot": a_slot,
    "activePort": int(a_port),
    "drainingSlot": d_slot if d_slot else None,
    "drainingPort": int(d_port) if d_port else None,
    "switchEpoch": int(epoch),
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
    fh.flush()
    os.fsync(fh.fileno())
os.chmod(path, 0o644)
PY
    mv -Tf "$tmp_file" "$STATE_FILE"
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
            key = val
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

# Call engine-slot endpoint via stdin curl config so the service key never appears in argv/ps
slot_api_call() {
    local method="$1" port="$2" endpoint="$3" env_path="${4:-}"
    if [[ -z "$env_path" ]]; then
        env_path=$(resolve_live_env_file 2>/dev/null || true)
    fi
    [[ -n "$env_path" && -f "$env_path" ]] || return 1
    local svc_key
    svc_key=$(read_service_key_from_env "$env_path")
    [[ -n "$svc_key" ]] || return 1
    printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$svc_key" | \
        curl -sS --fail --max-time 3 -X "$method" -K - \
        "http://127.0.0.1:${port}/chat/api/v1/arckep/engine-slot/${endpoint}/" 2>/dev/null
}

parse_active_total() {
    python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(int(d.get("activeTotal", 0)))'
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

stop_background_drainer() {
    local slot="$1"
    local unit="lobechat-drain-${slot}.service"
    systemctl stop "$unit" 2>/dev/null || true
    systemctl reset-failed "$unit" 2>/dev/null || true
    local pid_file="$STATE_DIR/drain-${slot}.pid"
    if [[ -f "$pid_file" ]]; then
        local old_pid
        old_pid=$(cat "$pid_file" 2>/dev/null || true)
        if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
            kill "$old_pid" 2>/dev/null || true
        fi
        rm -f "$pid_file"
    fi
}

wait_slot_idle_before_overwrite() {
    local slot="$1" port="$2" env_path="$3"
    local svc
    svc=$(slot_service "$slot")
    if ! systemctl is-active --quiet "$svc" 2>/dev/null; then
        return 0
    fi
    local waited=0 status_json="" active_total=0
    while true; do
        status_json=$(slot_api_call GET "$port" "status" "$env_path" || true)
        if [[ -z "$status_json" ]]; then
            break
        fi
        active_total=$(printf '%s' "$status_json" | parse_active_total 2>/dev/null || echo 0)
        if [[ "$active_total" -le 0 ]]; then
            break
        fi
        log "Целевой слот $slot (:$port) ещё дорабатывает прошлую выкладку (activeTotal=$active_total, ждём ${waited}s)..."
        sleep 5
        waited=$((waited + 5))
    done
}

write_slot_drainer_helper() {
    mkdir -p "$ROUTER_DIR"
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

log() { echo "[engine-drain:${SLOT} $(date '+%H:%M:%S')] $*"; }

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

safe_to_stop_slot() {
    [[ -f "$STATE_FILE" ]] || return 1
    python3 - "$STATE_FILE" "$SLOT" "$EXPECTED_EPOCH" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    d = json.load(fh)
ok = (
    d.get("activeSlot") != sys.argv[2]
    and d.get("drainingSlot") is None
    and int(d.get("switchEpoch", -1)) == int(sys.argv[3])
)
sys.exit(0 if ok else 1)
PY
}

get_active_total() {
    local key
    key=$(python3 - "$ENV_FILE" <<'PY'
import sys
key = ""
with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as fh:
    for raw in fh:
        line = raw.strip()
        if line.startswith("export "):
            line = line[7:].strip()
        if line.startswith("ARCKEP_ENGINE_SERVICE_KEY="):
            v = line.split("=", 1)[1].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            key = v
sys.stdout.write(key)
PY
)
    [[ -n "$key" ]] || { echo 0; return 0; }
    local resp
    resp=$(printf 'header = "Authorization: Bearer %s"\nheader = "Host: arckep.ru"\n' "$key" | \
        curl -sS --fail --max-time 3 -K - "http://127.0.0.1:${PORT}/chat/api/v1/arckep/engine-slot/status/" 2>/dev/null || true)
    if [[ -z "$resp" ]]; then
        echo 0
        return 0
    fi
    python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(int(d.get("activeTotal", 0)))' <<< "$resp" 2>/dev/null || echo 0
}

clear_draining_in_state() {
    local tmp="${STATE_FILE}.drain.tmp.$$"
    local rc=0
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
    if [[ $rc -eq 0 ]]; then
        mv -Tf "$tmp" "$STATE_FILE"
        return 0
    fi
    rm -f "$tmp"
    return $rc
}

log "Начат drain слота ${SLOT} (:${PORT}, epoch=${EXPECTED_EPOCH}, max=${MAX_WAIT_SEC}s)"
elapsed=0
while (( elapsed < MAX_WAIT_SEC )); do
    if ! state_matches; then
        log "Состояние изменилось (слот активирован заново или новая эпоха) — отменяю остановку ${SLOT}."
        exit 0
    fi
    if ! systemctl is-active --quiet "$SLOT_SERVICE" 2>/dev/null; then
        log "Служба ${SLOT_SERVICE} уже остановлена."
        break
    fi
    active_total=$(get_active_total)
    if (( active_total <= 0 )); then
        log "activeTotal=0 достигнут за ${elapsed}s; выдерживаю ${GRACE_SEC}s для реплея буфера..."
        sleep "$GRACE_SEC"
        if ! state_matches; then
            log "Состояние изменилось во время паузы — отменяю остановку ${SLOT}."
            exit 0
        fi
        active_total_after=$(get_active_total)
        if (( active_total_after <= 0 )); then
            break
        fi
        log "Во время паузы доработки активна ещё ${active_total_after} опер. — продолжаю ожидание."
        elapsed=$((elapsed + GRACE_SEC))
        continue
    fi
    sleep 3
    elapsed=$((elapsed + 3))
done

if (( elapsed >= MAX_WAIT_SEC )); then
    log "WARN: достигнут потолок ожидания ${MAX_WAIT_SEC}s для ${SLOT} — принудительное завершение drain."
fi

if ! state_matches; then
    log "Состояние изменилось перед завершением drain — отменяю остановку ${SLOT}."
    exit 0
fi

if ! clear_draining_in_state; then
    log "Состояние изменилось во время очистки drainingSlot — отменяю остановку ${SLOT}."
    exit 0
fi

systemctl reload "$ROUTER_SERVICE" 2>/dev/null || systemctl kill -s HUP "$ROUTER_SERVICE" 2>/dev/null || true
sleep 1

# Re-verify state.json right before systemctl stop in case operator rolled back to $SLOT during reload
if ! safe_to_stop_slot; then
    log "Слот ${SLOT} снова стал активным (или сменилась эпоха) — отменяю systemctl stop ${SLOT_SERVICE}!"
    exit 0
fi

log "Останавливаю доработавший слот ${SLOT_SERVICE}..."
systemctl stop "$SLOT_SERVICE" 2>/dev/null || true
log "Слот ${SLOT} штатно погашен."
EOF
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
        warn "Не удалось вызвать /arckep/engine-slot/drain на :$draining_port (возможно, старый релиз без ручки)"
    fi

    write_slot_drainer_helper
    stop_background_drainer "$draining_slot"

    local helper="$ROUTER_DIR/slot-drainer.sh"
    local unit="lobechat-drain-${draining_slot}"
    if [[ -d /run/systemd/system ]] && command -v systemd-run >/dev/null 2>&1; then
        if systemd-run --quiet --collect --unit="$unit" \
            --property="StandardOutput=append:${LOG_FILE}" \
            --property="StandardError=append:${LOG_FILE}" \
            /bin/bash "$helper" \
            "$draining_slot" "$draining_port" "$epoch" "$STATE_FILE" \
            "$ROUTER_SERVICE" "$draining_svc" "$env_path" "$DRAIN_GRACE_SEC" "$DRAIN_MAX_WAIT_SEC"; then
            log "Запущен фоновый доводчик systemd ($unit.service)"
            return 0
        fi
    fi

    # Explicitly close all lock FDs (>2) in subshell so detached reaper NEVER holds deploy locks for 35m
    (
        exec 7>&- 8>&- 9>&- 2>/dev/null || true
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
            "$ROUTER_SERVICE" "$draining_svc" "$env_path" "$DRAIN_GRACE_SEC" "$DRAIN_MAX_WAIT_SEC" \
            >>"$LOG_FILE" 2>&1 </dev/null &
        echo "$!" > "$STATE_DIR/drain-${draining_slot}.pid"
    )
    local drain_pid
    drain_pid=$(cat "$STATE_DIR/drain-${draining_slot}.pid" 2>/dev/null || echo "?")
    log "Запущен фоновый доводчик nohup (pid=$drain_pid)"
}

install_router_and_units() {
    mkdir -p "$ROUTER_DIR"
    chmod 0755 "$ROUTER_DIR"
    if [[ ! -f "$ROUTER_DIR/engine-router.mjs" ]] || ! cmp -s "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs"; then
        cp -pf "$SRC/scripts/engine-router.mjs" "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        chmod 0755 "$ROUTER_DIR/engine-router.mjs.tmp.$$"
        mv -Tf "$ROUTER_DIR/engine-router.mjs.tmp.$$" "$ROUTER_DIR/engine-router.mjs"
        log "Обновлён $ROUTER_DIR/engine-router.mjs"
    fi

    local reload_needed=0
    for unit_name in image-studio-lobechat-router.service image-studio-lobechat@.service; do
        local src_unit="$SRC/deploy/systemd/$unit_name"
        local dst_unit="$SYSTEMD_DIR/$unit_name"
        if [[ ! -f "$dst_unit" ]] || ! cmp -s "$src_unit" "$dst_unit"; then
            cp -pf "$src_unit" "${dst_unit}.tmp.$$"
            chmod 0644 "${dst_unit}.tmp.$$"
            mv -Tf "${dst_unit}.tmp.$$" "$dst_unit"
            reload_needed=1
            log "Установлен unit $dst_unit"
        fi
    done

    if [[ "$reload_needed" == "1" || "$1" == "force-reload" ]]; then
        systemctl daemon-reload
        log "systemctl daemon-reload выполнен"
    fi
}

write_slot_env_file() {
    local target_dir="$1" slot_name="$2" port="$3"
    local slot_env="$target_dir/.slot.env"
    cat > "${slot_env}.tmp.$$" <<EOF
# Auto-generated by deploy-engine.sh — overrides PORT=3403 from .env while keeping INTERNAL_APP_URL on :3403
PORT=${port}
HOSTNAME=127.0.0.1
LOBECHAT_SLOT=${slot_name}
EOF
    chmod 0644 "${slot_env}.tmp.$$"
    if id lobechat >/dev/null 2>&1; then
        chown lobechat:lobechat "${slot_env}.tmp.$$"
    fi
    mv -Tf "${slot_env}.tmp.$$" "$slot_env"
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

check_legacy_port_quiet() {
    local env_path="$1"
    local status_json=""
    status_json=$(slot_api_call GET "$PORT" "status" "$env_path" || true)
    if [[ -n "$status_json" ]]; then
        local active_total
        active_total=$(printf '%s' "$status_json" | parse_active_total 2>/dev/null || echo 0)
        if (( active_total > 0 )); then
            err "На :$PORT сейчас активны операции (activeTotal=$active_total). Дождись завершения или передай '--init --force'."
            return 1
        fi
        return 0
    fi

    # Для старого релиза до появления /arckep/engine-slot/status проверяем активные потоки по очереди отправки сокета
    if command -v ss >/dev/null 2>&1; then
        local busy_sockets
        busy_sockets=$(ss -tn state established "( sport = :$PORT )" 2>/dev/null | awk 'NR>1 && ($2 > 0 || $3 > 0) {count++} END {print count+0}')
        if (( busy_sockets > 0 )); then
            err "На :$PORT обнаружены активные потоковые соединения ($busy_sockets). Дождись тихого окна или передай '--init --force'."
            return 1
        fi
    fi
    return 0
}

# =============================================================================
# STATUS
# =============================================================================
cmd_status() {
    echo ""
    echo "=== LobeChat Engine Deploy Status (Blue-Green) ==="
    echo ""

    local active_slot="none" draining_slot="" epoch="0"
    if [[ -f "$STATE_FILE" ]]; then
        active_slot=$(read_state_field activeSlot || echo "none")
        draining_slot=$(read_state_field drainingSlot || echo "")
        epoch=$(read_state_field switchEpoch || echo "0")
    fi

    printf "  Router (127.0.0.1:%s): " "$PORT"
    if systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        local r_health
        r_health=$(curl -sS --max-time 2 "http://127.0.0.1:${PORT}/__router/health" 2>/dev/null || echo "unreachable")
        echo "RUNNING — $r_health"
    else
        echo "stopped"
    fi

    if systemctl is-active --quiet "$LEGACY_SERVICE" 2>/dev/null; then
        echo "  Legacy ($LEGACY_SERVICE): RUNNING (миграция '--init' ещё не выполнена)"
    fi

    if [[ -e "$SWITCH_GUARD" || -L "$SWITCH_GUARD" ]]; then
        echo "  WARNING: Незавершённое переключение ($SWITCH_GUARD): $(cat "$SWITCH_GUARD" 2>/dev/null || true)"
    fi

    if [[ -L "$PROD" ]]; then
        echo "  Symlink $PROD -> $(readlink "$PROD")"
    elif [[ -d "$PROD" ]]; then
        echo "  Directory $PROD (legacy non-symlink)"
    fi
    echo "  Active slot: $active_slot (switchEpoch=$epoch)"
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
        if systemctl is-active --quiet "$c_svc" 2>/dev/null; then
            local s_json="" s_active="?"
            if [[ -n "$env_path" ]]; then
                s_json=$(slot_api_call GET "$c_port" "status" "$env_path" || true)
                if [[ -n "$s_json" ]]; then
                    s_active=$(printf '%s' "$s_json" | parse_active_total 2>/dev/null || echo "?")
                fi
            fi
            if [[ "$color" == "$active_slot" ]]; then
                echo "RUNNING [ACTIVE: active=${s_active}]"
            elif [[ "$color" == "$draining_slot" ]]; then
                echo "RUNNING [DRAINING: active=${s_active}]"
            else
                echo "RUNNING [STANDBY: active=${s_active}]"
            fi
        else
            echo "stopped"
        fi
    done
    echo ""
}

# =============================================================================
# ROLLBACK (< 2s instant switch + safe drain of rolled-back slot)
# =============================================================================
cmd_rollback() {
    acquire_deploy_lock "rollback"
    check_switch_allowed

    if [[ ! -f "$STATE_FILE" ]]; then
        err "Файл состояния $STATE_FILE не найден — сначала выполни '--init'."
        exit 1
    fi

    local current prev current_port prev_port current_dir prev_dir prev_svc epoch next_epoch env_path
    current=$(read_state_field activeSlot || true)
    if [[ "$current" != "blue" && "$current" != "green" ]]; then
        err "Некорректный activeSlot='$current' в $STATE_FILE"
        exit 1
    fi

    prev=$(other_slot "$current")
    current_port=$(slot_port "$current")
    prev_port=$(slot_port "$prev")
    current_dir=$(slot_dir "$current")
    prev_dir=$(slot_dir "$prev")
    prev_svc=$(slot_service "$prev")
    epoch=$(read_state_field switchEpoch || echo 0)
    next_epoch=$((epoch + 1))

    if [[ ! -f "$prev_dir/server.js" || ! -f "$prev_dir/.next/BUILD_ID" ]]; then
        err "Предыдущий слот $prev ($prev_dir) отсутствует или неполон — откат невозможен."
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
    sync

    if ! systemctl is-active --quiet "$prev_svc" 2>/dev/null; then
        log "Поднимаю предыдущий слот $prev_svc (:$prev_port)..."
        systemctl start "$prev_svc"
    fi

    if ! check_port_health "$prev_port" "" 20; then
        err "Предыдущий слот $prev (:$prev_port) не прошёл проверку здоровья — оставляю $current активным!"
        exit 1
    fi

    log "Мгновенный откат роутера: $current (:$current_port) -> $prev (:$prev_port)..."
    begin_switch "$current" "$prev"
    atomic_symlink "$prev_dir" "$PROD"
    write_state_json "$prev" "$prev_port" "$current" "$current_port" "$next_epoch"
    notify_router_reload

    if ! check_port_health "$PORT" "$prev" 10; then
        err "Проверка :$PORT после отката не прошла — возвращаю $current!"
        atomic_symlink "$current_dir" "$PROD"
        write_state_json "$current" "$current_port" "" "" "$((next_epoch + 1))"
        notify_router_reload
        if check_port_health "$PORT" "$current" 10; then
            clear_switch_guard
        fi
        reload_auditd_watches
        exit 1
    fi

    clear_switch_guard
    start_slot_drain "$current" "$current_port" "$next_epoch" "$prev_dir/.env"
    reload_auditd_watches

    log "ROLLBACK OK: активен слот $prev (:$prev_port, commit $(cat "$prev_dir/.deployed-commit" 2>/dev/null || echo unknown)); $current переведён в drain."
}

# =============================================================================
# BUILD & STAGE HELPER (shared by --stage-only, --init, and normal Blue-Green)
# =============================================================================
build_into_stage_dir() {
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
            run_with_build_lock env NEXT_BUILD_STANDALONE=1 bun run build:next
        else
            run_with_build_lock env \
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
    mkdir -p "$stage_dir"

    log "Собираю standalone runtime в $stage_dir"
    if [[ "$standalone_root" != "$standalone_app" && -d "$standalone_root/node_modules" ]]; then
        mkdir -p "$stage_dir/node_modules"
        rsync -a "$standalone_root/node_modules/" "$stage_dir/node_modules/"
    fi
    rsync -a "$standalone_app/" "$stage_dir/"
    rm -f "$stage_dir"/.env "$stage_dir"/.env.* "$stage_dir"/.slot.env
    mkdir -p "$stage_dir/.next/static"
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
}

prepare_staged_slot_metadata() {
    local stage_dir="$1" slot_name="$2" slot_port_num="$3" env_source_dir="$4"

    echo "$HEAD_COMMIT" > "$stage_dir/.deployed-commit"
    echo "$LOCK_HASH" > "$stage_dir/.deployed-lockhash"

    if id lobechat >/dev/null 2>&1; then
        chown -R lobechat:lobechat "$stage_dir"
    fi

    write_slot_env_file "$stage_dir" "$slot_name" "$slot_port_num"
    copy_verified_env_to_slot "$env_source_dir" "$stage_dir"
    sync
}

populate_slot_from_stage() {
    local stage_dir="$1" dst_slot_dir="$2" slot_name="$3" slot_port_num="$4" env_source_dir="$5"

    prepare_staged_slot_metadata "$stage_dir" "$slot_name" "$slot_port_num" "$env_source_dir"

    mkdir -p "$(dirname "$dst_slot_dir")"
    if [[ ! -e "$dst_slot_dir" ]] && mv -Tf "$stage_dir" "$dst_slot_dir" 2>/dev/null; then
        sync
        return 0
    fi

    mkdir -p "$dst_slot_dir"
    rsync -a --delete --exclude='.env' --exclude='.env.bak*' "$stage_dir/" "$dst_slot_dir/"
    if id lobechat >/dev/null 2>&1; then
        chown lobechat:lobechat "$dst_slot_dir" "$dst_slot_dir/.slot.env"
    fi
    copy_verified_env_to_slot "$env_source_dir" "$dst_slot_dir"
    sync
}

# =============================================================================
# INIT: one-time cutover from legacy image-studio-lobechat-next -> blue + router
# =============================================================================
cmd_init() {
    local force_flag="${1:-}"
    acquire_deploy_lock "init"
    check_switch_allowed

    if [[ -f "$STATE_FILE" && -L "$PROD" ]] && systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        err "Blue-Green уже инициализирован ($STATE_FILE существует, $ROUTER_SERVICE запущен). Используй обычный 'bash deploy-engine.sh'."
        exit 1
    fi

    if [[ ! -f "$PROD/.env" ]]; then
        err "$PROD/.env не найден — инициализация невозможна."
        exit 1
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_port_quiet "$PROD/.env"
    fi

    STAGE_DIR="$(dirname "$SLOT_BLUE_DIR")/.lobechat-engine.stage.$$"
    trap 'rm -rf -- "${STAGE_DIR:-}"' EXIT

    build_into_stage_dir "$STAGE_DIR" "0" "$PROD"

    install_router_and_units "force-reload"

    local blue_svc
    blue_svc=$(slot_service "blue")
    stop_background_drainer "blue"
    systemctl stop "$blue_svc" 2>/dev/null || true

    populate_slot_from_stage "$STAGE_DIR" "$SLOT_BLUE_DIR" "blue" "$BLUE_PORT" "$PROD"
    rm -rf -- "${STAGE_DIR:-}"
    STAGE_DIR=""

    log "Запускаю слот $blue_svc на 127.0.0.1:$BLUE_PORT..."
    systemctl enable --now "$blue_svc"

    if ! check_port_health "$BLUE_PORT" "" 25; then
        err "Слот blue (:$BLUE_PORT) не прошёл проверку здоровья — старый $LEGACY_SERVICE на :$PORT не затронут!"
        systemctl stop "$blue_svc" 2>/dev/null || true
        exit 1
    fi

    if ! slot_api_call GET "$BLUE_PORT" "status" "$SLOT_BLUE_DIR/.env" >/dev/null; then
        err "Служебная ручка /arckep/engine-slot/status на :$BLUE_PORT недоступна — отменяю переход!"
        systemctl stop "$blue_svc" 2>/dev/null || true
        exit 1
    fi

    if [[ "$force_flag" != "--force" ]]; then
        check_legacy_port_quiet "$PROD/.env"
    fi

    local legacy_backup="${PROD}.legacy-pre-bg"
    if [[ -e "$legacy_backup" ]]; then
        legacy_backup="${PROD}.legacy-pre-bg.$(date +%s)"
    fi

    log "Выполняю переключение со старой службы $LEGACY_SERVICE на blue (:$BLUE_PORT) + роутер (:$PORT)..."
    write_state_json "blue" "$BLUE_PORT" "" "" 1

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
        rm -f "$PROD" "$STATE_FILE"
        if [[ -d "$legacy_backup" ]]; then
            mv "$legacy_backup" "$PROD"
        fi
        systemctl enable --now "$LEGACY_SERVICE" || true
        check_port_health "$PORT" "" 15 || true
        reload_auditd_watches
        exit 1
    fi

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

    local active target active_port target_port active_dir target_dir target_svc epoch next_epoch
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
    target_svc=$(slot_service "$target")
    epoch=$(read_state_field switchEpoch || echo 1)
    next_epoch=$((epoch + 1))

    if [[ ! -f "$active_dir/.env" ]]; then
        err "Не найден $active_dir/.env — выкладка остановлена!"
        exit 1
    fi

    log "Активный слот: $active (:$active_port) -> Собираю целевой слот: $target (:$target_port)"

    STAGE_DIR="$(dirname "$target_dir")/.lobechat-engine.stage.$$"
    BACKUP_TARGET_DIR=""

    restore_target_slot_backup() {
        systemctl stop "$target_svc" 2>/dev/null || true
        if [[ -n "${BACKUP_TARGET_DIR:-}" && -d "$BACKUP_TARGET_DIR" ]]; then
            rm -rf -- "$target_dir"
            mv -Tf "$BACKUP_TARGET_DIR" "$target_dir"
            BACKUP_TARGET_DIR=""
            log "Восстановлен предыдущий рабочий резервный слот $target ($target_dir)."
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

    # Дождаться естественного окончания прошлых задач на целевом слоте, затем погасить его ДО замены каталога
    wait_slot_idle_before_overwrite "$target" "$target_port" "$active_dir/.env"
    stop_background_drainer "$target"
    log "Останавливаю неактивный слот $target_svc перед обновлением файлов..."
    systemctl stop "$target_svc" 2>/dev/null || true

    install_router_and_units "if-changed"

    # Сохраняем рабочий резервный слот перед переключением на случай падения старта/проверки кандидата
    mkdir -p "$(dirname "$target_dir")"
    if [[ -d "$target_dir" ]]; then
        BACKUP_TARGET_DIR="${target_dir}.rollback-bak.$$"
        rm -rf -- "$BACKUP_TARGET_DIR"
        mv -Tf "$target_dir" "$BACKUP_TARGET_DIR"
    fi
    if mv -Tf "$STAGE_DIR" "$target_dir" 2>/dev/null; then
        STAGE_DIR=""
    else
        mkdir -p "$target_dir"
        rsync -a --delete --exclude='.env' --exclude='.env.bak*' "$STAGE_DIR/" "$target_dir/"
        if id lobechat >/dev/null 2>&1; then
            chown lobechat:lobechat "$target_dir" "$target_dir/.slot.env"
        fi
        copy_verified_env_to_slot "$active_dir" "$target_dir"
        rm -rf -- "$STAGE_DIR"
        STAGE_DIR=""
    fi
    sync

    log "Запускаю свежий слот $target_svc (:$target_port)..."
    if ! systemctl enable --now "$target_svc"; then
        err "Не удалось запустить $target_svc — восстанавливаю резервный слот $target!"
        restore_target_slot_backup
        exit 1
    fi

    if ! check_port_health "$target_port" "" 25; then
        err "Свежий слот $target (:$target_port) не прошёл проверку здоровья — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    if ! slot_api_call GET "$target_port" "status" "$target_dir/.env" >/dev/null; then
        err "Служебная ручка /arckep/engine-slot/status на :$target_port не ответила — активный $active и резервный $target сохранены!"
        restore_target_slot_backup
        exit 1
    fi

    if ! systemctl is-active --quiet "$ROUTER_SERVICE" 2>/dev/null; then
        log "Роутер $ROUTER_SERVICE был остановлен — запускаю..."
        systemctl enable --now "$ROUTER_SERVICE"
    fi

    log "Переключаю роутер :$PORT на $target (:$target_port), старый $active (:$active_port) уходит в drain..."
    begin_switch "$active" "$target"
    atomic_symlink "$target_dir" "$PROD"
    write_state_json "$target" "$target_port" "$active" "$active_port" "$next_epoch"
    notify_router_reload

    if ! check_port_health "$PORT" "$target" 15; then
        err "CRITICAL: проверка :$PORT после переключения на $target не прошла — мгновенный откат на $active!"
        atomic_symlink "$active_dir" "$PROD"
        write_state_json "$active" "$active_port" "" "" "$((next_epoch + 1))"
        notify_router_reload
        if check_port_health "$PORT" "$active" 10; then
            clear_switch_guard
        fi
        restore_target_slot_backup
        reload_auditd_watches
        exit 1
    fi

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
