#!/usr/bin/env bash
# Isolated shell regression suite for `deploy-engine.sh` (Codex v2 findings #1, #2, #3, #4, #5, #6, #7, #8, #11, #13).
# Runs purely against a temporary sandbox directory with mock `systemctl` / `ss` / `augenrules` binaries in PATH —
# NEVER touches host systemd, `/opt/lobechat*`, or any production `.env`!
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SH="$REPO_ROOT/deploy-engine.sh"

SANDBOX="$(mktemp -d /var/tmp/lc-deploy-shell-test.XXXXXX)"
MOCK_BIN="$SANDBOX/bin"
mkdir -p "$MOCK_BIN"

MOCK_PIDS=()
cleanup() {
    local pf raw dp
    for pf in "$SANDBOX"/var/lib/lobechat-engine/drain-*.pid; do
        if [[ -f "$pf" ]]; then
            raw=$(cat "$pf" 2>/dev/null || true)
            dp="${raw%%:*}"
            [[ "$dp" =~ ^[0-9]+$ ]] && kill -9 "$dp" 2>/dev/null || true
        fi
    done
    for pid in "${MOCK_PIDS[@]:-}"; do
        [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true
    done
    sleep 0.1
    rm -rf -- "$SANDBOX" 2>/dev/null || rm -rf -- "$SANDBOX" || true
}
trap cleanup EXIT

fail() {
    echo "[shell-test] FAIL: $*" >&2
    exit 1
}

pass() {
    echo "[shell-test] PASS: $*"
}

# Create mock binaries so host systemctl / augenrules / ss are NEVER invoked!
cat > "$MOCK_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_ROOT="${MOCK_SYSTEMD_DIR:?}"
mkdir -p "$STATE_ROOT"

if [[ "${MOCK_SYSTEMCTL_DBUS_ERROR:-0}" == "1" ]]; then
    echo "Failed to connect to bus: No medium found" >&2
    exit 1
fi

cmd="${1:-}"
shift || true

# Strip options like --quiet, --now, -s, HUP, -p, Props
now_flag=0
props=""
while [[ $# -gt 0 && "$1" == -* ]]; do
    case "$1" in
        --quiet|-q) shift ;;
        --now) now_flag=1; shift ;;
        -p) props="${2:-}"; shift 2 ;;
        -s) shift 2 ;;
        *) shift ;;
    esac
done

unit="${1:-}"
units=("$@")
unit_key="${unit//\//_}"

read_active() {
    local u="$1"
    if [[ -f "$STATE_ROOT/${u}.active" ]]; then
        cat "$STATE_ROOT/${u}.active"
    else
        echo "inactive"
    fi
}

echo "${cmd} ${units[*]:-}" >> "$STATE_ROOT/ops.log"

case "$cmd" in
    daemon-reload|reset-failed)
        exit 0
        ;;
    show)
        act=$(read_active "$unit_key")
        if [[ "$act" == "active" ]]; then
            printf 'LoadState=loaded\nActiveState=active\nSubState=running\n'
        elif [[ "$act" == "failed" ]]; then
            printf 'LoadState=loaded\nActiveState=failed\nSubState=failed\n'
        else
            printf 'LoadState=loaded\nActiveState=inactive\nSubState=dead\n'
        fi
        exit 0
        ;;
    is-active)
        [[ "$(read_active "$unit_key")" == "active" ]] && exit 0 || exit 3
        ;;
    start)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            if [[ "${MOCK_FAIL_START_UNIT:-}" == "$u" ]]; then
                exit 1
            fi
            echo "active" > "$STATE_ROOT/${u//\//_}.active"
        done
        exit 0
        ;;
    stop)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            if [[ "${MOCK_FAIL_STOP_UNIT:-}" == "$u" ]]; then
                echo "Simulated systemctl stop failure for $u" >&2
                exit 1
            fi
            if [[ "${MOCK_KEEP_ACTIVE_AFTER_STOP:-}" == "$u" ]]; then
                continue
            fi
            echo "inactive" > "$STATE_ROOT/${u//\//_}.active"
        done
        exit 0
        ;;
    restart)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            echo "active" > "$STATE_ROOT/${u//\//_}.active"
            echo "${u}" >> "$STATE_ROOT/restarted.log"
        done
        exit 0
        ;;
    reload|kill)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            echo "${u}" >> "$STATE_ROOT/reloaded.log"
            if [[ "$u" == "image-studio-lobechat-router" && "${MOCK_FREEZE_ROUTER_HASH:-0}" != "1" ]]; then
                if [[ -n "${MOCK_ROUTER_CORE_FILE:-}" && -f "${MOCK_ROUTER_CORE_FILE}" && -n "${MOCK_HTTP_CTRL_DIR:-}" ]]; then
                    sha256sum "${MOCK_ROUTER_CORE_FILE}" | awk '{print $1}' > "${MOCK_HTTP_CTRL_DIR}/router_hash"
                fi
            fi
        done
        exit 0
        ;;
    enable)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            uk="${u//\//_}"
            echo "enabled" > "$STATE_ROOT/${uk}.enabled"
            if [[ "$now_flag" == "1" ]]; then
                echo "active" > "$STATE_ROOT/${uk}.active"
            fi
        done
        exit 0
        ;;
    disable)
        for u in "${units[@]}"; do
            [[ -n "$u" ]] || continue
            echo "disabled" > "$STATE_ROOT/${u//\//_}.enabled"
        done
        exit 0
        ;;
    *)
        exit 0
        ;;
esac
EOF
chmod +x "$MOCK_BIN/systemctl"

cat > "$MOCK_BIN/augenrules" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/augenrules"

cat > "$MOCK_BIN/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_BIN/pnpm"

cat > "$MOCK_BIN/ss" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_SS_DYNAMIC_FILE:-}" && -f "${MOCK_SS_DYNAMIC_FILE}" ]]; then
    cat "${MOCK_SS_DYNAMIC_FILE}"
fi
if [[ -n "${MOCK_SS_OUTPUT:-}" ]]; then
    printf '%s\n' "$MOCK_SS_OUTPUT"
fi
exit "${MOCK_SS_RC:-0}"
EOF
chmod +x "$MOCK_BIN/ss"

# Prepare lightweight fake source checkout inside $SANDBOX/src so ENGINE_SKIP_BUILD=1 stages in <0.5s
FAKE_SRC="$SANDBOX/src"
mkdir -p "$FAKE_SRC/scripts" "$FAKE_SRC/deploy/systemd" "$FAKE_SRC/.next/standalone" "$FAKE_SRC/.next/static" "$FAKE_SRC/public/_spa" "$FAKE_SRC/src/app/spa/[variants]/[[...path]]" "$FAKE_SRC/node_modules/next" "$FAKE_SRC/node_modules/sharp" "$FAKE_SRC/node_modules/@napi-rs/canvas"
cp -pf "$REPO_ROOT/deploy-engine.sh" "$FAKE_SRC/deploy-engine.sh"
cp -pf "$REPO_ROOT/scripts/engine-router.mjs" "$FAKE_SRC/scripts/engine-router.mjs"
cp -pf "$REPO_ROOT/scripts/engine-router-core.mjs" "$FAKE_SRC/scripts/engine-router-core.mjs"
cp -pf "$REPO_ROOT/deploy/systemd/"* "$FAKE_SRC/deploy/systemd/"
echo "build-test-123" > "$FAKE_SRC/.next/BUILD_ID"
mkdir -p "$FAKE_SRC/.next/standalone/.next"
echo "build-test-123" > "$FAKE_SRC/.next/standalone/.next/BUILD_ID"
echo "console.log('mock standalone');" > "$FAKE_SRC/.next/standalone/server.js"
echo "static-asset" > "$FAKE_SRC/.next/static/chunk.js"
echo "// stub" > "$FAKE_SRC/src/app/spa/[variants]/[[...path]]/spaHtmlTemplates.ts"
echo '{"name":"next","version":"16.1.0-test"}' > "$FAKE_SRC/node_modules/next/package.json"
echo "module.exports = { ok: true };" > "$FAKE_SRC/node_modules/sharp/index.js"
echo '{"name":"sharp","main":"index.js"}' > "$FAKE_SRC/node_modules/sharp/package.json"
echo "module.exports = { ok: true };" > "$FAKE_SRC/node_modules/@napi-rs/canvas/index.js"
echo '{"name":"@napi-rs/canvas","main":"index.js"}' > "$FAKE_SRC/node_modules/@napi-rs/canvas/package.json"
mkdir -p "$FAKE_SRC/.next/standalone/node_modules"
cp -a "$FAKE_SRC/node_modules/next" "$FAKE_SRC/.next/standalone/node_modules/next"
cp -a "$FAKE_SRC/node_modules/sharp" "$FAKE_SRC/.next/standalone/node_modules/sharp"
mkdir -p "$FAKE_SRC/.next/standalone/node_modules/@napi-rs"
cp -a "$FAKE_SRC/node_modules/@napi-rs/canvas" "$FAKE_SRC/.next/standalone/node_modules/@napi-rs/canvas"
echo '{"name":"lobechat-test"}' > "$FAKE_SRC/package.json"
echo "lockfileVersion: '9.0'" > "$FAKE_SRC/pnpm-lock.yaml"
echo "node_modules/" > "$FAKE_SRC/.gitignore"

(
    cd "$FAKE_SRC"
    git init -q
    git config user.email "test@arckep.ru"
    git config user.name "Test"
    git add -A
    git commit -q -m "initial fake buildable tree"
)

# Start tiny Python mock HTTP server simulating legacy/blue/green/router ports
PORT_INFO="$SANDBOX/ports.env"
HTTP_CTRL_DIR="$SANDBOX/http-ctrl"
mkdir -p "$HTTP_CTRL_DIR"

python3 - "$PORT_INFO" "$HTTP_CTRL_DIR" <<'PY' &
import http.server, json, os, socketserver, sys, threading

port_info_path, ctrl_dir = sys.argv[1:3]

def read_ctrl(name, default=""):
    p = os.path.join(ctrl_dir, name)
    if os.path.isfile(p):
        with open(p, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    return default

def make_handler(role):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def _send(self, code, body, headers=None):
            raw = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            if headers:
                for k, v in headers.items():
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path.startswith("/__router/health"):
                r_hash = read_ctrl("router_hash", "unknown")
                a_slot = read_ctrl("router_active_slot", "blue")
                self._send(200, json.dumps({
                    "status": "ok",
                    "activeSlot": a_slot,
                    "switchEpoch": 1,
                    "routerHash": r_hash,
                    "serviceKeyConfigured": True,
                    "inFlightRequests": 0,
                    "socketActivated": True,
                }))
                return
            if self.path in ("/chat/", "/chat"):
                mode = read_ctrl(f"{role}_health", "ok")
                if mode != "ok":
                    self._send(502, json.dumps({"error": "bad"}))
                    return
                slot_hdr = read_ctrl("router_active_slot", "blue") if role == "router" else role
                self._send(200, json.dumps({"ok": True}), {"X-LobeChat-Slot": slot_hdr})
                return
            if self.path.startswith("/chat/api/v1/health"):
                mode = read_ctrl(f"{role}_health", "ok")
                if mode != "ok":
                    self._send(502, json.dumps({"error": "bad"}, separators=(",", ":")))
                    return
                slot_hdr = read_ctrl("router_active_slot", "blue") if role == "router" else role
                self._send(200, json.dumps({"status": "ok"}, separators=(",", ":")), {"X-LobeChat-Slot": slot_hdr})
                return
            if self.path.startswith("/chat/api/v1/arckep/engine-slot/status"):
                expected_key = read_ctrl(f"{role}_key", "")
                if expected_key and self.headers.get("Authorization") != f"Bearer {expected_key}":
                    self._send(401, json.dumps({"error": "unauthorized"}))
                    return
                retained = json.loads(read_ctrl(f"{role}_retained", "[]"))
                active_total = int(read_ctrl(f"{role}_active", "0"))
                draining = read_ctrl(f"{role}_draining", "true") == "true"
                self._send(200, json.dumps({
                    "activeTotal": active_total,
                    "activeTopicIds": [],
                    "retainedTopicIds": retained,
                    "draining": draining,
                    "sandboxWorkerRunning": not draining,
                    "topicSeqs": {},
                }))
                return
            self._send(404, "{}")

        def do_POST(self):
            expected_key = read_ctrl(f"{role}_key", "")
            if expected_key and self.headers.get("Authorization") != f"Bearer {expected_key}":
                self._send(401, json.dumps({"error": "unauthorized"}))
                return
            if self.path.endswith("/undrain/"):
                with open(os.path.join(ctrl_dir, f"{role}_draining"), "w", encoding="utf-8") as fh:
                    fh.write("false")
                self._send(200, json.dumps({"draining": False}))
                return
            if self.path.endswith("/drain/"):
                with open(os.path.join(ctrl_dir, f"{role}_draining"), "w", encoding="utf-8") as fh:
                    fh.write("true")
                self._send(200, json.dumps({"draining": True}))
                return
            self._send(404, "{}")
    return H

servers = {}
for role in ("router", "blue", "green"):
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), make_handler(role))
    servers[role] = srv
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()

with open(port_info_path, "w", encoding="utf-8") as fh:
    for role, srv in servers.items():
        fh.write(f"TEST_{role.upper()}_PORT={srv.server_address[1]}\n")

threading.Event().wait()
PY
MOCK_PIDS+=("$!")

for _i in $(seq 1 50); do
    [[ -s "$PORT_INFO" ]] && break
    sleep 0.05
done
# shellcheck disable=SC1090
source "$PORT_INFO"

SVC_KEY="test-shell-arckep-engine-service-key-min-32-chars!!"
echo "$SVC_KEY" > "$HTTP_CTRL_DIR/blue_key"
echo "$SVC_KEY" > "$HTTP_CTRL_DIR/green_key"
sha256sum "$FAKE_SRC/scripts/engine-router-core.mjs" | awk '{print $1}' > "$HTTP_CTRL_DIR/router_hash"

# Mock Node wrapper for #4 quietness check while delegating everything else to real /usr/bin/node
MOCK_NODE="$MOCK_BIN/mock-node"
cat > "$MOCK_NODE" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${ENV_FILE_PATH:-}" ]]; then
    if [[ -n "${MOCK_BG_COUNTER_FILE:-}" ]]; then
        echo "quiet_check" >> "$MOCK_BG_COUNTER_FILE"
        if [[ -n "${MOCK_CONN_ON_BG_CALL:-}" && -n "${MOCK_SS_DYNAMIC_FILE:-}" ]]; then
            cnt=$(wc -l < "$MOCK_BG_COUNTER_FILE")
            if [[ "$cnt" -eq "${MOCK_CONN_ON_BG_CALL}" ]]; then
                echo "ESTAB 0 0 127.0.0.1:3403 127.0.0.1:54321" > "${MOCK_SS_DYNAMIC_FILE}"
            fi
        fi
    fi
    if [[ "${MOCK_BG_CHECK_RESULT:-QUIET}" != "QUIET" ]]; then
        printf '%s' "${MOCK_BG_CHECK_RESULT}"
        exit 2
    fi
    printf 'QUIET'
    exit 0
fi
exec /usr/bin/node "$@"
EOF
chmod +x "$MOCK_NODE"

COMMON_ENV=(
    "PATH=$MOCK_BIN:$PATH"
    "MOCK_SYSTEMD_DIR=$SANDBOX/systemd-state"
    "MOCK_ROUTER_CORE_FILE=$SANDBOX/opt/lobechat-next-router/engine-router-core.mjs"
    "MOCK_HTTP_CTRL_DIR=$HTTP_CTRL_DIR"
    "ENGINE_SRC=$FAKE_SRC"
    "ENGINE_PROD=$SANDBOX/opt/lobechat-next"
    "ENGINE_SLOT_BLUE_DIR=$SANDBOX/opt/lobechat-next-blue"
    "ENGINE_SLOT_GREEN_DIR=$SANDBOX/opt/lobechat-next-green"
    "ENGINE_ROUTER_DIR=$SANDBOX/opt/lobechat-next-router"
    "ENGINE_STATE_DIR=$SANDBOX/var/lib/lobechat-engine"
    "ENGINE_SYSTEMD_DIR=$SANDBOX/etc/systemd/system"
    "ENGINE_LOG_FILE=$SANDBOX/lobechat.log"
    "ENGINE_DEPLOY_LOCK=$SANDBOX/locks/deploy.lock"
    "ENGINE_STATE_LOCK=$SANDBOX/locks/state.lock"
    "ENGINE_BUILD_LOCK=$SANDBOX/locks/build.lock"
    "ENGINE_PORT=$TEST_ROUTER_PORT"
    "ENGINE_BLUE_PORT=$TEST_BLUE_PORT"
    "ENGINE_GREEN_PORT=$TEST_GREEN_PORT"
    "ENGINE_SKIP_BUILD=1"
    "ENGINE_NODE_BIN=$MOCK_NODE"
    "ENGINE_DRAIN_GRACE_SEC=0"
    "ENGINE_FORCE_NOHUP_DRAINER=1"
)

# =============================================================================
# TEST 1 (#2): --stage-only with relative path BEFORE `cd "$SRC"`
# =============================================================================
CALLER_CWD="$SANDBOX/caller-cwd"
mkdir -p "$CALLER_CWD" "$FAKE_SRC/rel-stage-out"
echo "DO_NOT_DELETE_SOURCE_DIR" > "$FAKE_SRC/rel-stage-out/precious.txt"
(
    cd "$CALLER_CWD"
    env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" --stage-only "rel-stage-out" >/dev/null
)
[[ -f "$FAKE_SRC/rel-stage-out/precious.txt" ]] || fail "#2: relative --stage-only wiped $FAKE_SRC/rel-stage-out inside \$SRC!"
[[ -f "$CALLER_CWD/rel-stage-out/server.js" ]] || fail "#2: relative --stage-only did not stage into caller CWD!"
rm -rf "$FAKE_SRC/rel-stage-out"
(
    cd "$FAKE_SRC"
    git checkout -- . 2>/dev/null || true
)
pass "#2 relative --stage-only resolved before cd \$SRC"

# =============================================================================
# TEST 2 (#3): `errexit` preserved under build lock when `sharp` fails!
# =============================================================================
echo "throw new Error('simulated broken sharp binary');" > "$FAKE_SRC/.next/standalone/node_modules/sharp/index.js"
echo "throw new Error('simulated broken sharp binary');" > "$FAKE_SRC/node_modules/sharp/index.js"
sharp_rc=0
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" --stage-only "$SANDBOX/stage-broken-sharp" >/dev/null 2>&1 || sharp_rc=$?
[[ "$sharp_rc" -ne 0 ]] || fail "#3: broken sharp returned exit code 0 under build lock!"
# Restore working sharp mock
echo "module.exports = { ok: true };" > "$FAKE_SRC/node_modules/sharp/index.js"
echo "module.exports = { ok: true };" > "$FAKE_SRC/.next/standalone/node_modules/sharp/index.js"
pass "#3 broken sharp fails with non-zero exit code ($sharp_rc) under build lock"

# =============================================================================
# TEST 3 (#4 + #5): `--init` fail-closed on Redis/PG background activity + clean exit 0 under `set -u`!
# =============================================================================
mkdir -p "$SANDBOX/opt/lobechat-next"
printf 'ARCKEP_ENGINE_SERVICE_KEY=%s\nDATABASE_URL=postgres://u:p@127.0.0.1:5432/lobechat\n' "$SVC_KEY" > "$SANDBOX/opt/lobechat-next/.env"
mkdir -p "$SANDBOX/systemd-state"
echo "active" > "$SANDBOX/systemd-state/image-studio-lobechat-next.active"

init_busy_redis_rc=0
env "${COMMON_ENV[@]}" MOCK_BG_CHECK_RESULT="BUSY_REDIS:2" bash "$FAKE_SRC/deploy-engine.sh" --init >/dev/null 2>&1 || init_busy_redis_rc=$?
[[ "$init_busy_redis_rc" -ne 0 ]] || fail "#4: --init allowed stopping legacy while Redis step lock was active!"

init_busy_pg_rc=0
env "${COMMON_ENV[@]}" MOCK_BG_CHECK_RESULT="BUSY_PG:1" bash "$FAKE_SRC/deploy-engine.sh" --init >/dev/null 2>&1 || init_busy_pg_rc=$?
[[ "$init_busy_pg_rc" -ne 0 ]] || fail "#4: --init allowed stopping legacy while Postgres assistant '...' row was active!"

# v4 #4: Client connection arriving DURING the final Redis/PG check must block `systemctl stop image-studio-lobechat-next`!
rm -f "$SANDBOX/systemd-state/ops.log" "$SANDBOX/bg-checks-race.log" "$SANDBOX/ss-dynamic.txt"
echo "active" > "$SANDBOX/systemd-state/image-studio-lobechat-next.active"
init_race_rc=0
env "${COMMON_ENV[@]}" \
    MOCK_BG_CHECK_RESULT="QUIET" \
    MOCK_BG_COUNTER_FILE="$SANDBOX/bg-checks-race.log" \
    MOCK_CONN_ON_BG_CALL="3" \
    MOCK_SS_DYNAMIC_FILE="$SANDBOX/ss-dynamic.txt" \
    bash "$FAKE_SRC/deploy-engine.sh" --init >/dev/null 2>&1 || init_race_rc=$?
[[ "$init_race_rc" -ne 0 ]] || fail "v4 #4: --init stopped legacy even though TCP client connected during final Redis/PG check!"
[[ "$(cat "$SANDBOX/systemd-state/image-studio-lobechat-next.active")" == "active" ]] || fail "v4 #4: legacy service was stopped despite client connection during Redis/PG check!"
if grep -q "^stop image-studio-lobechat-next$" "$SANDBOX/systemd-state/ops.log" 2>/dev/null; then
    fail "v4 #4: systemctl stop image-studio-lobechat-next was called despite late TCP connection!"
fi
rm -f "$SANDBOX/ss-dynamic.txt"

echo "blue" > "$HTTP_CTRL_DIR/router_active_slot"
echo "true" > "$HTTP_CTRL_DIR/blue_draining"
rm -f "$SANDBOX/systemd-state/ops.log" "$SANDBOX/bg-checks.log" "$SANDBOX/pre-stop-hook.ran"
env "${COMMON_ENV[@]}" \
    MOCK_BG_CHECK_RESULT="QUIET" \
    MOCK_BG_COUNTER_FILE="$SANDBOX/bg-checks.log" \
    ENGINE_INIT_PRE_STOP_HOOK="echo ok > '$SANDBOX/pre-stop-hook.ran'" \
    bash "$FAKE_SRC/deploy-engine.sh" --init >/dev/null
[[ "$(cat "$HTTP_CTRL_DIR/blue_draining")" == "false" ]] || fail "#8: --init did not undrain blue slot!"
[[ -L "$SANDBOX/opt/lobechat-next" ]] || fail "#5: --init did not create $PROD symlink!"
[[ -f "$SANDBOX/etc/systemd/system/image-studio-lobechat-router.socket" ]] || fail "#13: --init did not install router .socket unit!"
[[ -f "$SANDBOX/opt/lobechat-next-router/engine-router-core.mjs" ]] || fail "v3 #2: --init did not install engine-router-core.mjs!"
[[ -f "$SANDBOX/pre-stop-hook.ran" ]] || fail "v3 #1: --init did not run ENGINE_INIT_PRE_STOP_HOOK!"
[[ "$(wc -l < "$SANDBOX/bg-checks.log")" -eq 3 ]] || fail "v3 #1: expected 3 quiet checks (initial + final double check), got $(wc -l < "$SANDBOX/bg-checks.log")!"
# Verify v3 #1 ordering: `enable` runs BEFORE `stop image-studio-lobechat-next`, and `start image-studio-lobechat-router.socket image-studio-lobechat-router` is the VERY NEXT systemctl call after `stop image-studio-lobechat-next`!
python3 - "$SANDBOX/systemd-state/ops.log" <<'PY' || fail "v3 #1: --init systemctl ordering around legacy stop violated!"
import sys
ops = [line.strip() for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
stop_idx = ops.index("stop image-studio-lobechat-next")
enable_router_idx = ops.index("enable image-studio-lobechat-router.socket image-studio-lobechat-router")
enable_blue_idx = ops.index("enable image-studio-lobechat@blue")
assert enable_blue_idx < stop_idx, f"enable blue ({enable_blue_idx}) must precede legacy stop ({stop_idx}): {ops}"
assert enable_router_idx < stop_idx, f"enable router ({enable_router_idx}) must precede legacy stop ({stop_idx}): {ops}"
assert ops[stop_idx + 1] == "start image-studio-lobechat-router.socket image-studio-lobechat-router", (
    f"Expected immediate router socket+service start right after legacy stop, got: {ops[stop_idx:stop_idx+3]}"
)
PY
pass "#4 + #5 + v3 #1 --init enforces double quietness, compressed cutover window, and exits 0 cleanly under set -u"

# =============================================================================
# TEST 4 (#13): `--status` exits 0 when routerHash matches, and NON-ZERO on routerHash MISMATCH!
# =============================================================================
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" --status >/dev/null
echo "0000000000000000000000000000000000000000000000000000000000000000" > "$HTTP_CTRL_DIR/router_hash"
mismatch_rc=0
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" --status >/dev/null 2>&1 || mismatch_rc=$?
[[ "$mismatch_rc" -ne 0 ]] || fail "#13: --status exited 0 despite routerHash MISMATCH!"
sha256sum "$FAKE_SRC/scripts/engine-router-core.mjs" | awk '{print $1}' > "$HTTP_CTRL_DIR/router_hash"
pass "#13 --status returns non-zero ($mismatch_rc) on routerHash mismatch"

# =============================================================================
# TEST 5 (#1): D-Bus / `systemctl show` error MUST yield `unknown` (abort deploy, NEVER treat as stopped!)
# =============================================================================
dbus_rc=0
env "${COMMON_ENV[@]}" ENGINE_DRAIN_MAX_WAIT_SEC=2 MOCK_SYSTEMCTL_DBUS_ERROR=1 bash "$FAKE_SRC/deploy-engine.sh" >/dev/null 2>&1 || dbus_rc=$?
[[ "$dbus_rc" -ne 0 ]] || fail "#1: deploy succeeded despite systemctl D-Bus error!"
pass "#1 systemctl D-Bus error treated as unknown and blocks slot stop/overwrite"

# =============================================================================
# TEST 6 (#6 + #7): Deploy to green, then deploy to blue waits for `retainedTopicIds` AND
# emergency revert preserves `.rollback-bak` so `--rollback` STILL succeeds!
# =============================================================================
# First normal deploy: blue -> green (creates confirmed commit 2 on green, previousConfirmed=blue)
(
    cd "$FAKE_SRC"
    echo "// commit 2" >> "$FAKE_SRC/.next/standalone/server.js"
    git commit -qam "release 2"
)
COMMIT_1=$(tr -d '[:space:]' < "$SANDBOX/opt/lobechat-next-blue/.deployed-commit")
echo "green" > "$HTTP_CTRL_DIR/router_active_slot"
echo "true" > "$HTTP_CTRL_DIR/green_draining"
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" >/dev/null
COMMIT_2=$(tr -d '[:space:]' < "$SANDBOX/opt/lobechat-next-green/.deployed-commit")
[[ "$(cat "$HTTP_CTRL_DIR/green_draining")" == "false" ]] || fail "#8: deploy did not undrain green!"

# Keep blue active in systemd with activeTotal=0 BUT retainedTopicIds=["tpc_keep_10m"], and clear it after 1.2s
echo "active" > "$SANDBOX/systemd-state/image-studio-lobechat@blue.active"
echo '["tpc_keep_10m"]' > "$HTTP_CTRL_DIR/blue_retained"
(
    sleep 1.2
    echo '[]' > "$HTTP_CTRL_DIR/blue_retained"
) &
MOCK_PIDS+=("$!")

# Now deploy release 3 onto blue, BUT simulate router :$PORT failing health check for blue -> triggers emergency revert!
(
    cd "$FAKE_SRC"
    echo "// broken release 3" >> "$FAKE_SRC/.next/standalone/server.js"
    git commit -qam "release 3 broken on router"
)
# Router keeps reporting activeSlot="green" (simulating :$PORT failing check_port_health for target="blue"!)
echo "green" > "$HTTP_CTRL_DIR/router_active_slot"

t_start=$(date +%s)
rev_rc=0
env "${COMMON_ENV[@]}" ENGINE_REPLAY_GRACE_SEC=10 bash "$FAKE_SRC/deploy-engine.sh" >/dev/null 2>&1 || rev_rc=$?
t_elapsed=$(( $(date +%s) - t_start ))

[[ "$rev_rc" -ne 0 ]] || fail "#7: failed switch returned exit code 0!"
(( t_elapsed >= 1 )) || fail "#6: wait_slot_idle_before_overwrite did not wait for retainedTopicIds to empty!"

# Verify #7: `$SLOT_BLUE_DIR/.deployed-commit` was RESTORED to COMMIT_1 from `.rollback-bak` (NOT wiped and NOT left at broken release 3)!
RESTORED_BLUE_COMMIT=$(tr -d '[:space:]' < "$SANDBOX/opt/lobechat-next-blue/.deployed-commit")
[[ "$RESTORED_BLUE_COMMIT" == "$COMMIT_1" ]] || fail "#7: expected restored blue commit $COMMIT_1, got $RESTORED_BLUE_COMMIT!"

# And verify `--rollback` from green -> blue SUCCEEDS right after that emergency revert!
echo "blue" > "$HTTP_CTRL_DIR/router_active_slot"
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" --rollback >/dev/null
ACTIVE_AFTER_RB=$(python3 -c "import json; print(json.load(open('$SANDBOX/var/lib/lobechat-engine/state.json'))['activeSlot'])")
[[ "$ACTIVE_AFTER_RB" == "blue" ]] || fail "#7: --rollback after emergency revert failed (activeSlot=$ACTIVE_AFTER_RB)!"
pass "#6 + #7 retainedTopicIds replay window respected & .rollback-bak restored so --rollback works"

# =============================================================================
# TEST 7 (v3 #2): Updating `scripts/engine-router-core.mjs` hot-reloads via `SIGHUP` ONLY (ZERO `systemctl restart`!)
# =============================================================================
rm -f "$SANDBOX/systemd-state/restarted.log" "$SANDBOX/systemd-state/reloaded.log"
echo '[]' > "$HTTP_CTRL_DIR/green_retained"
echo "0" > "$HTTP_CTRL_DIR/green_active"
(
    cd "$FAKE_SRC"
    echo "// hot-reload router core v2" >> "$FAKE_SRC/scripts/engine-router-core.mjs"
    git commit -qam "update engine-router-core.mjs"
)
NEW_CORE_HASH=$(sha256sum "$FAKE_SRC/scripts/engine-router-core.mjs" | awk '{print $1}')

# 7a. If router refuses to update routerHash on SIGHUP (simulating syntax error), deploy aborts cleanly before switching!
frozen_rc=0
env "${COMMON_ENV[@]}" MOCK_FREEZE_ROUTER_HASH=1 bash "$FAKE_SRC/deploy-engine.sh" >/dev/null 2>&1 || frozen_rc=$?
[[ "$frozen_rc" -ne 0 ]] || fail "v3 #2: deploy succeeded even when routerHash failed to update on SIGHUP!"
[[ ! -s "$SANDBOX/systemd-state/restarted.log" ]] || fail "v3 #2: deploy called systemctl restart on router!"

# 7b. Normal SIGHUP hot-reload updates routerHash in /__router/health with ZERO `systemctl restart`!
echo "green" > "$HTTP_CTRL_DIR/router_active_slot"
env "${COMMON_ENV[@]}" bash "$FAKE_SRC/deploy-engine.sh" >/dev/null
[[ ! -s "$SANDBOX/systemd-state/restarted.log" ]] || fail "v3 #2: cmd_deploy invoked systemctl restart: $(cat "$SANDBOX/systemd-state/restarted.log")!"
grep -q "image-studio-lobechat-router" "$SANDBOX/systemd-state/reloaded.log" || fail "v3 #2: router did not receive SIGHUP reload!"
[[ "$(cat "$HTTP_CTRL_DIR/router_hash")" == "$NEW_CORE_HASH" ]] || fail "v3 #2: routerHash did not update to $NEW_CORE_HASH!"
pass "v3 #2 router code update hot-reloads via SIGHUP with ZERO systemctl restart and verifies routerHash"

echo "[shell-test] ALL DEPLOY-ENGINE SHELL INVARIANTS PASSED!"
