#!/usr/bin/env bash
# /usr/local/bin/makrai-reminders.sh
# The hourly reminder job (NFR-OBS-02, FR-OPS-02, SRS 6.6): POST route 40, the app's internal
# reminder route, from inside the web container, and report to its own dead-man check
# (HC_REMINDER_PING_URL).
#
# Runs from the operator's crontab at 20 past every hour. Everything it prints goes to
# /srv/makrai/reminders.log (mode 600); the log ends with `result=pass|fail at=<UTC time>`, and
# before that holds the job's own line:
#   status=<code> attempted=<n> sent=<n> failed=<n> opted_out=<n> skipped_locked=<0|1>
# which is built from the response's numbers only, so no recipient, address or token reaches it.
#
# The token (REMINDER_JOB_TOKEN) lives in the web container's environment. This script never
# reads it from .env: the `node -e` below reads process.env.REMINDER_JOB_TOKEN inside the
# container, so the token is on no command line, in no environment of the host and in no log. The
# ping URL goes to curl on stdin (ping_ok and ping_fail in makrai-lib.sh).
#
# Exit status: the in-container status. 0 only when the route answered 200 and every send
# succeeded; a run that found another run holding the job's lock (`skipped_locked=1`, SRS 6.6) is
# a pass. Anything else (a refused token, a failed send, a timeout, a missing container, an
# answer that is not the job's) is non-zero and pings /fail.
#
# The bound is 900 seconds, the reminder lock's 15-minute timeout (withReminderRunLock).
set -Eeuo pipefail
cd /
umask 077

# Fixed before .env is read and read-only. MAKRAI_REMINDERS_LOG exists for the tests; cron never
# sets it.
readonly LOG=${MAKRAI_REMINDERS_LOG:-/srv/makrai/reminders.log}
touch "$LOG"
chmod 600 "$LOG"
exec >>"$LOG" 2>&1

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=makrai-lib.sh
. "$HERE/makrai-lib.sh"

# The job, as a fixed string. It prints one line of numbers and exits 0 only for a 200 with no
# failed send. Every other outcome prints `status=<code>` and a reason word, and exits 1.
JS='
(async () => {
  const token = process.env.REMINDER_JOB_TOKEN;
  if (!token) { console.log("status=0 reason=no_token"); process.exit(1); }
  let res;
  try {
    res = await fetch("http://127.0.0.1:3000/api/internal/reminders", {
      method: "POST",
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(890000),
    });
  } catch {
    console.log("status=0 reason=no_response");
    process.exit(1);
  }
  if (res.status !== 200) { console.log("status=" + res.status); process.exit(1); }
  let b;
  try { b = await res.json(); } catch { b = null; }
  const ok = b && ["attempted", "sent", "failed", "optedOut"].every((k) => Number.isInteger(b[k]) && b[k] >= 0) && typeof b.skippedLocked === "boolean";
  if (!ok) { console.log("status=200 reason=bad_body"); process.exit(1); }
  console.log("status=200 attempted=" + b.attempted + " sent=" + b.sent + " failed=" + b.failed + " opted_out=" + b.optedOut + " skipped_locked=" + (b.skippedLocked ? 1 : 0));
  process.exit(b.failed === 0 ? 0 : 1);
})();
'

# Set by the statement that runs the job, so a run that died before it cannot pass.
RAN=

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  [ "$RAN" = 1 ] || [ "$rc" -ne 0 ] || rc=1   # an exit 0 that never ran the job is not a pass
  if [ -z "${HC_REMINDER_PING_URL:-}" ]; then
    echo "makrai-reminders: HC_REMINDER_PING_URL is not set in the server .env; no ping was sent." >&2
    [ "$rc" -ne 0 ] || rc=1
  elif [ "$rc" -eq 0 ]; then
    ping_ok HC_REMINDER_PING_URL || echo "makrai-reminders: WARNING: the success ping could not be sent." >&2
  else
    ping_fail HC_REMINDER_PING_URL || echo "makrai-reminders: the failure ping could not be sent." >&2
  fi
  echo "result=$([ "$rc" -eq 0 ] && echo pass || echo fail) at=$(date -u +%FT%TZ)"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

read_env HC_REMINDER_PING_URL

echo "run at=$(date -u +%FT%TZ)"
RAN=1
# The line is checked as well as the status: a container that answers with anything other than the
# job's line (a shell error, a proxy page) must not pass on an exit status of 0.
OUT=$(timeout 900 docker exec docker-nextjs-1 node -e "$JS") && rc=0 || rc=$?
printf '%s\n' "$OUT"
if [ "$rc" -eq 0 ] && ! [[ $OUT =~ ^status=200\ attempted=[0-9]+\ sent=[0-9]+\ failed=0\ opted_out=[0-9]+\ skipped_locked=[01]$ ]]; then
  echo "makrai-reminders: the job's answer is not its result line."
  rc=1
fi
exit "$rc"
