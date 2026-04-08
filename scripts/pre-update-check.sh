#!/bin/bash
# Pre-update check for LobeChat
# Run BEFORE building after git pull/merge to verify our customizations still work
#
# Checks:
# 1. Bridge dependency: auth.api.signInEmail / signUpEmail
# 2. Public routes matcher location (where we add /api/bridge)
# 3. Bridge route file exists
#
# Usage: ./scripts/pre-update-check.sh
# Exit code: 0 = safe to build, 1 = needs attention

set -e
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "=== LobeChat Pre-Update Check ==="
echo "Verified on: v2.1.46 (2026-04-08)"
echo ""

# Check 1: Better Auth signInEmail API exists
echo -n "1. Better Auth signInEmail API... "
if grep -rq "sign-in/email\|signInEmail" node_modules/better-auth/dist/ --include='*.mjs' 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}MISSING${NC} — Better Auth API changed, bridge will break"
    ERRORS=$((ERRORS + 1))
fi

# Check 2: Better Auth signUpEmail API exists
echo -n "2. Better Auth signUpEmail API... "
if grep -rq "sign-up/email\|signUpEmail" node_modules/better-auth/dist/ --include='*.mjs' 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}MISSING${NC} — Better Auth API changed, bridge will break"
    ERRORS=$((ERRORS + 1))
fi

# Check 3: createRouteMatcher exists in define-config.ts
echo -n "3. createRouteMatcher in proxy config... "
if grep -q "createRouteMatcher" src/libs/next/proxy/define-config.ts 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}MISSING${NC} — middleware structure changed, /api/bridge route may not be public"
    ERRORS=$((ERRORS + 1))
fi

# Check 4: Our bridge route added to public routes
echo -n "4. /api/bridge in public routes... "
if grep -q "api/bridge" src/libs/next/proxy/define-config.ts 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${YELLOW}MISSING${NC} — need to add '/api/bridge' to isPublicRoute in define-config.ts"
    ERRORS=$((ERRORS + 1))
fi

# Check 5: Bridge route file exists
echo -n "5. Bridge route file... "
if [ -f "src/app/(backend)/api/bridge/route.ts" ]; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}MISSING${NC} — bridge route file deleted or moved"
    ERRORS=$((ERRORS + 1))
fi

# Check 6: auth import path in bridge
echo -n "6. Auth import path (@/auth)... "
if [ -f "src/auth.ts" ] || [ -f "src/auth.tsx" ]; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${YELLOW}CHANGED${NC} — auth module may have moved"
    ERRORS=$((ERRORS + 1))
fi

# Check 7: middleware redirect location still patchable
echo -n "7. Middleware signin redirect patchable... "
if grep -q "isProtected" src/libs/next/proxy/define-config.ts 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}MISSING${NC} — middleware structure changed, bridge redirect patch may break"
    ERRORS=$((ERRORS + 1))
fi

# Check 8: our middleware patch present (arckep bridge redirect)
echo -n "8. Bridge redirect in middleware... "
if grep -q "arckep_token" src/libs/next/proxy/define-config.ts 2>/dev/null; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${YELLOW}MISSING${NC} — need to re-apply arckep bridge redirect in define-config.ts"
    ERRORS=$((ERRORS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}All checks passed. Safe to build.${NC}"
    exit 0
else
    echo -e "${RED}${ERRORS} check(s) failed. Review before building.${NC}"
    exit 1
fi
