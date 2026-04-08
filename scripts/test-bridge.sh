#!/bin/bash
# Post-deploy bridge test
# Verifies bridge auth flow works end-to-end
#
# Usage: ./scripts/test-bridge.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ERRORS=0
BASE="http://127.0.0.1:3402"

echo "=== Bridge Auth Test ==="

# Test 1: Bridge without X-User-Id returns 401
echo -n "1. Bridge rejects missing X-User-Id... "
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/bridge")
if [ "$CODE" = "401" ]; then
    echo -e "${GREEN}OK${NC} (HTTP $CODE)"
else
    echo -e "${RED}FAIL${NC} (HTTP $CODE, expected 401)"
    ERRORS=$((ERRORS + 1))
fi

# Test 2: Bridge with X-User-Id returns redirect (302)
echo -n "2. Bridge with X-User-Id returns redirect... "
CODE=$(curl -s -o /dev/null -w "%{http_code}" -H "X-User-Id: 999999" "$BASE/api/bridge")
if [ "$CODE" = "302" ] || [ "$CODE" = "307" ]; then
    echo -e "${GREEN}OK${NC} (HTTP $CODE)"
else
    echo -e "${RED}FAIL${NC} (HTTP $CODE, expected 302/307)"
    ERRORS=$((ERRORS + 1))
fi

# Test 3: Bridge sets session cookie
echo -n "3. Bridge sets session cookie... "
HEADERS=$(curl -s -D - -o /dev/null -H "X-User-Id: 999999" "$BASE/api/bridge" 2>/dev/null)
if echo "$HEADERS" | grep -qi "better-auth.session_token"; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}FAIL${NC} — no session cookie in response"
    ERRORS=$((ERRORS + 1))
fi

# Test 4: Validate endpoint works (our backend)
echo -n "4. Validate endpoint responds... "
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8202/api/auth/validate")
if [ "$CODE" = "401" ]; then
    echo -e "${GREEN}OK${NC} (HTTP 401 without token — correct)"
else
    echo -e "${RED}FAIL${NC} (HTTP $CODE)"
    ERRORS=$((ERRORS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All bridge tests passed.${NC}"
    exit 0
else
    echo -e "${RED}${ERRORS} test(s) failed.${NC}"
    exit 1
fi
