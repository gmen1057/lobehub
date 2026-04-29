#!/bin/bash
# LobeChat health check script
# Checks service health and exits 0 (healthy) or 1 (unhealthy)
# Prints OK or specific failure reason

SERVICE="image-studio-lobechat"
PORT=3402
MEM_LIMIT_MB=1024
ERROR_THRESHOLD=10
ERROR_WINDOW_MIN=5

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAILED=0

fail() {
    echo -e "${RED}FAIL${NC}: $1"
    FAILED=1
}

warn() {
    echo -e "${YELLOW}WARN${NC}: $1"
}

ok() {
    echo -e "${GREEN}OK${NC}: $1"
}

# 1. Check systemd service is active
if systemctl is-active --quiet "$SERVICE"; then
    ok "Service $SERVICE is active"
else
    fail "Service $SERVICE is not active ($(systemctl is-active $SERVICE))"
fi

# 2. Check HTTP responds with 200 or 302 on localhost:PORT
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${PORT}/")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "307" ]; then
    ok "HTTP responds on localhost:${PORT} (HTTP ${HTTP_CODE})"
else
    fail "HTTP on localhost:${PORT} returned HTTP ${HTTP_CODE} (expected 200/302)"
fi

# 3. Check bridge endpoint rejects unauthenticated requests (401 or redirect to login)
BRIDGE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:${PORT}/api/bridge")
if [ "$BRIDGE_CODE" = "401" ] || [ "$BRIDGE_CODE" = "302" ] || [ "$BRIDGE_CODE" = "307" ]; then
    ok "Bridge endpoint rejects unauthenticated requests (HTTP ${BRIDGE_CODE})"
else
    fail "Bridge endpoint returned HTTP ${BRIDGE_CODE} (expected 401 or redirect)"
fi

# 4. Check memory usage < 1GB
MAIN_PID=$(systemctl show -p MainPID --value "$SERVICE" 2>/dev/null)
if [ -n "$MAIN_PID" ] && [ "$MAIN_PID" != "0" ]; then
    # Sum RSS of main process and all its children (in kB)
    MEM_KB=$(ps --ppid "$MAIN_PID" -p "$MAIN_PID" -o rss= 2>/dev/null | awk '{sum+=$1} END{print sum+0}')
    MEM_MB=$((MEM_KB / 1024))
    if [ "$MEM_MB" -lt "$MEM_LIMIT_MB" ]; then
        ok "Memory usage: ${MEM_MB}MB < ${MEM_LIMIT_MB}MB limit"
    else
        fail "Memory usage: ${MEM_MB}MB exceeds ${MEM_LIMIT_MB}MB limit"
    fi
else
    warn "Could not determine PID for memory check"
fi

# 5. Check no OOM kills of THIS service in last 5 minutes.
# Match by cgroup (task_memcg=/system.slice/image-studio-lobechat.service) — global
# OOM events from unrelated processes must not trigger a restart.
OOM_COUNT=$(journalctl -k --since "${ERROR_WINDOW_MIN} minutes ago" 2>/dev/null | \
    grep -ic "task_memcg=/system\.slice/${SERVICE}\.service" || true)
if [ "$OOM_COUNT" -eq 0 ]; then
    ok "No OOM kills of ${SERVICE} in the last ${ERROR_WINDOW_MIN}min"
else
    fail "Found ${OOM_COUNT} OOM kill event(s) of ${SERVICE} in the last ${ERROR_WINDOW_MIN}min"
fi

# 6. Check error count in service logs < 10 in last 5 minutes
ERROR_COUNT=$(journalctl -u "$SERVICE" --since "${ERROR_WINDOW_MIN} minutes ago" 2>/dev/null | \
    grep -ciE '(error|Error|ERROR|exception|Exception|EXCEPTION|unhandledRejection|UnhandledPromise)' || true)
if [ "$ERROR_COUNT" -lt "$ERROR_THRESHOLD" ]; then
    ok "Error count in last ${ERROR_WINDOW_MIN}min: ${ERROR_COUNT} (< ${ERROR_THRESHOLD} threshold)"
else
    fail "Error count in last ${ERROR_WINDOW_MIN}min: ${ERROR_COUNT} (>= ${ERROR_THRESHOLD} threshold)"
fi

# Final result
echo ""
if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}OK${NC} — LobeChat is healthy"
    exit 0
else
    echo -e "${RED}UNHEALTHY${NC} — LobeChat has failures (see above)"
    exit 1
fi
