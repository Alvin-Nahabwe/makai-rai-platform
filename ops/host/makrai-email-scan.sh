#!/usr/bin/env bash
# /usr/local/sbin/makrai-email-scan.sh
# Count the account email addresses in the server's logs. RL 2.3 / 7.12 (P1, P4).
#
#   makrai-email-scan.sh [--since <time>] [--file <gz>] [--ping] [--write-patterns <file>]
#
# THE ONLY WAY AN ACCOUNT EMAIL IS CHECKED FOR. It reads every address from the database
# (users and invitations), then counts the log lines that contain one, over the journal of
# Docker (every container, whichever its tag: nextjs, postgres, nginx and the migrator, which
# is named differently on every run) and of sshd, sshd-session (OpenSSH 9.8 and later) and
# sudo, or over a gzip file.
# It never shows an address: STDOUT is exactly one line of counts, and nothing else (no
# address, no log line, no psql output) reaches stdout, stderr, argv or a log.
#
#   patterns=<n> account_hits=<n> shape_hits=<n> shape_hits_nginx=<n>
#
#   patterns          how many distinct addresses were read from the database
#   account_hits      log lines containing one of those addresses, in any letter case,
#                     from any source
#   shape_hits        log lines containing anything shaped like an address, whether or not
#                     it is an account, from every source except the nginx container
#   shape_hits_nginx  the same, from the nginx container's lines alone (R22-3). Any client
#                     can put an address-shaped string in a request path, which nginx logs,
#                     so these are reported and never fail the run. A line is nginx's only
#                     when it carries both CONTAINER_NAME=docker-nginx-1 and the trusted
#                     _SYSTEMD_UNIT=docker.service: a local process can send the first, never
#                     the second (S4). Both counts are made directly; shape_hits is never
#                     "everything minus nginx" (it reads the export format, through python3,
#                     to tell the two apart). A --file scan has no fields to tell nginx apart,
#                     so there this is always 0 and every address-shaped line counts in
#                     shape_hits.
#
# The counts line is printed last, after anything the ping or the alert printed: root's
# crontab appends both streams to /var/log/makrai/email-scan.log, whose last line is the
# evidence (Task 25).
#
# EXIT STATUS
#   0   scanned, nothing found
#   1   scanned, something found: an account hit anywhere, or a shape hit outside nginx
#       (counts are on stdout). Nothing else exits 1.
#   2   refused to scan, with EMPTY-PATTERNS or EMPTY-LOG on stderr (see below)
#   3   failed: the database, the journal or the file could not be read, or any other
#       command failed unexpectedly (stderr says near which line)
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
# --since <time>        journalctl's own time syntax, resolved once to an absolute time (by
#                       systemd-analyze), so every pass reads the same span. Not valid with
#                       --file.
# --file <gz>           scan this gzip file instead of the journal.
# --ping                report to the dead-man check (HC_EMAILSCAN_PING_URL in the server
#                       .env, which it reads as text and never runs, T22-3): a success ping on
#                       exit 0; a /fail ping and an alert on
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

# --since is resolved ONCE, here, to an absolute time (journalctl's own syntax, read by
# systemd-analyze), so that `-26h` cannot mean a different instant in each pass below.
SINCE_AT=
if [ -n "$SINCE" ]; then
  SINCE_AT=$(systemd-analyze timestamp -- "$SINCE" 2>/dev/null | sed -n 's/^ *UNIX seconds: @\([0-9]\{1,\}\).*/\1/p') || true
  [ -n "$SINCE_AT" ] || usage
fi

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# Installed, this script is in /usr/local/sbin and the library in /usr/local/bin. A copy
# beside this script is used first, which is how the tests and a run from the repository
# find it.
LIBDIR=$HERE
[ -r "$LIBDIR/makrai-lib.sh" ] || LIBDIR=/usr/local/bin
[ -r "$LIBDIR/makrai-lib.sh" ] || { echo "makrai-email-scan: cannot read makrai-lib.sh, beside this script or in /usr/local/bin." >&2; exit 3; }
# shellcheck source=makrai-lib.sh
. "$LIBDIR/makrai-lib.sh"

WORK=       # mode-700 directory holding the pattern list and psql's stderr
COMPLETED=  # set by the last statement of a clean run, and by nothing else
HITS=       # set when the scan found something
COUNTS=     # the counts line, printed last by finish()
ERR_LINE=   # the line of the last command that failed outside a test, for the report below
trap 'ERR_LINE=$LINENO' ERR

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
  # Status 1 means "found something" and nothing else. A command that fails without a
  # handler of its own (`set -e`) also exits 1, and a caller who reads that as a finding is
  # misled either way, so it becomes 3 here, with the line it happened near.
  if [ "$rc" -eq 1 ] && [ -z "$HITS" ]; then
    echo "makrai-email-scan: failed unexpectedly (a command exited non-zero near line ${ERR_LINE:-unknown})." >&2
    rc=3
  fi
  if [ "$PING" = 1 ]; then
    if [ "$rc" -eq 0 ] && [ "$COMPLETED" = 1 ]; then
      ping_ok HC_EMAILSCAN_PING_URL || { echo "makrai-email-scan: the success ping could not be sent." >&2; rc=3; }
    else
      ping_fail HC_EMAILSCAN_PING_URL || echo "makrai-email-scan: the failure ping could not be sent." >&2
      if [ "$rc" -eq 1 ] && [ -n "$HITS" ]; then alert "email scan found addresses in the logs"
      elif [ "$rc" -eq 2 ]; then alert "email scan refused to run"
      else alert "email scan failed"
      fi
    fi
  fi
  [ -z "$COUNTS" ] || printf '%s\n' "$COUNTS"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM

# After the trap, so that a .env that cannot be read is reported as a failure (status 3) and
# not as the bare `set -e` status 1 that means "found something". As text: this runs as root,
# and the file is the operator's (T22-3).
read_env POSTGRES_USER POSTGRES_DB HC_EMAILSCAN_PING_URL RESEND_API_KEY ADMIN_EMAIL EMAIL_FROM_ADDRESS

# --- The shape expression: one line, in the file beside this script ---
SHAPE_FILE="$HERE/email-shape.regex"
[ -r "$SHAPE_FILE" ] || die "cannot read ${SHAPE_FILE}"
# Exactly one line. A blank line would make `grep -f` (here, and in Task 22's export) match
# everything; two expressions would be a different scan from the one the tests describe.
[ "$(grep -c '' "$SHAPE_FILE")" -eq 1 ] || die "${SHAPE_FILE} must hold exactly one line"
SHAPE=$(<"$SHAPE_FILE")
[ -n "$SHAPE" ] || die "${SHAPE_FILE} is empty"

# --- The pattern list: every address the platform knows, lowercased ---
# In /dev/shm unless TMPDIR says otherwise: it is tmpfs, so the list of every account address
# is never written to the disk. (/tmp is ext4 on the host, `shred` is best effort on a
# journaling filesystem, and a SIGKILL would leave the file until tmp cleanup.)
TMP_BASE=${TMPDIR:-/dev/shm}
WORK=$(mktemp -d -p "${TMPDIR:-/dev/shm}") || die "cannot make a working directory in ${TMP_BASE}"   # mode 700
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
  # directory it fails instead of dropping a file named "patterns" inside it. "--" ends the
  # options, so a value such as --help is a file name and not install's own flag. The caller
  # owns the file now.
  install -T -m 600 -- "$PATTERNS" "$WRITE" || die "could not write ${WRITE}"
  echo "patterns=$N"
  COMPLETED=1
  exit 0
fi

# --- The logs ---
# One end for every pass below, and one start (SINCE_AT, above), so the counts describe the
# same span.
UNTIL=$(date -u '+%Y-%m-%d %H:%M:%S UTC')

source_lines() {
  if [ -n "$FILE" ]; then
    gzip -dc -- "$FILE"
  else
    # Docker's journald driver writes from dockerd, so one unit match covers every container
    # whatever its tag (the migrator's is different on every run, and journalctl has no
    # wildcard). "+" separates two groups of matches that are OR'd; within a group, two
    # values of the same field are OR'd too. `-o cat` prints the message and nothing else.
    journalctl --no-pager -o cat ${SINCE_AT:+"--since=@$SINCE_AT"} "--until=$UNTIL" \
      _SYSTEMD_UNIT=docker.service \
      + _COMM=sshd _COMM=sshd-session _COMM=sudo
  fi
}

# The nginx container's lines alone, over the same window: its name, which Docker's journald
# driver records (compose names it docker-nginx-1, the project being the directory docker/, as
# for docker-postgres-1 above), AND the trusted unit. Two fields in one group are AND-ed. Any
# local process can send a CONTAINER_NAME field; only journald sets _SYSTEMD_UNIT (S4).
nginx_lines() {
  journalctl --no-pager -o cat ${SINCE_AT:+"--since=@$SINCE_AT"} "--until=$UNTIL" \
    _SYSTEMD_UNIT=docker.service CONTAINER_NAME=docker-nginx-1
}

# Every source's lines EXCEPT the nginx container's, counted directly, never as all minus
# nginx (S4). journalctl cannot negate a match, so the same sources are read in export format
# and each record's MESSAGE is written out, raw, unless that record is the nginx container's by
# the same two fields. The bytes are the message's own, as `-o cat` prints them. A --file has
# no fields to tell nginx apart, so all of it counts here.
other_lines() {
  if [ -n "$FILE" ]; then
    gzip -dc -- "$FILE"
    return
  fi
  journalctl --no-pager -o export ${SINCE_AT:+"--since=@$SINCE_AT"} "--until=$UNTIL" \
    _SYSTEMD_UNIT=docker.service \
    + _COMM=sshd _COMM=sshd-session _COMM=sudo \
    | python3 -c '
import sys
src, out = sys.stdin.buffer, sys.stdout.buffer
rec = {}
def done():
    msg = rec.get(b"MESSAGE")
    nginx = rec.get(b"_SYSTEMD_UNIT") == b"docker.service" and rec.get(b"CONTAINER_NAME") == b"docker-nginx-1"
    if msg is not None and not nginx:
        out.write(msg + b"\n")
while True:
    line = src.readline()
    if not line:
        if rec:
            sys.exit("other_lines: the export ends inside a record")
        break
    if not line.endswith(b"\n"):
        sys.exit("other_lines: the export ends inside a field")
    line = line[:-1]
    if line == b"":
        done()
        rec = {}
    elif b"=" in line:
        name, value = line.split(b"=", 1)
        rec[name] = value
    else:
        size = int.from_bytes(src.read(8), "little")
        value = src.read(size)
        if len(value) != size or src.read(1) != b"\n":
            sys.exit("other_lines: the export ends inside a binary field")
        rec[line] = value
'
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
SHAPE_HITS=$(other_lines | count_matches -E -e "$SHAPE") || die "$READ_FAILED"
SHAPE_NGINX=0
if [ -z "$FILE" ]; then
  SHAPE_NGINX=$(nginx_lines | count_matches -E -e "$SHAPE") || die "$READ_FAILED"
fi

COUNTS=$(printf 'patterns=%s account_hits=%s shape_hits=%s shape_hits_nginx=%s' "$N" "$ACCOUNT_HITS" "$SHAPE_HITS" "$SHAPE_NGINX")

if [ "$ACCOUNT_HITS" -gt 0 ] || [ "$SHAPE_HITS" -gt 0 ]; then
  HITS=1
  exit 1
fi
# Set by the last statement of the script, and by nothing else.
COMPLETED=1
