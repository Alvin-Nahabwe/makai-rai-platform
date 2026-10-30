#!/usr/bin/env bash
# Runs the build, and builds again when, and only when, the build failed on Google's font stylesheet.
#
#   scripts/ci/build-retrying-font.sh [build command...]      default: npm run build
#
# Cause (CI run 41073773967, the e2e job): Google's stylesheet for Source Sans 3 sometimes carries a font file URL with
# `&` in it, which Turbopack 16.4.2 splits at the `&`, and the build stops with
# "next/font/google queries have exactly one entry", once for every @font-face rule, though nothing in the repository
# changed. It happens on Google's side. The real fix (local font files) waits for the owner's approval of them; this is the
# stop-gap, and app/layout.tsx is not touched.
#
# When the build fails and its output holds that line, `.next` is deleted (Turbopack's cache may be replaying the bad
# stylesheet) and the build runs again, at most twice more, printing each retry. Any other failure, and a failure with
# the signature on the last try, ends with the build's own exit status at once. Everything the build prints goes to this
# script's stdout, so a caller's `| tee test-results/build.log` records every attempt and `set -o pipefail` there carries
# the exit status out. `set -e` is deliberately off: a failed build is data here, not a reason to stop.
set -uo pipefail

SIGNATURE='next/font/google queries have exactly one entry'
MAX_RETRIES=2

if [ "$#" -gt 0 ]; then
  BUILD=("$@")
else
  BUILD=(npm run build)
fi

attempt_log="$(mktemp)"
trap 'rm -f "$attempt_log"' EXIT

retries=0
while :; do
  "${BUILD[@]}" 2>&1 | tee "$attempt_log"
  status="${PIPESTATUS[0]}"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  # grep without -q: it reads the whole file, so nothing upstream is left writing to a closed pipe.
  if ! grep -F "$SIGNATURE" "$attempt_log" > /dev/null; then
    exit "$status"
  fi
  if [ "$retries" -ge "$MAX_RETRIES" ]; then
    echo "build-retrying-font: the build failed with the next/font/google signature on all $((retries + 1)) tries; giving up" >&2
    exit "$status"
  fi
  retries=$((retries + 1))
  echo "build-retrying-font: the build failed with the next/font/google signature; deleting .next and building again (retry ${retries} of ${MAX_RETRIES})" >&2
  rm -rf .next
done
