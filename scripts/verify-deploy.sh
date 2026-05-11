#!/bin/bash
# LobeChat deploy verification script
# Run after: bun run build + rsync .next/ + rsync public/_spa/ + systemctl restart

set -e

SRC_BUILD_ID=$(cat /opt/lobechat-src/.next/BUILD_ID 2>/dev/null || echo "MISSING")
PROD_BUILD_ID=$(cat /opt/lobechat/.next/BUILD_ID 2>/dev/null || echo "MISSING")

echo "=== LobeChat Deploy Verification ==="
echo "Source BUILD_ID:  $SRC_BUILD_ID"
echo "Prod BUILD_ID:    $PROD_BUILD_ID"

if [ "$SRC_BUILD_ID" != "$PROD_BUILD_ID" ]; then
    echo "FAIL: BUILD_ID mismatch. Prod has stale build."
    exit 1
fi

echo "PASS: BUILD_ID matches"

# Check newest SPA asset is present in prod
NEWEST_SPA=$(ls -t /opt/lobechat/public/_spa/assets/index-*.js 2>/dev/null | head -1)
if [ -z "$NEWEST_SPA" ]; then
    echo "FAIL: No SPA assets found in prod"
    exit 1
fi

echo "PASS: SPA assets present ($NEWEST_SPA)"

# Check service is active
if ! systemctl is-active --quiet image-studio-lobechat; then
    echo "FAIL: image-studio-lobechat is not active"
    exit 1
fi

echo "PASS: service is active"

# HTTP check
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" https://chat.arckep.ru/ || echo "000")
if [ "$HTTP_CODE" != "302" ]; then
    echo "WARN: HTTP $HTTP_CODE (expected 302 for anonymous)"
else
    echo "PASS: HTTP 302"
fi

# Check for old chunk references in SSR templates (should be none)
OLD_CHUNK_COUNT=$(grep -r "index-B-JPocvJ\|index-CgozgQaS" /opt/lobechat/.next/server/ 2>/dev/null | wc -l)
if [ "$OLD_CHUNK_COUNT" -gt 0 ]; then
    echo "WARN: $OLD_CHUNK_COUNT references to old chunks in .next/server/"
else
    echo "PASS: no stale chunk references in SSR templates"
fi

# Check proxy/EPROTO errors in log since last start
START_TIME=$(systemctl show image-studio-lobechat --property=ActiveEnterTimestamp --value)
# Convert to journalctl format
ERRORS=$(journalctl -u image-studio-lobechat --since "$START_TIME" --no-pager 2>/dev/null | grep -cE "Failed to proxy|EPROTO" || true)
if [ "$ERRORS" -gt 0 ]; then
    echo "WARN: $ERRORS proxy/EPROTO errors since restart"
else
    echo "PASS: no proxy/EPROTO errors since restart"
fi

echo "=== Verification complete ==="
