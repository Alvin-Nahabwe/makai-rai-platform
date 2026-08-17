#!/usr/bin/env bash
# Mechanical coverage check for the 2026-08-17 audit -> plan mapping.
#
# WHY THIS EXISTS: the revised plan (docs/planning/2026-08-17-revised-vision-and-plan.md)
# claims every post-verification Critical/High audit finding has a home in a phase. That
# claim was FIRST WRITTEN BY HAND and an adversarial reviewer found four confirmed Highs
# silently missing (ENG-02, ENG-03, EV-2, T-01) -- the "hand-written list that must be
# complete" failure AGENTS.md 3 names. This script is the generated replacement.
#
# Run it after ANY edit to the plan's phase contents. Exit 1 means a finding lost its home.
#
# Note: two audit dimensions share the DEP- prefix. deployment-ops uses zero-padded
# DEP-01..DEP-15; dependency-platform uses DEP-1..DEP-11. Padding is significant.
set -euo pipefail
cd "$(dirname "$0")/.."

APPENDIX=docs/audits/2026-08-17-full-platform-audit-appendix.md
PLAN=docs/planning/2026-08-17-revised-vision-and-plan.md
for f in "$APPENDIX" "$PLAN"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }
done

# Severities in the appendix are POST-verification (corrected severities already applied).
CH=$(grep -oE '^### [A-Z]+-[0-9]+ \[(Critical|High)\]' "$APPENDIX" \
     | sed -E 's/^### ([A-Z]+-[0-9]+).*/\1/' | sort -u)
PLAN_IDS=$(grep -oE '\b[A-Z]+-[0-9]+\b' "$PLAN" | sort -u)

MISSING=$(comm -23 <(echo "$CH") <(echo "$PLAN_IDS"))
TOTAL=$(echo "$CH" | grep -c . || true)

if [ -n "$MISSING" ]; then
  echo "FAIL: $(echo "$MISSING" | grep -c .) of $TOTAL Critical/High findings have no home in the plan:"
  echo "$MISSING" | sed 's/^/  /'
  exit 1
fi
echo "OK: all $TOTAL post-verification Critical/High findings are cited in the plan."
