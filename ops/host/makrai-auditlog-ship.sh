#!/usr/bin/env bash
# /usr/local/sbin/makrai-auditlog-ship.sh
# Ship the host's audit log off the host, every hour. RL 7.13 (Task 22).
#
# Runs from root's crontab at 5 past every hour and reports to its own dead-man check
# (HC_AUDITSHIP_PING_URL): a ping on success, /fail plus a mail on failure, and silence if it
# never runs, which the check turns into an alarm.
#
#   1. Export, with journalctl's cursor, every journal entry since the last run from sshd,
#      sshd-session (OpenSSH 9.8 and later log authentication from it: F-25); from every way to
#      become root, or to try (T22R1A-2): sudo, sudoedit and su by name, and by executable the
#      binaries /usr/bin/sudo, /usr/bin/su and /usr/bin/pkexec under any name they were run by
#      (L-F1), with polkit's agent helper /usr/lib/polkit-1/polkit-agent-helper-1, which logs
#      every polkit authentication failure (L3-1); and from login, passwd, chpasswd and the
#      console break-glass hook (makrai-break-glass). And, by content, every authpriv line
#      (SYSLOG_FACILITY=10), whatever process journald credits it to: a process that execs
#      right after logging, as pkexec does, is credited with the program it ran (L4-1). In
#      journalctl's export format, gzipped into the spool as auditlog-<UTC time>.journal.gz.
#      The first run, before a cursor exists, starts 26 hours back.
#      Names never go backwards (S4-1): the time in the name is max(now, the last name shipped
#      + 1 s). The last name shipped is kept in /var/lib/makrai/auditlog-last-name, written
#      after each successful upload; without it, the newest name in the spool, or else on the
#      box. A clock that stepped back therefore names its file just after the previous one, in
#      order, and never early for retention, which goes by name. The reconcile fetches that file,
#      but its lines carry the wrong clock and are NOT checked against the window; the hold
#      makes the owner review them (step 3, below).
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
#      Only the owner removes the marker, after checking the clock (ops/host/README.md, part C);
#      the same command records when, in /var/lib/makrai/auditlog-hold-cleared (T22-R3a).
#      The hold keeps every reason, one line each (S5-1). Three more checks write the same hold,
#      so that no file the ship shipped after a clock jump can count as clock evidence on any
#      path (S-F1):
#        (a) at the start, before any upload: this run is more than CLOCK_MARGIN_DAYS after the
#            last FULLY successful run (/var/lib/makrai/auditlog-last-run, written only at the
#            end of one), or more than an hour before it. A legitimate outage that long needs
#            the owner too;
#        (b) after listing the box: two consecutive auditlog-* names, of all those not dated
#            after now, are more than CLOCK_MARGIN_DAYS apart, and the later of the two is dated
#            within the last 90 + CLOCK_MARGIN_DAYS days. The earlier one may be older, so a jump
#            of more than that many days is still a gap (S3-1). A gap whose later name is at or
#            before the owner's last clearing (auditlog-hold-cleared) was cleared and no longer
#            holds; a new one after it does (T22-R3a);
#        (c) after the name is chosen, before the upload: the name was moved ahead of the clock by
#            more than an hour, because the last name shipped is that far ahead of it. That is
#            direct evidence of a clock that stepped back (or a forward jump since corrected). It
#            needs no last-run marker, and adds its reason to a hold that already stands (S5-1).
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
readonly LAST_RUN=$STATE/auditlog-last-run
readonly HOLD_CLEARED=$STATE/auditlog-hold-cleared
readonly LAST_NAME=$STATE/auditlog-last-name
readonly SHIPPED_RE='^auditlog-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.journal\.gz$'

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

# Records why deletes are held. The hold file keeps EVERY reason, one `reason=<text> at=<UTC
# time>` line each, so that a later reason is not lost behind the first (S5-1); a reason already
# in the file, by its text, is not written again. The line that starts a hold alerts on this run:
# the day's "already alerted" mark is cleared. A reason added to a hold that stands does not
# alert again (one alert a day, naming the file).
write_hold() { # $1 = reason
  local l
  if [ -e "$HOLD" ]; then
    while IFS= read -r l || [ -n "$l" ]; do
      [[ $l == "reason=$1 at="* ]] && return 0
    done <"$HOLD"
    # Whole file or nothing: the old lines (a missing final newline supplied), then the new one.
    if { awk 1 "$HOLD" && printf 'reason=%s at=%s\n' "$1" "$(date -u +%FT%TZ)"; } >"$HOLD.next" && mv -f -- "$HOLD.next" "$HOLD"; then
      return 0
    fi
  elif printf 'reason=%s at=%s\n' "$1" "$(date -u +%FT%TZ)" >"$HOLD.next" && mv -f -- "$HOLD.next" "$HOLD"; then
    rm -f -- "$HOLD_ALERTED"
    return 0
  fi
  echo "makrai-auditlog-ship: WARNING: could not write the hold marker ${HOLD}." >&2
}

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

# --- 0. The clock against the last fully successful run (a), before any upload --------------
if [ -e "$LAST_RUN" ]; then
  last=$(head -n1 "$LAST_RUN")
  now_s=$(date -u +%s)
  if ! last_s=$(date -u -d "$last" +%s 2>/dev/null); then
    write_hold "the last-run marker ${LAST_RUN} does not hold a time"
  elif [ $((now_s - last_s)) -gt $((CLOCK_MARGIN_DAYS * 86400)) ]; then
    write_hold "this run is more than ${CLOCK_MARGIN_DAYS} days after the last fully successful run (${last}): a long outage, or the clock jumped forward"
  elif [ "$now_s" -lt $((last_s - 3600)) ]; then
    write_hold "this run is more than an hour before the last fully successful run (${last}): the clock jumped back"
  fi
fi

# --- 1. Export -------------------------------------------------------------------------
# The name: never before the last one shipped (S4-1). That is the later of the recorded last
# name and the newest file still in the spool (a failed upload leaves one there); with neither,
# the newest on the box, when the box can be listed.
name_time() { # auditlog-YYYY-MM-DDTHHMMSSZ.journal.gz -> seconds since the epoch
  local n=${1#auditlog-}
  date -u -d "${n:0:10} ${n:11:2}:${n:13:2}:${n:15:2} UTC" +%s 2>/dev/null
}
last_name=
if [ -e "$LAST_NAME" ]; then
  last_name=$(head -n1 "$LAST_NAME" 2>/dev/null || true)
  if ! [[ $last_name =~ $SHIPPED_RE ]] || ! name_time "$last_name" >/dev/null; then
    echo "makrai-auditlog-ship: WARNING: ${LAST_NAME} does not hold a shipped file's name; it is not used." >&2
    last_name=
  fi
fi
spooled_last=$(find "$SPOOL" -maxdepth 1 -type f -name 'auditlog-*.journal.gz' -printf '%f\n' | grep -E "$SHIPPED_RE" | LC_ALL=C sort | tail -n1 || true)
# The later of the two, in byte order whatever the locale (an empty one sorts first).
last_name=$(printf '%s\n' "$last_name" "$spooled_last" | LC_ALL=C sort | tail -n1)
if [ -z "$last_name" ]; then
  if box=$(timeout 300 rsync --list-only -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET"); then
    last_name=$(printf '%s\n' "$box" | awk '/^-/ {print $NF}' | grep -E "$SHIPPED_RE" | LC_ALL=C sort | tail -n1 || true)
  else
    echo "makrai-auditlog-ship: WARNING: could not list the box for the last name shipped; this file is named by the clock alone." >&2
  fi
fi
clock_s=$(date -u +%s)
stamp_s=$clock_s
if [ -n "$last_name" ] && last_s=$(name_time "$last_name") && [ $((last_s + 1)) -gt "$stamp_s" ]; then
  stamp_s=$((last_s + 1))
fi
# (c) A name moved ahead of the clock by more than an hour is direct evidence of a clock step
# back (or of a forward jump since corrected): it needs no last-run marker, and its reason is
# added to a hold that already stands (S5-1). The hour is still uploaded; the hold refuses every
# delete, and the owner reviews the files whose lines carry the wrong clock.
if [ $((stamp_s - clock_s)) -gt 3600 ]; then
  write_hold "the clock jumped back: this run's name was moved ahead of the clock by $((stamp_s - clock_s)) s"
fi
name="auditlog-$(date -u -d "@$stamp_s" +%Y-%m-%dT%H%M%SZ).journal.gz"
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
  _COMM=sshd + _COMM=sshd-session + _COMM=sudo + _COMM=sudoedit + _COMM=su \
  + _EXE=/usr/bin/sudo + _EXE=/usr/bin/su + _EXE=/usr/bin/pkexec \
  + _EXE=/usr/lib/polkit-1/polkit-agent-helper-1 \
  + SYSLOG_FACILITY=10 \
  + _COMM=login + _COMM=passwd + _COMM=chpasswd \
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
# The last name shipped, for the next run's name (S4-1). The spool sorts by name, so it is the
# last one; written whole, whatever happens later in this run.
PARTIAL=("$LAST_NAME.next")
printf '%s\n' "${spooled[-1]##*/}" >"$LAST_NAME.next" && mv -f -- "$LAST_NAME.next" "$LAST_NAME" \
  || fail "could not record ${LAST_NAME}"
PARTIAL=()
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
  # Neutral: the hold may be for a jump either way, a long outage or a gap (S3-2).
  fail "remote deletes are held (the reason is in ${HOLD})"
fi

[ -n "${WEB_IMAGE:-}" ] || fail "WEB_IMAGE is empty in the server environment file, so nothing can be pruned"
image_re='@sha256:[0-9a-f]{64}$'
[[ $WEB_IMAGE =~ $image_re ]] || fail "WEB_IMAGE is not pinned by digest"

listing=$(timeout 300 rsync --list-only -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET") \
  || fail "could not list the box"
# Regular files only, by name: the last field of each `-rw...` line.
names=$(printf '%s\n' "$listing" | awk '/^-/ {print $NF}')

# (b) The hourly cadence, on the box: a gap of more than CLOCK_MARGIN_DAYS between two
# consecutive auditlog-* names is a long outage or a clock jump. Every name not after now is
# sorted, and each gap whose LATER name is dated in the last 90 + CLOCK_MARGIN_DAYS days is
# measured, against the name before it however old: after a jump of more than that many days,
# every real name is older than the window, and only this measure still sees the jump (S3-1).
# A gap whose later name is at or before the owner's last clearing is excused (T22-R3a). Names
# become times with one `date -f`.
gap_now=$(date -u +%s)
gap_lo=$((gap_now - (90 + CLOCK_MARGIN_DAYS) * 86400))
cleared_s=
if [ -e "$HOLD_CLEARED" ]; then
  # Only the form the README writes. Anything else (an empty file reads as midnight to `date
  # -d`) excuses nothing: every gap is measured.
  cleared=$(head -n1 "$HOLD_CLEARED" 2>/dev/null || true)
  if [[ $cleared =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && cleared_s=$(date -u -d "$cleared" +%s 2>/dev/null); then
    :
  else
    cleared_s=
    echo "makrai-auditlog-ship: WARNING: ${HOLD_CLEARED} does not hold a time; no gap is excused by it." >&2
  fi
fi
gap=$(printf '%s\n' "$names" \
  | sed -n -E 's/^auditlog-([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.journal\.gz$/\1 \2:\3:\4 UTC/p' \
  | { date -u -f - +%s 2>/dev/null || true; } \
  | LC_ALL=C sort -n \
  | awk -v lo="$gap_lo" -v hi="$gap_now" -v cleared="$cleared_s" '
      $1 > hi { next }
      seen && $1 >= lo && (cleared == "" || $1 > cleared + 0) && $1 - p > max { max = $1 - p }
      { p = $1; seen = 1 }
      END { print max + 0 }')
if [ "$gap" -gt $((CLOCK_MARGIN_DAYS * 86400)) ]; then
  reason="a gap of $((gap / 86400)) days between consecutive shipped files, ending in the last $((90 + CLOCK_MARGIN_DAYS)) days: a long outage, or the clock jumped"
  write_hold "$reason"
  # This run's alert is today's: the next runs, held, stay quiet until tomorrow.
  date -u +%F >"$HOLD_ALERTED" || true
  fail "${reason}; deleting none, and holding every delete until the owner clears ${HOLD}"
fi
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
    write_hold "$reason"
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

# Fully successful: the time (a) measures the next run against. Only here, at the end.
date -u +%FT%TZ >"$LAST_RUN.next" && mv -f -- "$LAST_RUN.next" "$LAST_RUN" || fail "could not record ${LAST_RUN}"

echo "shipped=${#spooled[@]} deleted=${deleted} pending=$((${#due[@]} - deleted))"
