#!/usr/bin/env bash
# OpenClaw Command Center — Smoke Test Suite
# Validates P0/P1/P2 fixes against a running agent-chat-server
# Usage: ./smoke-test.sh [base_url]

set -euo pipefail

BASE="${1:-http://127.0.0.1:18790}"
PASS=0; FAIL=0; TOTAL=0

red() { printf "\033[31m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
bold() { printf "\033[1m%s\033[0m" "$1"; }

check() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    PASS=$((PASS + 1))
    printf "  %-50s %s\n" "$name" "$(green PASS)"
  else
    FAIL=$((FAIL + 1))
    printf "  %-50s %s (expected=%s got=%s)\n" "$name" "$(red FAIL)" "$expected" "$actual"
  fi
}

check_contains() {
  local name="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -q "$needle"; then
    PASS=$((PASS + 1))
    printf "  %-50s %s\n" "$name" "$(green PASS)"
  else
    FAIL=$((FAIL + 1))
    printf "  %-50s %s (missing: %s)\n" "$name" "$(red FAIL)" "$needle"
  fi
}

echo ""
bold "=== OpenClaw Command Center Smoke Tests ==="; echo ""
echo "Target: $BASE"
echo ""

# --- P0: Core endpoints ---
bold "P0: Core Endpoints"; echo ""

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/status")
check "GET /api/status" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/metrics")
check "GET /api/metrics" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/timeline")
check "GET /api/timeline" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/slos")
check "GET /api/slos" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/kanban" -H "x-role: viewer")
check "GET /api/kanban (viewer)" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/agents")
check "GET /api/agents" "200" "$HTTP"

# --- P0: RBAC enforcement ---
echo ""
bold "P0: RBAC Enforcement"; echo ""

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/messages" \
  -H "Content-Type: application/json" -d '{"agentId":"test","content":"smoke"}')
check "POST /api/messages without x-role → 403" "403" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/messages" \
  -H "Content-Type: application/json" -H "x-role: viewer" -d '{"agentId":"test","content":"smoke"}')
check "POST /api/messages with viewer → 403" "403" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/messages" \
  -H "Content-Type: application/json" -H "x-role: admin" -d '{"agentId":"test","content":"smoke"}')
# Should reach handler (400 or 502 depending on agent availability)
if [ "$HTTP" = "400" ] || [ "$HTTP" = "502" ]; then
  check "POST /api/messages with admin → handler" "reached" "reached"
else
  check "POST /api/messages with admin → handler" "400|502" "$HTTP"
fi

# --- P0: Gateway status ---
echo ""
bold "P0: Gateway Status"; echo ""

BODY=$(curl -s "$BASE/api/status")
check_contains "Gateway reachable=true" '"reachable": true' "$BODY"
check_contains "Gateway has latencyMs" '"latencyMs"' "$BODY"

# --- P0: Timeline ---
echo ""
bold "P0: Timeline"; echo ""

BODY=$(curl -s "$BASE/api/timeline")
check_contains "Timeline has events array" '"events"' "$BODY"

# --- P1: RBAC Granular (Kanban) ---
echo ""
bold "P1: RBAC Kanban Granular"; echo ""

# Create a temp task
TASK_BODY=$(curl -s -X POST "$BASE/api/kanban/tasks" \
  -H "Content-Type: application/json" -H "x-role: admin" \
  -d '{"title":"smoke-test-temp","owner":"smoke","priority":"P2"}')
TASK_ID=$(echo "$TASK_BODY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

if [ -n "$TASK_ID" ]; then
  # Move to execucao
  curl -s -o /dev/null -X POST "$BASE/api/kanban/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" -H "x-role: admin" -d '{"column":"execucao"}'
  # Move to qa_gate
  curl -s -o /dev/null -X POST "$BASE/api/kanban/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" -H "x-role: admin" -d '{"column":"qa_gate"}'
  # Add evidence
  curl -s -o /dev/null -X POST "$BASE/api/kanban/tasks/$TASK_ID/evidence" \
    -H "Content-Type: application/json" -H "x-role: admin" -d '{"evidence":"smoke"}'
  # Operator cannot approve
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kanban/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" -H "x-role: operator" -d '{"column":"aprovado"}')
  check "Operator approve Kanban → 403" "403" "$HTTP"
  # Admin can approve
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/kanban/tasks/$TASK_ID/move" \
    -H "Content-Type: application/json" -H "x-role: admin" -d '{"column":"aprovado"}')
  check "Admin approve Kanban → 200" "200" "$HTTP"
else
  TOTAL=$((TOTAL + 2)); FAIL=$((FAIL + 2))
  printf "  %-50s %s\n" "Kanban task creation" "$(red 'FAIL (could not create task)')"
fi

# --- P1: Observability ---
echo ""
bold "P1: Observability"; echo ""

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/observability")
check "GET /api/observability" "200" "$HTTP"

BODY=$(curl -s "$BASE/api/observability")
check_contains "Observability has server.uptime" '"uptime"' "$BODY"

# --- P2: Observability History ---
echo ""
bold "P2: Observability History"; echo ""

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/observability/history")
check "GET /api/observability/history" "200" "$HTTP"

BODY=$(curl -s "$BASE/api/observability/history")
check_contains "History has entries array" '"entries"' "$BODY"

# --- P2: System endpoint ---
echo ""
bold "Bonus: System Metrics"; echo ""

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/system")
check "GET /api/system" "200" "$HTTP"

# --- Summary ---
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -eq 0 ]; then
  printf "  Result: %s  (%d/%d passed)\n" "$(green 'ALL PASS')" "$PASS" "$TOTAL"
else
  printf "  Result: %s  (%d passed, %d failed out of %d)\n" "$(red 'FAILURES')" "$PASS" "$FAIL" "$TOTAL"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

exit $FAIL
