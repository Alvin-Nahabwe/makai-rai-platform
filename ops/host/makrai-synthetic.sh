#!/usr/bin/env bash
# /usr/local/sbin/makrai-synthetic.sh
# The hourly synthetic journey (RL 2.3, Tasks 20 and 20b; published as "syntheticJourneyInterval":
# "PT1H", G2-22): sign in to https://makrai.org as the synthetic account, save its in-progress
# assessment and read it back. Runs from root's crontab at 7 past every hour, because GitHub's
# `schedule` is best-effort (hours late, sometimes dropped) and this one is a published commitment.
#
#   makrai-synthetic.sh --ping   cron: one ping to HC_SYNTHETIC_PING_URL, or /fail
#   makrai-synthetic.sh          by hand: the same journey, no ping (a manual run says
#                                nothing about whether the schedule is alive)
#
# Exit status: 0 the journey passed; 2 bad arguments; 130 stopped by a signal; anything else it did
# not pass: 1, or 124 / 137 when the last attempt ran out of time (137 when the kill was needed).
# The last line printed is `result=pass|fail at=<UTC time>`, after anything the ping printed:
# root's crontab appends both streams to /var/log/makrai/synthetic.log, whose last line is the
# evidence.
#
# The journey is scripts/synthetic-journey.mjs, root's installed copy in /usr/local/lib/makrai,
# run by node in the image the live web container is running (its image ID, always present
# locally, so no pull and no race with D2's set_env-then-pull), in a throwaway container:
# read-only root, no capabilities, the default bridge (internet, not the stack's network), no
# log driver. The request leaves the host and comes back through Cloudflare like anyone's.
# It prints `step=<name> status=<code>` and nothing else; so does this script.
#
# A failed attempt is tried once more after RETRY_AFTER seconds: a container swap in D2 step 5,
# or an engine restart, is a single-sample failure that healthchecks would otherwise alert on at
# once. Both attempts are logged, so a fault that clears on retry is still on record.
#
# One run at a time. A run that finds the lock taken says so and waits for it, up to 500 seconds,
# which is longer than the longest run: per attempt, docker inspect 30, docker run 120 + 10 to be
# killed, docker rm 30 (190); two attempts (380); the pause (60); and the ping, whose curl gives
# up after 4 tries of 10 seconds and 7 seconds of waiting between them (47): 487. So a hand run
# that overlaps 7 past delays the cron run and never makes it send /fail. Every docker call is
# bounded, so a wedged daemon is a /fail within minutes, not silence. Only a run that holds the lock
# removes the container (a run that is waiting, or was stopped while waiting, must not remove the
# container of the one that holds it).
#
# Needs, in the server .env (read as text, never run: T22-3): SYNTHETIC_EMAIL, SYNTHETIC_PASSWORD,
# SYNTHETIC_ORG_SLUG, SYNTHETIC_ASSESSMENT_ID, HC_SYNTHETIC_PING_URL; and, in /usr/local/lib/makrai,
# synthetic-journey.mjs, installed from the stage (ops/host/README.md, "Hourly synthetic journey").
set -Eeuo pipefail
cd /
umask 077

# Fixed before .env is read and read-only, so a line in .env cannot move them. BASE_URL is never
# read from .env: the password goes to this origin and no other, whatever a line in a file the
# operator account can write says. Root's copy of the journey, never the operator's checkout
# (T22-3). MAKRAI_STATE_DIR, MAKRAI_OPS_DIR and MAKRAI_RETRY_AFTER exist for the tests; cron
# never sets them.
readonly BASE_URL=https://makrai.org
readonly STATE=${MAKRAI_STATE_DIR:-/var/lib/makrai}
readonly OPS=${MAKRAI_OPS_DIR:-/usr/local/lib/makrai}
readonly NAME=makrai-synthetic
readonly WEB_CONTAINER=docker-nextjs-1
readonly RETRY_AFTER=${MAKRAI_RETRY_AFTER:-60}

PING=
case "${1:-}" in
  --ping) PING=1 ;;
  '') ;;
  *) echo "usage: makrai-synthetic.sh [--ping]" >&2; exit 2 ;;
esac

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Installed, this script is in /usr/local/sbin and the library in /usr/local/bin. A copy beside
# this script is used first, which is how the tests find it.
LIBDIR=$HERE
[ -r "$LIBDIR/makrai-lib.sh" ] || LIBDIR=/usr/local/bin
# shellcheck source=makrai-lib.sh
. "$LIBDIR/makrai-lib.sh"

fail() { echo "makrai-synthetic: $1" >&2; exit 1; }

# Set once this run holds the lock, and by nothing else: finish() removes the container only then.
LOCKED=

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  [ -z "$LOCKED" ] || timeout 30 docker rm -f "$NAME" >/dev/null 2>&1
  if [ -n "$PING" ]; then
    if [ "$rc" -eq 0 ]; then
      ping_ok HC_SYNTHETIC_PING_URL || echo "makrai-synthetic: WARNING: the success ping could not be sent." >&2
    else
      ping_fail HC_SYNTHETIC_PING_URL || echo "makrai-synthetic: the failure ping could not be sent." >&2
    fi
  fi
  echo "result=$([ "$rc" -eq 0 ] && echo pass || echo fail) at=$(date -u +%FT%TZ)"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

read_env SYNTHETIC_EMAIL SYNTHETIC_PASSWORD SYNTHETIC_ORG_SLUG SYNTHETIC_ASSESSMENT_ID HC_SYNTHETIC_PING_URL
export BASE_URL

install -d -m 0700 "$STATE"
exec 9>"$STATE/synthetic.lock"
if ! flock -n 9; then
  echo "waiting for the lock at=$(date -u +%FT%TZ)"
  flock -w 500 9 || fail "the previous run is still going"
fi
LOCKED=1

[ -r "$OPS/synthetic-journey.mjs" ] || fail "${OPS}/synthetic-journey.mjs is missing"

# One attempt. The values reach the container by NAME (`-e VAR`, no `=`): docker takes each from
# this process's environment, so none is ever an argument.
journey() {
  local image
  image=$(timeout 30 docker inspect --format '{{.Image}}' "$WEB_CONTAINER" 2>/dev/null) \
    || { echo "step=image status=0 reason=no_web_container"; return 1; }
  [[ $image =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "step=image status=0 reason=not_an_image_id"; return 1; }
  timeout --kill-after=10 120 docker run --rm --name "$NAME" --pull never \
    --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 256m --pids-limit 64 --log-driver none \
    -e BASE_URL -e SYNTHETIC_EMAIL -e SYNTHETIC_PASSWORD -e SYNTHETIC_ORG_SLUG -e SYNTHETIC_ASSESSMENT_ID \
    -v "$OPS/synthetic-journey.mjs:/ops/synthetic-journey.mjs:ro" \
    --entrypoint node "$image" /ops/synthetic-journey.mjs
}

echo "run at=$(date -u +%FT%TZ) attempt=1"
journey && exit 0
timeout 30 docker rm -f "$NAME" >/dev/null 2>&1 || true
sleep "$RETRY_AFTER"
echo "attempt=2 at=$(date -u +%FT%TZ)"
journey
