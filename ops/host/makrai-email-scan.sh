#!/usr/bin/env bash
# /usr/local/sbin/makrai-email-scan.sh
# Count the account email addresses in the server's logs. RL 2.3 / 7.12 (P1, P4).
#
#   makrai-email-scan.sh [--since <time>] [--file <gz>] [--ping] [--write-patterns <file>]
#
# THE ONLY WAY AN ACCOUNT EMAIL IS CHECKED FOR. It reads every address from the database
# (users and invitations), then counts the log lines that contain one, over the journal of
# the three containers (nextjs, postgres, nginx) and of sshd and sudo, or over a gzip file.
# It never shows an address: STDOUT is exactly one line of counts, and nothing else (no
# address, no log line, no psql output) reaches stdout, stderr, argv or a log.
#
#   patterns=<n> account_hits=<n> shape_hits=<n>
#
#   patterns      how many distinct addresses were read from the database
#   account_hits  log lines containing one of those addresses, in any letter case
#   shape_hits    log lines containing anything shaped like an address, whether or not it
#                 is an account (a crawler's contact address in a user agent counts here)
#
# EXIT STATUS
#   0   scanned, nothing found
#   1   scanned, something found (counts are on stdout)
#   2   refused to scan, with EMPTY-PATTERNS or EMPTY-LOG on stderr (see below)
#   3   failed: the database, the journal or the file could not be read
#   64  bad arguments
#
# IT REFUSES RATHER THAN REPORT A ZERO IT CANNOT STAND BEHIND. A scan with no patterns, or
# one that read no log line, finds nothing and would say so:
#   EMPTY-PATTERNS  the pattern list is empty, shorter than the users table, or has a blank
#                   line (which grep -F reads as a pattern that matches every line)
#   EMPTY-LOG       no log line was read at all: a wrong tag, an unreadable journal, or a
#                   window with nothing in it
# Run it as an account that can read the WHOLE system journal and use docker (root, or a
# member of systemd-journal and docker). journalctl does not fail for one that cannot: it
# shows what that account may see. A window with nothing in it is caught (EMPTY-LOG); a
# partial view is not, so check the account once before relying on a zero.
#
# --since <time>        journalctl's own time syntax. Not valid with --file.
# --file <gz>           scan this gzip file instead of the journal.
# --ping                report to the dead-man check (HC_EMAILSCAN_PING_URL in the server
#                       .env): a success ping on exit 0; a /fail ping and an alert on
#                       anything else, or if the ping itself cannot be sent.
# --write-patterns <f>  write the guarded pattern list to <f> (mode 600) and stop. For the
#                       export in Task 22, which owns the file afterwards and must remove it.
#
# The email-shape expression is read at run time from email-shape.regex, beside this script.
# There is deliberately no copy of it here (D-09): lib/redact.ts holds the same text, and a
# test keeps the two equal.
set -Eeuo pipefail
umask 077

usage() {
  echo "usage: makrai-email-scan.sh [--since <time>] [--file <gz>] [--ping] [--write-patterns <file>]" >&2
  exit 64
}

SINCE=
FILE=
PING=0
WRITE=
while [ $# -gt 0 ]; do
  case "$1" in
    --since)          [ $# -ge 2 ] && [ -n "$2" ] || usage; SINCE=$2; shift 2 ;;
    --file)           [ $# -ge 2 ] && [ -n "$2" ] || usage; FILE=$2; shift 2 ;;
    --write-patterns) [ $# -ge 2 ] && [ -n "$2" ] || usage; WRITE=$2; shift 2 ;;
    --ping)           PING=1; shift ;;
    *)                usage ;;
  esac
done
# Two sources, or a list-only run asked to scan or to ping, is a mistake. Refused, because
# ignoring one of the two silently is how a scan ends up looking at the wrong thing.
{ [ -z "$FILE" ] || [ -z "$SINCE" ]; } || usage
[ -z "$WRITE" ] || { [ "$PING" = 0 ] && [ -z "$FILE" ] && [ -z "$SINCE" ]; } || usage

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Installed, this script is in /usr/local/sbin and the library in /usr/local/bin. A copy
# beside this script is used first, which is how the tests and a run from the repository
# find it.
LIB="$HERE/makrai-lib.sh"
[ -r "$LIB" ] || LIB=/usr/local/bin/makrai-lib.sh
# shellcheck source=makrai-lib.sh
. "$LIB"
load_env

WORK=       # mode-700 directory holding the pattern list and psql's stderr
COMPLETED=  # set by the last statement of a clean run, and by nothing else
HITS=       # set when the scan found something

die()    { echo "makrai-email-scan: $*" >&2; exit 3; }
refuse() { echo "makrai-email-scan: $1: $2" >&2; exit 2; }

# Shred the pattern list, then remove the directory. A failure to clean is reported and
# never changes the verdict.
cleanup() {
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    find "$WORK" -type f -exec shred -u {} + || echo "makrai-email-scan: WARNING: could not shred the temp files in ${WORK}." >&2
    rmdir "$WORK" || echo "makrai-email-scan: WARNING: could not remove ${WORK}." >&2
  fi
}

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`. Every alert subject
# is fixed text: no count, no line, no address.
finish() {
  local rc=$?
  trap - EXIT
  trap '' HUP INT TERM   # a second signal must not cut the cleanup and the report short
  set +e
  cleanup
  if [ "$PING" = 1 ]; then
    if [ "$rc" -eq 0 ] && [ "$COMPLETED" = 1 ]; then
      ping_ok HC_EMAILSCAN_PING_URL || { echo "makrai-email-scan: the success ping could not be sent." >&2; rc=1; }
    else
      ping_fail HC_EMAILSCAN_PING_URL || echo "makrai-email-scan: the failure ping could not be sent." >&2
      if [ "$rc" -eq 1 ] && [ -n "$HITS" ]; then alert "email scan found addresses in the logs"
      elif [ "$rc" -eq 2 ]; then alert "email scan refused to run"
      else alert "email scan failed"
      fi
    fi
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

# --- The shape expression: one line, in the file beside this script ---
SHAPE_FILE="$HERE/email-shape.regex"
[ -r "$SHAPE_FILE" ] || die "cannot read ${SHAPE_FILE}"
# Exactly one line. A blank line would make `grep -f` (here, and in Task 22's export) match
# everything; two expressions would be a different scan from the one the tests describe.
[ "$(grep -c '' "$SHAPE_FILE")" -eq 1 ] || die "${SHAPE_FILE} must hold exactly one line"
SHAPE=$(<"$SHAPE_FILE")
[ -n "$SHAPE" ] || die "${SHAPE_FILE} is empty"

# --- The pattern list: every address the platform knows, lowercased ---
WORK=$(mktemp -d)   # mktemp -d creates the directory mode 700
PATTERNS="$WORK/patterns"
ERRS="$WORK/psql.err"

# As the database owner, in the postgres container. psql's own stderr goes to a file in
# the directory that is shredded on exit, never to the session: nothing a database says is
# shown. A failure is reported by status alone.
psql_run() { # $1 = SQL
  docker exec docker-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$1" 2>>"$ERRS"
}

psql_run 'select lower(email) from users union select lower(email) from invitations' >"$PATTERNS" \
  || die "the pattern query failed (docker exec or psql exited $?)"
USERS=$(psql_run 'select count(*) from users') || die "the users count failed (docker exec or psql exited $?)"
case "$USERS" in ''|*[!0-9]*) die "the users count was not a number" ;; esac

# The guard (Review Focus 3). Three ways a list is unfit to scan with, each of which would
# let the scan say "0" over logs full of accounts.
[ -s "$PATTERNS" ] || refuse EMPTY-PATTERNS "the pattern list is empty"
N=$(grep -c '' "$PATTERNS")
[ "$N" -ge "$USERS" ] || refuse EMPTY-PATTERNS "the pattern list has fewer lines than the users table"
blank=0
grep -qx '' "$PATTERNS" || blank=$?
case "$blank" in
  0) refuse EMPTY-PATTERNS "the pattern list has a blank line" ;;
  1) ;;
  *) die "could not check the pattern list for a blank line" ;;
esac

if [ -n "$WRITE" ]; then
  # `install` replaces the destination rather than writing through whatever is there, and
  # the umask above makes it mode 600 from the first byte. -T makes <file> a file: given a
  # directory it fails instead of dropping a file named "patterns" inside it. The caller
  # owns the file now.
  install -T -m 600 "$PATTERNS" "$WRITE" || die "could not write ${WRITE}"
  echo "patterns=$N"
  COMPLETED=1
  exit 0
fi

# --- The logs ---
# One end for every pass below, so the three counts describe the same lines.
UNTIL=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

source_lines() {
  if [ -n "$FILE" ]; then
    gzip -dc -- "$FILE"
  else
    # "+" separates two groups of matches that are OR'd; within a group, two values of the
    # same field are OR'd too. `-o cat` prints the message and nothing else.
    journalctl --no-pager -o cat ${SINCE:+"--since=$SINCE"} "--until=$UNTIL" \
      CONTAINER_TAG=makrai/docker-nextjs-1 \
      CONTAINER_TAG=makrai/docker-postgres-1 \
      CONTAINER_TAG=makrai/docker-nginx-1 \
      + _COMM=sshd _COMM=sudo
  fi
}

# The number of lines on stdin that match, printed alone. `grep -c` prints the count and
# exits 1 when it is zero, which is an answer; 2 or more is grep failing, which is not.
# -a so a line with odd bytes is still a line, and LC_ALL=C so `A-Za-z` means the ASCII
# letters whatever locale the host runs in.
count_matches() {
  local n rc=0
  n=$(LC_ALL=C grep -a -c "$@") || rc=$?
  [ "$rc" -le 1 ] || return "$rc"
  printf '%s\n' "$n"
}

READ_FAILED="could not read the logs (journalctl or --file failed)"
LOG_LINES=$(source_lines | count_matches '') || die "$READ_FAILED"
[ "$LOG_LINES" -gt 0 ] || refuse EMPTY-LOG "no log line was read, so there is nothing to say about them"
ACCOUNT_HITS=$(source_lines | count_matches -iFf "$PATTERNS") || die "$READ_FAILED"
SHAPE_HITS=$(source_lines | count_matches -E -e "$SHAPE") || die "$READ_FAILED"

printf 'patterns=%s account_hits=%s shape_hits=%s\n' "$N" "$ACCOUNT_HITS" "$SHAPE_HITS"

if [ "$ACCOUNT_HITS" -gt 0 ] || [ "$SHAPE_HITS" -gt 0 ]; then
  HITS=1
  exit 1
fi
# Set by the last statement of the script, and by nothing else.
COMPLETED=1
