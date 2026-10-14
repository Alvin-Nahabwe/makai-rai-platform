#!/usr/bin/env bash
# /usr/local/sbin/makrai-prefix-export.sh
# Export the journal from before the log-format fix, scrubbed, one file per day, and ship it.
# RL 7.12 (Task 22, step 5). Run once, by the owner, as root, before the journal is vacuumed.
#
#   makrai-prefix-export.sh <R>
#
# <R> is the cut-over time from Task 12, as `date -d` reads it (2026-10-14T05:07:16Z). For each
# UTC day from the journal's oldest entry to R it writes pre-fix-<YYYY-MM-DD>.json.gz from
# `journalctl -o json --all`, with these removed or changed:
#
#   - every line holding an account address (makrai-email-scan.sh --write-patterns, which
#     refuses an empty or short list; grep -viF), in any letter case;
#   - every line holding anything address-shaped (email-shape.regex, beside this script, the
#     same file the scan reads: D-09). That covers crawler addresses in nginx user agents;
#   - every line with a field journalctl printed as a byte array. It does so for any value
#     with a control character or invalid UTF-8, and an address inside one is invisible to the
#     two checks above, so the whole line goes;
#   - the token in /invitations/<token> and /api/v1/invitations/<token> paths, replaced by
#     [token], as nginx's own log format now does.
#
# Then makrai-email-scan.sh --file must find nothing in every file, or nothing is shipped. The
# files go to OFFSITE_AUDIT_TARGET, where the ship's prune deletes each when its date is more
# than 90 days old, and the local copies are removed.
#
# STDOUT is counts only: `patterns=<n>`, one `pre-fix-<day> lines=<n> kept=<n> removed=<n>`
# per day that had entries, then `days=<n> shipped=<n>`. Nothing else, and never a line of the
# journal. Exit 0 when every day was written, checked and shipped; 64 for bad arguments;
# anything else is a failure: nothing is shipped unless every day passed its scan, and a copy
# that fails part-way is simply run again (the box keeps one file per day name).
set -Eeuo pipefail
cd /
umask 077
export LC_ALL=C

# Fixed before .env is sourced and read-only. MAKRAI_STATE_DIR exists for the tests.
readonly STATE=${MAKRAI_STATE_DIR:-/var/lib/makrai}
readonly OUT=$STATE/prefix-export

usage() {
  echo "usage: makrai-prefix-export.sh <R, the cut-over time>" >&2
  exit 64
}
[ $# -eq 1 ] && [ -n "$1" ] || usage
R_UTC=$(date -u -d "$1" '+%Y-%m-%d %H:%M:%S UTC' 2>/dev/null) || usage
LAST_DAY=$(date -u -d "$1" +%F)

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
LIBDIR=$HERE
[ -r "$LIBDIR/makrai-lib.sh" ] || LIBDIR=/usr/local/bin
# shellcheck source=makrai-lib.sh
. "$LIBDIR/makrai-lib.sh"
readonly SCAN=$HERE/makrai-email-scan.sh
readonly SHAPE_FILE=$HERE/email-shape.regex

WORK=
written=()
die() { echo "makrai-prefix-export: $*" >&2; exit 1; }

# The pattern list is every account address: shredded, whatever happens. So is every day file
# of a run that failed, since one may hold what its scan found.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM
  set +e
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    find "$WORK" -type f -exec shred -u {} + || echo "makrai-prefix-export: WARNING: could not shred the files in ${WORK}." >&2
    rmdir "$WORK" || echo "makrai-prefix-export: WARNING: could not remove ${WORK}." >&2
  fi
  if [ "$rc" -ne 0 ]; then
    [ "${#written[@]}" -eq 0 ] || shred -u -- "${written[@]}" || echo "makrai-prefix-export: WARNING: could not shred this run's day files in ${OUT}." >&2
    echo "makrai-prefix-export: FAILED (exit ${rc}); this run's day files here are removed. Run it again before any vacuum." >&2
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

# As text: this runs as root, and the file is the operator's (T22-3).
read_env OFFSITE_AUDIT_TARGET

# The first character of the user and the host must be a letter or a digit: a value beginning
# with `-` would reach rsync as an option, and rsync would copy nowhere and exit 0 (scripts F2).
target_re='^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:([A-Za-z0-9._-]+/)*$'
[[ ${OFFSITE_AUDIT_TARGET:-} =~ $target_re ]] || die "OFFSITE_AUDIT_TARGET is not user@host: or user@host:dir/"
[ -x "$SCAN" ] || die "cannot run ${SCAN}"
[ -r "$SHAPE_FILE" ] && [ "$(grep -c '' "$SHAPE_FILE")" -eq 1 ] && [ -s "$SHAPE_FILE" ] \
  || die "${SHAPE_FILE} must hold exactly one expression"

# In /dev/shm unless TMPDIR says otherwise: tmpfs, so the list never reaches the disk.
WORK=$(mktemp -d -p "${TMPDIR:-/dev/shm}") || die "cannot make a working directory"
PATTERNS=$WORK/patterns
"$SCAN" --write-patterns "$PATTERNS" || die "the email scan would not write the pattern list (exit $?)"

install -d -m 0700 "$STATE" "$OUT"

# grep -v, with "kept nothing" (status 1) as an answer and 2 or more as a failure. -a so a
# line with odd bytes is still a line; C locale so the expression means what it says.
keep_not() {
  local rc=0
  LC_ALL=C grep -a -v "$@" || rc=$?
  [ "$rc" -le 1 ] || return "$rc"
}

# The oldest entry before R: -n +1 shows the oldest first (systemd 254 and later), and the one
# field asked for keeps the message out of this read.
oldest=$(journalctl -q --no-pager -o json -n +1 --output-fields=_BOOT_ID "--until=$R_UTC" \
  | sed -n 's/.*"__REALTIME_TIMESTAMP":"\([0-9]\{1,\}\)".*/\1/p') || die "could not read the journal"
[ -n "$oldest" ] || die "the journal holds nothing before R"
day=$(date -u -d "@$((oldest / 1000000))" +%F)

# The scrub, one sed program over each JSON line:
#   - an nginx line (the image's old "main" format) loses its referer, replaced by "-", and
#     every query string, whatever it carried, through nginx's \xHH escapes too (S3, scripts
#     F5); an nginx error-log line loses its `referrer: "..."` the same way;
#   - an invitation token is replaced by [token] after /invitations/ or /api/v1/invitations/,
#     with its separators plain or percent-encoded (%2F, %2f: a callbackUrl value).
# In the JSON text a quote from the log is \", so the referer is the \"...\" after the status
# and the byte count.
SCRUB='/"CONTAINER_NAME":"docker-nginx-1"/{s/( [0-9]{3} [0-9-]+ )\\"([^"\\]|\\[^"])*\\"/\1\\"-\\"/; s/(referrer: )\\"([^"\\]|\\[^"])*\\"/\1\\"-\\"/; s/\?([^[:space:]"\\]|\\\\x[0-9A-Fa-f]{2})*//g}
s#((/|%2[Ff])(api(/|%2[Ff])v1(/|%2[Ff]))?invitations(/|%2[Ff]))[^/[:space:]"?&%\\]+#\1[token]#g'
# After the scrub, "invitations" followed by anything token-shaped, in any encoding seen or not,
# fails the run: a token the scrub did not undo must not be shipped.
SURVIVOR='invitations(/|\\/|%2f|%252f|%5c|\\u002f)[a-z0-9_-]{16,}'

days=0
while [[ ! $day > $LAST_DAY ]]; do
  next=$(date -u -d "$day + 1 day" +%F)
  from="$day 00:00:00 UTC"
  if [[ $next > $LAST_DAY ]]; then to=$R_UTC; else to="$day 23:59:59.999999 UTC"; fi
  day_lines() { journalctl -q --no-pager -o json --all "--since=$from" "--until=$to"; }

  total=$(day_lines | wc -l) || die "could not read the journal for ${day}"
  if [ "$total" -gt 0 ]; then
    days=$((days + 1))
    file=pre-fix-$day.json.gz
    written+=("$OUT/$file")
    day_lines \
      | keep_not -F -i -f "$PATTERNS" \
      | keep_not -E -f "$SHAPE_FILE" \
      | keep_not -F '":[' \
      | sed -E "$SCRUB" \
      | gzip -9 >"$OUT/$file" \
      || die "could not write ${file}"
    kept=$(gzip -dc -- "$OUT/$file" | wc -l)
    if [ "$kept" -eq 0 ]; then
      # Every line removed: nothing to check and nothing to ship (the scan would refuse an
      # empty file, EMPTY-LOG). The day is still reported.
      rm -f -- "$OUT/$file"
      unset 'written[-1]'
    else
      found=0
      gzip -dc -- "$OUT/$file" | LC_ALL=C grep -a -E -q -i -e "$SURVIVOR" || found=$?
      case "$found" in
        0) die "an invitation token survived the scrub in ${file}" ;;
        1) ;;
        *) die "could not check ${file} for invitation tokens" ;;
      esac
      # The scan's own counts are not repeated: it must say nothing was found, or the run stops.
      "$SCAN" --file "$OUT/$file" >/dev/null || die "the email scan did not pass ${file} (exit $?)"
    fi
    echo "pre-fix-$day lines=$total kept=$kept removed=$((total - kept))"
  fi
  day=$next
done

[ "$days" -gt 0 ] || die "no day before R had any entry"
if [ "${#written[@]}" -gt 0 ]; then
  timeout 1800 rsync -a -e "$AUDITLOG_SSH" -- "${written[@]}" "$OFFSITE_AUDIT_TARGET" || die "the copy to the box failed"
  rm -f -- "${written[@]}"
fi
echo "days=${days} shipped=${#written[@]}"
