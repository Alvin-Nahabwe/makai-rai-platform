#!/usr/bin/env bash
# /usr/local/sbin/makrai-auditlog-ship.sh
# Ship the host's audit log off the host, every hour. RL 7.13 (Task 22).
#
# Runs from root's crontab at 5 past every hour and reports to its own dead-man check
# (HC_AUDITSHIP_PING_URL): a ping on success, /fail plus a mail on failure, and silence if it
# never runs, which the check turns into an alarm.
#
#   1. Export, with journalctl's cursor, every journal entry since the last run from sshd,
#      sshd-session (OpenSSH 9.8 and later log authentication from it: F-25), sudo, sudoedit and
#      su (every way to become root: T22R1A-2), login, passwd, chpasswd and the console
#      break-glass hook (makrai-break-glass), in journalctl's
#      export format, gzipped into the spool as auditlog-<UTC time>.journal.gz. The first run,
#      before a cursor exists, starts 26 hours back.
#   2. Copy every file in the spool to OFFSITE_AUDIT_TARGET (the Storage Box's auditlog
#      sub-account), and remove a file from the spool only after the copy succeeded. A failed
#      copy leaves the spool for the next run.
#   3. Delete from the box what has passed the 90-day retention (G2-22), as chosen by
#      auditlog.mjs's expiredNames(), run in the web image from root's installed copy: by exact
#      name, the oldest first, at most MAX_DELETE per run, so a backlog drains over a few hours.
#      Nothing at all is deleted on evidence that the clock is wrong: a file on the box dated
#      after today (the clock is behind), or an expired file dated within CLOCK_MARGIN_DAYS of
#      the newest file shipped before this run (it jumped forward, making recent files look old).
#      A clock-forward refusal also writes the hold marker /var/lib/makrai/auditlog-delete-hold:
#      while it exists every delete is refused, whatever the box then looks like (the refused
#      run's own file carries the wrong date, and would pass the next run's check: scripts F1).
#      The hour is still uploaded; the run pings /fail, and alerts once a day, not each hour.
#      Only the owner removes the marker, after checking the clock (ops/host/README.md, part C).
#   4. Ping, then print `shipped=<n> deleted=<n> pending=<n>` (pending: still due, for later runs).
#
# The cursor moves only after the hour's file is complete in the spool, so an export that
# fails is retried, and a run that dies between the two ships the same entries twice, which
# the reconcile counts once (by __CURSOR).
#
# Needs, in the server .env (read as text, never run: T22-3): OFFSITE_AUDIT_TARGET (`user@host:`
# or `user@host:dir/`), WEB_IMAGE (digest-pinned), HC_AUDITSHIP_PING_URL and the mail settings;
# in /root/.ssh: the key makrai_auditlog and the sub-account's host key in known_hosts; and
# auditlog.mjs with integrity-hash.mjs in /usr/local/lib/makrai, installed from the stage.
set -Eeuo pipefail
cd /
umask 077

# Fixed before .env is sourced and read-only, so a line in .env cannot move them.
# MAKRAI_STATE_DIR exists for the tests; cron never sets it.
readonly STATE=${MAKRAI_STATE_DIR:-/var/lib/makrai}
readonly SPOOL=$STATE/auditlog-spool
readonly CURSOR=$STATE/auditlog.cursor
# Root's copy of auditlog.mjs, never the operator's checkout (T22-3).
readonly OPS=/usr/local/lib/makrai
readonly MAX_DELETE=60
readonly CLOCK_MARGIN_DAYS=3
readonly HOLD=$STATE/auditlog-delete-hold
readonly HOLD_ALERTED=$STATE/auditlog-delete-hold.alerted

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Installed, this script is in /usr/local/sbin and the library in /usr/local/bin. A copy beside
# this script is used first, which is how the tests find it.
LIBDIR=$HERE
[ -r "$LIBDIR/makrai-lib.sh" ] || LIBDIR=/usr/local/bin
# shellcheck source=makrai-lib.sh
. "$LIBDIR/makrai-lib.sh"

NOTE=        # why the run failed, when the script knows; it goes into the alert's subject
QUIET=       # set when today's alert for a standing hold was already sent
PARTIAL=()   # files that exist only while a step is running, removed on any exit

fail() { NOTE=$1; echo "makrai-auditlog-ship: $1" >&2; exit 1; }

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  [ "${#PARTIAL[@]}" -eq 0 ] || rm -f -- "${PARTIAL[@]}"
  if [ "$rc" -eq 0 ]; then
    ping_ok HC_AUDITSHIP_PING_URL || echo "makrai-auditlog-ship: WARNING: the success ping could not be sent; the files were shipped." >&2
  else
    ping_fail HC_AUDITSHIP_PING_URL || echo "makrai-auditlog-ship: the failure ping could not be sent." >&2
    if [ -n "$QUIET" ]; then
      echo "makrai-auditlog-ship: today's alert for the delete hold was already sent." >&2
    else
      alert "audit log ship failed${NOTE:+: ${NOTE}}"
    fi
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

read_env OFFSITE_AUDIT_TARGET WEB_IMAGE HC_AUDITSHIP_PING_URL RESEND_API_KEY ADMIN_EMAIL EMAIL_FROM_ADDRESS

[ -n "${OFFSITE_AUDIT_TARGET:-}" ] || fail "OFFSITE_AUDIT_TARGET is not set in the server environment file"
# The first character of the user and the host must be a letter or a digit: a value beginning
# with `-` would reach rsync as an option (scripts F2). rsync also gets `--` before its paths.
target_re='^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:([A-Za-z0-9._-]+/)*$'
[[ $OFFSITE_AUDIT_TARGET =~ $target_re ]] || fail "OFFSITE_AUDIT_TARGET is not user@host: or user@host:dir/"

install -d -m 0700 "$STATE" "$SPOOL"

# One run at a time: two runs on one cursor would export the same entries twice and race on
# the spool.
exec 9>"$STATE/auditlog-ship.lock"
flock -n 9 || fail "the previous run is still going"

# --- 1. Export -------------------------------------------------------------------------
name="auditlog-$(date -u +%Y-%m-%dT%H%M%SZ).journal.gz"
part="$SPOOL/.$name.part"
next="$CURSOR.next"
PARTIAL=("$part" "$next")
since=()
if [ -s "$CURSOR" ]; then
  cp -- "$CURSOR" "$next"
else
  rm -f -- "$next"
  since=(--since=-26h)
fi
# `+` ORs the terms. journalctl writes the cursor of the last entry it showed into $next, and
# leaves the file alone when nothing is new.
journalctl --no-pager --cursor-file="$next" "${since[@]}" -o export \
  _COMM=sshd + _COMM=sshd-session + _COMM=sudo + _COMM=sudoedit + _COMM=su + _COMM=login \
  + _COMM=passwd + _COMM=chpasswd \
  + SYSLOG_IDENTIFIER=makrai-break-glass \
  | gzip -9 >"$part" \
  || fail "the journal export failed"
mv -- "$part" "$SPOOL/$name"
[ ! -e "$next" ] || mv -f -- "$next" "$CURSOR"
PARTIAL=()

# --- 2. Copy the spool, then empty it ----------------------------------------------------
mapfile -t spooled < <(find "$SPOOL" -maxdepth 1 -type f -name 'auditlog-*.journal.gz' | LC_ALL=C sort)
timeout 600 rsync -a -e "$AUDITLOG_SSH" -- "${spooled[@]}" "$OFFSITE_AUDIT_TARGET" \
  || fail "the copy to the box failed; the spool is kept for the next run"
rm -f -- "${spooled[@]}"
declare -A shipped_now=()
for f in "${spooled[@]}"; do shipped_now[${f##*/}]=1; done

# --- 3. Retention -------------------------------------------------------------------------
# A standing hold refuses every delete until the owner clears it. The hour above was shipped.
if [ -e "$HOLD" ]; then
  echo "shipped=${#spooled[@]} deleted=0 held=1"
  today=$(date -u +%F)
  if [ "$(head -n1 "$HOLD_ALERTED" 2>/dev/null || true)" = "$today" ]; then
    QUIET=1
  else
    printf '%s\n' "$today" >"$HOLD_ALERTED"
  fi
  fail "remote deletes are held since a clock-forward refusal; the owner clears ${HOLD} after checking the clock"
fi

[ -n "${WEB_IMAGE:-}" ] || fail "WEB_IMAGE is empty in the server environment file, so nothing can be pruned"
image_re='@sha256:[0-9a-f]{64}$'
[[ $WEB_IMAGE =~ $image_re ]] || fail "WEB_IMAGE is not pinned by digest"

listing=$(timeout 300 rsync --list-only -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET") \
  || fail "could not list the box"
# Regular files only, by name: the last field of each `-rw...` line.
names=$(printf '%s\n' "$listing" | awk '/^-/ {print $NF}')
chosen=$(printf '%s\n' "$names" \
  | docker run --rm -i --pull never --network none -v "$OPS:/ops:ro" --entrypoint node "$WEB_IMAGE" \
      /ops/auditlog.mjs expired "$(date -u +%F)") \
  || fail "expiredNames() failed in the web image"
mapfile -t expired < <(printf '%s' "$chosen" | grep -E '.' || true)

name_re='^(auditlog-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.journal\.gz|pre-fix-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json\.gz)$'
name_date() { local n=${1#auditlog-}; n=${n#pre-fix-}; printf '%s' "${n:0:10}"; }

# Every name checked before any is deleted, so nothing but an exact name the box listed
# reaches rm.
for f in "${expired[@]}"; do
  [[ $f =~ $name_re ]] || fail "expiredNames() returned a name that is not a shipped file's"
  grep -qxF -- "$f" <<<"$names" || fail "expiredNames() returned a name the box did not list"
done

# The clock, on the box's own evidence. Dates in names are YYYY-MM-DD, so they compare as text.
today=$(date -u +%F)
newest_all='' newest_before=''
while IFS= read -r f; do
  [[ $f =~ $name_re ]] || continue
  d=$(name_date "$f")
  if [[ $d > $newest_all ]]; then newest_all=$d; fi
  if [ -z "${shipped_now[$f]:-}" ] && [[ $d > $newest_before ]]; then newest_before=$d; fi
done <<<"$names"
if [[ $newest_all > $today ]]; then
  fail "a file on the box is dated ${newest_all}, after today (${today}): the clock is behind; deleting none"
fi
if [ "${#expired[@]}" -gt 0 ] && [ -n "$newest_before" ]; then
  guard=$(date -u -d "$newest_before -${CLOCK_MARGIN_DAYS} days" +%F)
  for f in "${expired[@]}"; do
    [[ $(name_date "$f") < $guard ]] && continue
    reason="an expired file is dated within ${CLOCK_MARGIN_DAYS} days of the newest one shipped before this run (${newest_before}): the clock jumped forward"
    # Kept until the owner removes it: the next run would see this run's file, with this
    # run's wrong date, as the newest one, and its check would pass.
    printf 'reason=%s at=%s\n' "$reason" "$(date -u +%FT%TZ)" >"$HOLD.next" && mv -f -- "$HOLD.next" "$HOLD" \
      || echo "makrai-auditlog-ship: WARNING: could not write the hold marker ${HOLD}." >&2
    date -u +%F >"$HOLD_ALERTED" || true
    fail "${reason}; deleting none, and holding every delete until the owner clears ${HOLD}"
  done
fi

# The oldest first, MAX_DELETE at most; the rest wait for the next runs.
mapfile -t due < <(for f in "${expired[@]}"; do printf '%s %s\n' "$(name_date "$f")" "$f"; done | LC_ALL=C sort | cut -d' ' -f2)
host=${OFFSITE_AUDIT_TARGET%%:*}
dir=${OFFSITE_AUDIT_TARGET#*:}
deleted=0
for f in "${due[@]:0:MAX_DELETE}"; do
  # shellcheck disable=SC2086 # AUDITLOG_SSH is a command line, split on purpose
  timeout 60 $AUDITLOG_SSH "$host" rm "$dir$f" || fail "could not delete an expired file from the box"
  deleted=$((deleted + 1))
done

echo "shipped=${#spooled[@]} deleted=${deleted} pending=$((${#due[@]} - deleted))"
