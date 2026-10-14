#!/usr/bin/env bash
# /usr/local/sbin/makrai-auditlog-reconcile.sh
# Check the shipped audit log against the integrity log, every night. RL 7.13 (Task 22).
#
#   makrai-auditlog-reconcile.sh [--since <YYYY-MM-DDTHH:MM:SSZ>]
#
# Runs from root's crontab at 02:00 UTC and reports to its own dead-man check
# (HC_RECONCILE_PING_URL). It reads what was SHIPPED, from the Storage Box, not the local
# journal, so the evidence it checks is the copy the host can no longer rewrite.
#
# THE WINDOW, from one persisted state (T22-2). After each SUCCESSFUL run it stores, in
# /var/lib/makrai/auditlog-state (mode 600, replaced atomically):
#   checked_until=<UTC time> seq=<n> hash=<64 hex>
# the instant up to which it flagged, and the last integrity row it verified. The next run:
#   - starts at min(checked_until - tolerance, now - 26 h): a missed night, or a run that
#     failed, is caught up the next time one passes. With no state, at now - 26 h. More than
#     8 days back fails loudly ("state too old; run with --since"); --since <time> sets the
#     start by hand, for a catch-up;
#   - ends at T, the time in the newest shipped file's name, where the evidence ends. T must be
#     within the last 26 h, whatever the start, or the run fails: the ship has stopped
#     (T22R1A-3). A name dated after now + 5 min (left by a clock that ran ahead) is not used for
#     T, the freshness check or the window; it is counted as futureNamedFiles=<n> in the counts
#     and the mail, and no checked_until after now is ever stored (L-F3);
#   - pairs console logins with entries across everything fetched, from the tolerance before
#     the start to T (and the newest file before the start is fetched for that), but FLAGS
#     only what is at or before T - tolerance. That becomes the next checked_until, so the tail,
#     whose journal line may have missed the last ship, is examined again the next night;
#   - reads the rows as ONE contiguous seq range, from the row after the stored seq or from the
#     first row dated in the window's reach, whichever is lower, to the last (L3-2), so the chain
#     is checked continuously from the stored row (T22R1A-4) over neighbouring rows only, however
#     a clock step has ordered their times. A row at or below the stored seq that is outside the
#     band counts for nothing but the chain. With them: the row just before the first one read,
#     the row at the stored seq and max(seq): the first row must link to the one before, the
#     stored row must still carry the stored hash, and max(seq) may never fall below the stored
#     seq. --since may start earlier than checked_until, never later;
#   - fails on a row read above the stored seq and dated after now (futureRows): a clock that ran
#     ahead wrote it (L3-2). Now is read after the rows are;
#   - counts operatorSessions and rootPasswordChanges only after checked_until, so two nights
#     never report the same event (T22R1A-6).
#
# Then it runs auditlog.mjs in the web image, offline, from root's installed copy, with all of
# that as JSON on stdin; mails the night's report; pings; and prints the counts line LAST,
# after anything the ping or the mail printed: the crontab appends both streams to
# /var/log/makrai/auditlog-reconcile.log, and its last line is the evidence (Task 25).
#
# STDOUT is exactly one line of counts, or nothing when nothing was reconciled:
#
#   records=<n> rows=<n> matched=<n> consoleLoginsWithoutEntry=<n> ... preVerboseLogins=<n>
#
# Every night it mails one report whose subject carries operatorSessions=<n> and
# rootPasswordChanges=<n>, the two counts the owner reads rather than the check (F-30): a
# password change the owner did not make shows there. On a failure the same mail is the alert.
#
# EXIT STATUS
#   0   reconciled, every failure count zero: success ping, the report mail, the state stored
#   1   reconciled, and something did not match: /fail, and the alert carries the two counts
#   3   could not reconcile (the state, the box, psql, the image, a file): /fail, and an alert
#   64  bad arguments (nothing read, nothing pinged)
#
# Needs, in the server .env (read as text, never run: T22-3): WEB_IMAGE (the deployed web
# image, pinned by digest), OFFSITE_AUDIT_TARGET, POSTGRES_USER, POSTGRES_DB,
# HC_RECONCILE_PING_URL and the mail settings; in /root/.ssh the audit-log key and the
# sub-account's pinned host key; in /usr/local/lib/makrai auditlog.mjs and integrity-hash.mjs;
# in /etc/makrai allowed-keys.fp, and when they exist ssh-two-factor-since and
# ssh-verbose-since.
set -Eeuo pipefail
cd /
umask 077
# Byte order for the name comparisons below, whatever locale the host runs in.
export LC_ALL=C

usage() {
  echo "usage: makrai-auditlog-reconcile.sh [--since <YYYY-MM-DDTHH:MM:SSZ>]" >&2
  exit 64
}
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
SINCE_ARG=
while [ $# -gt 0 ]; do
  case "$1" in
    --since) [ $# -ge 2 ] && [[ $2 =~ $ISO_RE ]] || usage; SINCE_ARG=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -z "$SINCE_ARG" ] || date -u -d "$SINCE_ARG" +%s >/dev/null 2>&1 || usage

# Fixed before .env is read, and read-only. MAKRAI_ETC_DIR and MAKRAI_STATE_DIR exist for the
# tests; cron never sets them.
readonly ETC=${MAKRAI_ETC_DIR:-/etc/makrai}
readonly STATE_DIR=${MAKRAI_STATE_DIR:-/var/lib/makrai}
readonly STATE_FILE=$STATE_DIR/auditlog-state
# Root's copy of auditlog.mjs, never the operator's checkout (T22-3).
readonly OPS=/usr/local/lib/makrai
readonly TOL=300                  # seconds: auditlog.mjs's pairing tolerance, and the margin
readonly MAX_SPAN=$((8 * 86400))  # the furthest back a run starts without --since

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
LIBDIR=$HERE
[ -r "$LIBDIR/makrai-lib.sh" ] || LIBDIR=/usr/local/bin
[ -r "$LIBDIR/makrai-lib.sh" ] || { echo "makrai-auditlog-reconcile: cannot read makrai-lib.sh, beside this script or in /usr/local/bin." >&2; exit 3; }
# shellcheck source=makrai-lib.sh
. "$LIBDIR/makrai-lib.sh"

WORK=       # mode-700 directory: the fetched files, the rows, the input
NOTE=       # why it could not run, for the alert's subject
COUNTS=     # the counts line, once auditlog.mjs has printed one
FOUND=      # set when the counts show a failure
ERR_LINE=
trap 'ERR_LINE=$LINENO' ERR

die() { NOTE=$1; echo "makrai-auditlog-reconcile: $1" >&2; exit 3; }

# The two counts the nightly mail carries, read from the counts line.
review_counts() {
  local s r f
  s=$(sed -n 's/.* operatorSessions=\([0-9]*\).*/\1/p' <<<"$COUNTS")
  r=$(sed -n 's/.* rootPasswordChanges=\([0-9]*\).*/\1/p' <<<"$COUNTS")
  f=$(sed -n 's/.* futureNamedFiles=\([0-9]*\).*/\1/p' <<<"$COUNTS")
  printf 'operatorSessions=%s rootPasswordChanges=%s futureNamedFiles=%s' "$s" "$r" "$f"
}

finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf -- "$WORK" || echo "makrai-auditlog-reconcile: WARNING: could not remove ${WORK}." >&2
  fi
  rm -f -- "$STATE_FILE.next"
  # Exit 1 means "found something" and nothing else; a bare `set -e` failure becomes 3.
  if [ "$rc" -eq 1 ] && [ -z "$FOUND" ]; then
    echo "makrai-auditlog-reconcile: failed unexpectedly (a command exited non-zero near line ${ERR_LINE:-unknown})." >&2
    rc=3
  fi
  if [ "$rc" -eq 0 ]; then
    ping_ok HC_RECONCILE_PING_URL || echo "makrai-auditlog-reconcile: WARNING: the success ping could not be sent." >&2
    report "audit reconcile passed: $(review_counts)"
  else
    ping_fail HC_RECONCILE_PING_URL || echo "makrai-auditlog-reconcile: the failure ping could not be sent." >&2
    if [ "$rc" -eq 1 ]; then alert "audit reconcile FAILED: $(review_counts)"
    else alert "audit reconcile could not run${NOTE:+: ${NOTE}}"
    fi
  fi
  [ -z "$COUNTS" ] || printf '%s\n' "$COUNTS"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

# As text: this runs as root, and the file is the operator's (T22-3).
read_env WEB_IMAGE OFFSITE_AUDIT_TARGET POSTGRES_USER POSTGRES_DB HC_RECONCILE_PING_URL RESEND_API_KEY ADMIN_EMAIL EMAIL_FROM_ADDRESS

# R22-6: the image the host already runs, by digest. Empty is a failure, never a skip.
[ -n "${WEB_IMAGE:-}" ] || die "WEB_IMAGE is empty in the server environment file"
image_re='@sha256:[0-9a-f]{64}$'
[[ $WEB_IMAGE =~ $image_re ]] || die "WEB_IMAGE is not pinned by digest"
# The first character of the user and the host must be a letter or a digit: a value beginning
# with `-` would reach rsync as an option (scripts F2). rsync also gets `--` before its paths.
target_re='^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:([A-Za-z0-9._-]+/)*$'
[[ ${OFFSITE_AUDIT_TARGET:-} =~ $target_re ]] || die "OFFSITE_AUDIT_TARGET is not user@host: or user@host:dir/"
[ -r "$ETC/allowed-keys.fp" ] || die "cannot read ${ETC}/allowed-keys.fp"

# --- The state, and the window's start ----------------------------------------------------
state_json=null
state_seq=0
checked=
if [ -e "$STATE_FILE" ]; then
  line=$(<"$STATE_FILE") || die "cannot read ${STATE_FILE}"
  state_re='^checked_until=([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z) seq=(0|[1-9][0-9]*) hash=([0-9a-f]{64})$'
  [[ $line =~ $state_re ]] || die "${STATE_FILE} is not one 'checked_until=<time> seq=<n> hash=<hex>' line"
  checked=${BASH_REMATCH[1]}
  state_seq=${BASH_REMATCH[2]}
  state_json="{\"seq\":${state_seq},\"hash\":\"${BASH_REMATCH[3]}\"}"
fi

now=$(date -u +%s)
floor=$((now - 26 * 3600))
if [ -n "$SINCE_ARG" ]; then
  start=$(date -u -d "$SINCE_ARG" +%s)
  [ "$start" -lt "$now" ] || die "--since is not in the past"
  # A later start would leave what lies between checked_until and it unchecked for good.
  [ -z "$checked" ] || [ "$start" -le "$(date -u -d "$checked" +%s)" ] \
    || die "--since is later than the stored checked_until (${checked}); a catch-up starts earlier, never later"
elif [ -n "$checked" ]; then
  c=$(date -u -d "$checked" +%s) || die "${STATE_FILE} holds a time that is not one"
  start=$((c - TOL < floor ? c - TOL : floor))
  [ $((now - start)) -le "$MAX_SPAN" ] || die "state too old; run with --since"
else
  start=$floor
fi
SINCE=$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ)
ROWS_FROM=$(date -u -d "@$((start - TOL))" +%Y-%m-%dT%H:%M:%SZ)
start_name="auditlog-$(date -u -d "@$start" +%Y-%m-%dT%H%M%SZ).journal.gz"

WORK=$(mktemp -d -p "${TMPDIR:-/dev/shm}") || die "cannot make a working directory"
mkdir "$WORK/fetched"

# --- 1. The shipped files: from the start on, and the newest one before it -----------------
listing=$(timeout 300 rsync --list-only -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET") \
  || die "could not list the box"
# Names sort by time. A file named at or after the start holds every entry from the hour
# before it on; the newest one named before the start covers the tolerance before it.
wanted=()
prior=
future=0
future_name="auditlog-$(date -u -d "@$((now + 300))" +%Y-%m-%dT%H%M%SZ).journal.gz"
while IFS= read -r n; do
  [[ $n =~ ^auditlog-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.journal\.gz$ ]] || continue
  # Named after now + 5 min: not evidence of anything up to now (L-F3).
  if [[ $n > $future_name ]]; then future=$((future + 1)); continue; fi
  if [[ $n < $start_name ]]; then prior=$n; else wanted+=("$n"); fi
done < <(printf '%s\n' "$listing" | awk '/^-/ {print $NF}' | LC_ALL=C sort)
[ "${#wanted[@]}" -gt 0 ] || die "no shipped file since the window start: the ship has stopped"

# T: the newest file's name, as a time.
newest=${wanted[-1]}
stamp=${newest#auditlog-}
UNTIL="${stamp:0:13}:${stamp:13:2}:${stamp:15:2}Z"
# Fresh, whatever the start: with a stored state the start can sit days back, and files from
# then would otherwise keep the window alive after the ship stopped.
[ "$(date -u -d "$UNTIL" +%s)" -ge "$floor" ] || die "no shipped file in the last 26 h: the ship has stopped"

[ -z "$prior" ] || wanted=("$prior" "${wanted[@]}")
includes=()
for n in "${wanted[@]}"; do includes+=("--include=$n"); done
timeout 900 rsync -a "${includes[@]}" --exclude='*' -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET" "$WORK/fetched/" \
  || die "could not fetch the shipped files"
fetched=()
for n in "${wanted[@]}"; do
  [ -f "$WORK/fetched/$n" ] || die "a listed file did not arrive"
  fetched+=("$WORK/fetched/$n")
done

# --- 2. The rows, the anchor, the stored row, max(seq); the allowlist; the markers --------
# As the schema owner, the only role that can read integrity_log. psql's own stderr goes to a
# file in the working directory, never to the log: an error can quote a row.
docker exec -i docker-postgres-1 psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At \
  -v "rows_from=$ROWS_FROM" -v "until=$UNTIL" -v "state_seq=$state_seq" >"$WORK/db.json" 2>"$WORK/psql.err" <<'SQL' \
  || die "could not read integrity_log (docker exec or psql exited $?)"
with w as (
  select * from integrity_log
  where seq >= least(:'state_seq'::bigint + 1, coalesce((select min(seq) from integrity_log
    where at >= :'rows_from'::timestamptz and at < :'until'::timestamptz), :'state_seq'::bigint + 1))
)
select json_build_object(
  'rows', coalesce((select json_agg(json_build_object(
      'seq', seq, 'prevHash', prev_hash, 'hash', hash,
      'atUtc', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'kind', kind, 'actorRef', actor_ref, 'detailText', detail::text) order by seq)
    from w), '[]'::json),
  'anchor', (select json_build_object(
      'seq', seq, 'prevHash', prev_hash, 'hash', hash,
      'atUtc', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'kind', kind, 'actorRef', actor_ref, 'detailText', detail::text)
    from integrity_log where seq < coalesce((select min(seq) from w), (select max(seq) + 1 from integrity_log))
    order by seq desc limit 1),
  'stateRow', (select json_build_object(
      'seq', seq, 'prevHash', prev_hash, 'hash', hash,
      'atUtc', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'kind', kind, 'actorRef', actor_ref, 'detailText', detail::text)
    from integrity_log where seq = :'state_seq'::bigint),
  'maxSeq', (select max(seq) from integrity_log));
SQL

# The clock, after the rows: a row committed before the query is never after it. Rounded up to
# the second, since `at` carries milliseconds.
NOW=$(date -u -d "@$(($(date -u +%s) + 1))" +%Y-%m-%dT%H:%M:%SZ)
allowed=$(base64 -w0 <"$ETC/allowed-keys.fp")
two_factor=null
if [ -e "$ETC/ssh-two-factor-since" ]; then
  two_factor="\"$(base64 -w0 <"$ETC/ssh-two-factor-since")\""
fi
checked_json=null
[ -z "$checked" ] || checked_json="\"$checked\""
verbose=null
if [ -e "$ETC/ssh-verbose-since" ]; then
  verbose="\"$(base64 -w0 <"$ETC/ssh-verbose-since")\""
fi

# --- 3. The reconcile, in the web image -------------------------------------------------
{
  printf '{"since":"%s","until":"%s","toleranceSec":%s,"twoFactorSinceB64":%s,"verboseSinceB64":%s,"allowedKeysB64":"%s","state":%s,"checkedUntil":%s,"futureNamedFiles":%s,"now":"%s","db":' \
    "$SINCE" "$UNTIL" "$TOL" "$two_factor" "$verbose" "$allowed" "$state_json" "$checked_json" "$future" "$NOW"
  cat "$WORK/db.json"
  printf ',"journalB64":"'
  gzip -dc -- "${fetched[@]}" | base64 -w0
  printf '"}\n'
} >"$WORK/input.json"

rc=0
out=$(docker run --rm -i --pull never --network none -v "$OPS:/ops:ro" --entrypoint node "$WEB_IMAGE" \
  /ops/auditlog.mjs reconcile <"$WORK/input.json") || rc=$?
case "$rc" in
  0 | 1) ;;
  *) die "the reconcile in the web image refused its input or did not run (exit ${rc})" ;;
esac
counts=${out%%$'\n'*}
next=${out#*$'\n'}
counts_re='^([A-Za-z]+=[0-9]+ )+[A-Za-z]+=[0-9]+$'
next_re='^checked_until=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z seq=(0|[1-9][0-9]*) hash=[0-9a-f]{64}$'
[[ $counts =~ $counts_re ]] && [[ $next =~ $next_re ]] \
  || die "the reconcile printed something other than a counts line and a state line"
COUNTS=$counts

if [ "$rc" -eq 1 ]; then
  FOUND=1
  exit 1
fi

# --- 4. Passed: store the state, atomically --------------------------------------------
# Never a checked_until after now (L-F3): T is at most now + 5 min, and the band ends 5 min
# before it, so this cannot happen; if it does, nothing is stored.
next_until=${next#checked_until=}
next_until=${next_until%% *}
[ "$(date -u -d "$next_until" +%s)" -le "$(date -u +%s)" ] || die "the reconcile would store a checked_until after now"
install -d -m 0700 "$STATE_DIR"
printf '%s\n' "$next" >"$STATE_FILE.next" && mv -f -- "$STATE_FILE.next" "$STATE_FILE" \
  || die "could not store ${STATE_FILE}"
