#!/bin/bash
# validate-setup.sh - Validate Archon CLI configuration
#
# Usage: ./scripts/validate-setup.sh

set -e

echo "Archon CLI Setup Validator"
echo "=========================="
echo ""

ERRORS=0
WARNINGS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

check_pass() { echo -e "${GREEN}✓${NC} $1"; }
check_fail() { echo -e "${RED}✗${NC} $1"; ((ERRORS++)); }
check_warn() { echo -e "${YELLOW}!${NC} $1"; ((WARNINGS++)); }

# AI Assistants
echo "AI Assistants"
echo "-------------"

if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$CLAUDE_API_KEY" ]; then
  check_pass "Claude credentials configured"
else
  check_warn "Claude credentials not found"
fi

if [ -n "$CODEX_ID_TOKEN" ] && [ -n "$CODEX_ACCESS_TOKEN" ]; then
  check_pass "Codex credentials configured"
else
  check_warn "Codex credentials not found"
fi

if [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$CLAUDE_API_KEY" ] && [ -z "$CODEX_ID_TOKEN" ]; then
  check_fail "No AI assistant credentials found (need at least one)"
fi

# Archon paths
echo ""
echo "Archon Paths"
echo "------------"

ARCHON_HOME="${ARCHON_HOME:-$HOME/.archon}"
echo "  Home: $ARCHON_HOME"

if [ -d "$ARCHON_HOME" ]; then
  check_pass "Archon home directory exists"
  if [ -f "$ARCHON_HOME/config.yaml" ]; then
    check_pass "Global config exists ($ARCHON_HOME/config.yaml)"
  else
    check_warn "Global config will be created on first run"
  fi
else
  check_warn "Archon home directory will be created on first run"
fi

# Summary
echo ""
echo "=========================="
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}Validation failed with $ERRORS error(s) and $WARNINGS warning(s)${NC}"
  exit 1
elif [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}Validation passed with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${GREEN}All checks passed!${NC}"
  echo ""
  echo "Run: bun run cli --help"
  exit 0
fi
