#!/bin/bash
# Post-deploy verification script for LobeChat
# Runs after ./deploy.sh or manual deploy to confirm everything is working
#
# Usage: ./scripts/post-deploy-verify.sh

SERVICE="image-studio-lobechat"
PORT=3402
EXTERNAL_URL="https://chat.arckep.ru"
SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ERRORS=0

pass() {
    echo -e "  ${GREEN}✓${NC} $1"
}

fail() {
    echo -e "  ${RED}✗${NC} $1"
    ERRORS=$((ERRORS + 1))
}

warn() {
    echo -e "  ${YELLOW}!${NC} $1"
}

section() {
    echo ""
    echo -e "${BOLD}$1${NC}"
}

echo -e "${BOLD}=== LobeChat Post-Deploy Verification ===${NC}"
echo "Service: $SERVICE | Port: $PORT"
echo "$(date)"

# ── 1. Service running ────────────────────────────────────────────────────────
section "1. Service status"
if systemctl is-active --quiet "$SERVICE"; then
    ACTIVE_STATE=$(systemctl show -p ActiveState --value "$SERVICE")
    pass "Service is running (state: $ACTIVE_STATE)"
else
    fail "Service is NOT running ($(systemctl is-active $SERVICE))"
    echo -e "  ${YELLOW}Hint:${NC} systemctl status $SERVICE"
fi

# ── 2. HTTP on localhost ──────────────────────────────────────────────────────
section "2. HTTP on localhost:${PORT}"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}/")
if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "302" ] || [ "$HTTP_CODE" = "307" ]; then
    pass "HTTP responds (HTTP ${HTTP_CODE})"
else
    fail "HTTP returned ${HTTP_CODE} (expected 200/302)"
fi

# ── 3. Bridge tests ───────────────────────────────────────────────────────────
section "3. Bridge auth tests"
if [ -f "$SCRIPTS_DIR/test-bridge.sh" ]; then
    # Run bridge tests, capture output, show indented
    BRIDGE_OUTPUT=$("$SCRIPTS_DIR/test-bridge.sh" 2>&1)
    BRIDGE_EXIT=$?
    # Indent each line
    echo "$BRIDGE_OUTPUT" | while IFS= read -r line; do
        echo "  $line"
    done
    if [ $BRIDGE_EXIT -eq 0 ]; then
        pass "All bridge tests passed"
    else
        fail "Bridge tests failed (exit code $BRIDGE_EXIT)"
    fi
else
    warn "test-bridge.sh not found at $SCRIPTS_DIR/test-bridge.sh, skipping"
fi

# ── 4. API version endpoint ───────────────────────────────────────────────────
section "4. API version endpoint"
VERSION_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}/api/version")
if [ "$VERSION_CODE" = "200" ]; then
    VERSION_BODY=$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null | head -c 200)
    pass "/api/version returns 200: $VERSION_BODY"
else
    fail "/api/version returned HTTP ${VERSION_CODE} (expected 200)"
fi

# ── 5. Static assets ──────────────────────────────────────────────────────────
section "5. Static assets"
FAVICON_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${PORT}/favicon.ico")
if [ "$FAVICON_CODE" = "200" ]; then
    pass "/favicon.ico returns 200"
else
    fail "/favicon.ico returned HTTP ${FAVICON_CODE} (expected 200)"
fi

# ── 6. No crash loop (uptime > 30s) ──────────────────────────────────────────
section "6. Crash loop check"
ACTIVE_ENTER=$(systemctl show -p ActiveEnterTimestampMonotonic --value "$SERVICE" 2>/dev/null)
if [ -n "$ACTIVE_ENTER" ] && [ "$ACTIVE_ENTER" != "0" ]; then
    # Get current monotonic time (uptime in seconds)
    UPTIME_SEC=$(awk '{print int($1)}' /proc/uptime)
    # ActiveEnterTimestampMonotonic is in microseconds
    ENTER_SEC=$((ACTIVE_ENTER / 1000000))
    SERVICE_UPTIME=$((UPTIME_SEC - ENTER_SEC))
    if [ "$SERVICE_UPTIME" -gt 30 ]; then
        pass "Service uptime: ${SERVICE_UPTIME}s (> 30s, no crash loop)"
    else
        fail "Service uptime: ${SERVICE_UPTIME}s (< 30s, possible crash loop)"
    fi
else
    # Fallback: check ActiveEnterTimestamp (wall clock)
    ENTER_TS=$(systemctl show -p ActiveEnterTimestamp --value "$SERVICE" 2>/dev/null)
    if [ -n "$ENTER_TS" ] && [ "$ENTER_TS" != "n/a" ]; then
        ENTER_EPOCH=$(date -d "$ENTER_TS" +%s 2>/dev/null || echo 0)
        NOW_EPOCH=$(date +%s)
        SERVICE_UPTIME=$((NOW_EPOCH - ENTER_EPOCH))
        if [ "$SERVICE_UPTIME" -gt 30 ]; then
            pass "Service uptime: ${SERVICE_UPTIME}s (> 30s, no crash loop)"
        else
            fail "Service uptime: ${SERVICE_UPTIME}s (< 30s, possible crash loop)"
        fi
    else
        warn "Could not determine service uptime"
    fi
fi

# ── 7. External HTTPS ─────────────────────────────────────────────────────────
section "7. External HTTPS (${EXTERNAL_URL})"
EXT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${EXTERNAL_URL}/api/version")
if [ "$EXT_CODE" = "200" ]; then
    pass "${EXTERNAL_URL}/api/version returns 200"
else
    fail "${EXTERNAL_URL}/api/version returned HTTP ${EXT_CODE} (expected 200)"
    warn "Check nginx config: /etc/nginx/sites-enabled/chat.arckep.ru"
fi

# ── 8. Billing proxy reachable ────────────────────────────────────────────────
section "8. Billing proxy endpoint"
# POST without body should return an error (4xx), NOT 404
BILLING_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST "http://127.0.0.1:${PORT}/api/billing-proxy/openai" \
    -H "Content-Type: application/json")
if [ "$BILLING_CODE" != "404" ] && [ "$BILLING_CODE" != "000" ]; then
    pass "Billing proxy endpoint exists (HTTP ${BILLING_CODE} — not 404)"
else
    if [ "$BILLING_CODE" = "000" ]; then
        fail "Billing proxy: connection failed (service may be down)"
    else
        fail "Billing proxy returned 404 — endpoint not registered"
    fi
fi

# ── Final summary ─────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${GREEN}${BOLD}All checks passed.${NC} LobeChat is ready."
    exit 0
else
    echo -e "${RED}${BOLD}${ERRORS} check(s) failed.${NC} Review output above."
    echo ""
    echo "Useful commands:"
    echo "  systemctl status $SERVICE"
    echo "  journalctl -u $SERVICE -n 50"
    echo "  nginx -t && systemctl reload nginx"
    exit 1
fi
