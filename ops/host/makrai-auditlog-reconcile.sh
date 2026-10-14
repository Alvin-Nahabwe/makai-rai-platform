#!/usr/bin/env bash
# /usr/local/sbin/makrai-auditlog-reconcile.sh
# Check the shipped audit log against the integrity log, every night. RL 7.13 (Task 22).
#
# Runs from root's crontab at 02:00 UTC and reports to its own dead-man check
# (HC_RECONCILE_PING_URL). It reads what was SHIPPED, from the Storage Box, not the local
# journal, so the evidence it checks is the copy the host can no longer rewrite.
#
#   1. Fetch the shipped files from the last 26 hours. The window is [now - 26 h, T), where T
#      is the time in the newest file's name: the evidence ends there, so the rows are cut
#      there too, and a console login after the last hourly ship is checked the next night.
#   2. Read, for the same window, the integrity_log rows (with the renderings entryHash()
#      hashes), /etc/makrai/allowed-keys.fp and /etc/makrai/ssh-two-factor-since (absent
#      before Task 23's switch).
#   3. Run auditlog.mjs in the web image, offline, with all of that as JSON on stdin. It
#      extracts the sshd, console login, sudo, password-change and break-glass lines with
#      their times and pids, and reconciles them (see auditlog.mjs).
#   4. Mail the day's report, ping, and print the counts line LAST, after anything the ping or
#      the mail printed: the crontab appends both streams to
#      /var/log/makrai/auditlog-reconcile.log, and its last line is the evidence (Task 25).
#
# STDOUT is exactly one line of counts, or nothing when nothing was reconciled:
#
#   records=<n> rows=<n> matched=<n> consoleLoginsWithoutEntry=<n> ... rowsWithoutShipped=<n>
#
# Every night it mails one report whose subject carries operatorSessions=<n> and
# rootPasswordChanges=<n>, the two counts the owner reads rather than the check (F-30): a
# password change the owner did not make shows there. On a failure the same mail is the alert.
#
# EXIT STATUS
#   0  reconciled, every failure count zero: success ping, and the report mail
#   1  reconciled, and something did not match: /fail, and the alert carries the two counts
#   3  could not reconcile (the box, psql, the image, a file): /fail, and an alert
#
# Needs, in the server .env: WEB_IMAGE (the deployed web image, pinned by digest),
# OFFSITE_AUDIT_TARGET, POSTGRES_USER, POSTGRES_DB, HC_RECONCILE_PING_URL and the mail
# settings; in /root/.ssh the audit-log key and the sub-account's pinned host key.
set -Eeuo pipefail
cd /
umask 077
# Byte order for the name comparisons below, whatever locale the host runs in.
export LC_ALL=C

# Fixed before .env is sourced and read-only. MAKRAI_ETC_DIR exists for the tests.
readonly ETC=${MAKRAI_ETC_DIR:-/etc/makrai}
readonly OPS=/srv/makrai/app/ops/host

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

# The two counts the daily mail carries, read from the counts line.
review_counts() {
  local s r
  s=$(sed -n 's/.* operatorSessions=\([0-9]*\).*/\1/p' <<<"$COUNTS")
  r=$(sed -n 's/.* rootPasswordChanges=\([0-9]*\).*/\1/p' <<<"$COUNTS")
  printf 'operatorSessions=%s rootPasswordChanges=%s' "$s" "$r"
}

finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    rm -rf -- "$WORK" || echo "makrai-auditlog-reconcile: WARNING: could not remove ${WORK}." >&2
  fi
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

load_env

# R22-6: the image the host already runs, by digest. Empty is a failure, never a skip.
[ -n "${WEB_IMAGE:-}" ] || die "WEB_IMAGE is empty in the server environment file"
image_re='@sha256:[0-9a-f]{64}$'
[[ $WEB_IMAGE =~ $image_re ]] || die "WEB_IMAGE is not pinned by digest"
target_re='^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:([A-Za-z0-9._-]+/)*$'
[[ ${OFFSITE_AUDIT_TARGET:-} =~ $target_re ]] || die "OFFSITE_AUDIT_TARGET is not user@host: or user@host:dir/"
[ -r "$ETC/allowed-keys.fp" ] || die "cannot read ${ETC}/allowed-keys.fp"

WORK=$(mktemp -d -p "${TMPDIR:-/dev/shm}") || die "cannot make a working directory"
mkdir "$WORK/fetched"

# --- 1. The shipped files from the last 26 hours ----------------------------------------
now=$(date -u +%s)
start=$((now - 26 * 3600))
SINCE=$(date -u -d "@$start" +%Y-%m-%dT%H:%M:%SZ)
since_name="auditlog-$(date -u -d "@$start" +%Y-%m-%dT%H%M%SZ).journal.gz"

listing=$(timeout 300 rsync --list-only -e "$AUDITLOG_SSH" "$OFFSITE_AUDIT_TARGET") \
  || die "could not list the box"
# Names sort by time. A file named at or after the window's start holds every entry the
# window needs from that hour on; the first one also holds the hour before, which the cut
# below drops.
wanted=()
while IFS= read -r n; do
  [[ $n =~ ^auditlog-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}Z\.journal\.gz$ ]] || continue
  [[ $n < $since_name ]] || wanted+=("$n")
done < <(printf '%s\n' "$listing" | awk '/^-/ {print $NF}' | LC_ALL=C sort)
[ "${#wanted[@]}" -gt 0 ] || die "no shipped file in the last 26 h: the ship has stopped"

includes=()
for n in "${wanted[@]}"; do includes+=("--include=$n"); done
timeout 900 rsync -a "${includes[@]}" --exclude='*' -e "$AUDITLOG_SSH" "$OFFSITE_AUDIT_TARGET" "$WORK/fetched/" \
  || die "could not fetch the shipped files"
fetched=()
for n in "${wanted[@]}"; do
  [ -f "$WORK/fetched/$n" ] || die "a listed file did not arrive"
  fetched+=("$WORK/fetched/$n")
done

# T: the newest file's name, as a time.
newest=${wanted[-1]}
stamp=${newest#auditlog-}
UNTIL="${stamp:0:13}:${stamp:13:2}:${stamp:15:2}Z"

# --- 2. The rows, the allowlist, the switch ---------------------------------------------
# As the schema owner, the only role that can read integrity_log. psql's own stderr goes to a
# file in the working directory, never to the log: an error can quote a row.
docker exec -i docker-postgres-1 psql -X -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At \
  -v "since=$SINCE" -v "until=$UNTIL" >"$WORK/rows.json" 2>"$WORK/psql.err" <<'SQL' \
  || die "could not read integrity_log (docker exec or psql exited $?)"
select coalesce(json_agg(json_build_object(
  'seq', seq, 'prevHash', prev_hash, 'hash', hash,
  'atUtc', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'kind', kind, 'actorRef', actor_ref, 'detailText', detail::text) order by seq), '[]'::json)
from integrity_log where at >= :'since'::timestamptz and at < :'until'::timestamptz;
SQL

allowed=$(base64 -w0 <"$ETC/allowed-keys.fp")
two_factor=null
if [ -e "$ETC/ssh-two-factor-since" ]; then
  two_factor="\"$(base64 -w0 <"$ETC/ssh-two-factor-since")\""
fi

# --- 3. The reconcile, in the web image -------------------------------------------------
{
  printf '{"since":"%s","until":"%s","twoFactorSinceB64":%s,"allowedKeysB64":"%s","rows":' "$SINCE" "$UNTIL" "$two_factor" "$allowed"
  cat "$WORK/rows.json"
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
counts_re='^([A-Za-z]+=[0-9]+ )+[A-Za-z]+=[0-9]+$'
[[ $out =~ $counts_re ]] || die "the reconcile printed something other than one counts line"
COUNTS=$out

if [ "$rc" -eq 1 ]; then
  FOUND=1
  exit 1
fi
