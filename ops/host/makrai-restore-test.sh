#!/usr/bin/env bash
# /usr/local/bin/makrai-restore-test.sh
# Prove that the newest OFF-SITE backup restores, and restores to what is live.
#
# Runs from the operator's crontab at 01:00 UTC, half an hour after
# makrai-offsite-copy.sh, and reports to its own dead-man check
# (HC_RESTORE_PING_URL). A backup nobody has restored is a hope, and this is the
# restore: it fetches the file from the Storage Box (so the copy that would be
# used in a disaster is the copy that is tested), decrypts it, loads it into a
# throwaway cluster, and compares that cluster with the live one.
#
# STDOUT is exactly one line, and never data from the database:
#   RESTORE MATCH
#   RESTORE MISMATCH <field>
# Everything else, including every error, goes to /srv/makrai/restore-test.log
# (mode 600): psql's errors can quote the row that failed to load. The log ends
# with `Restore test PASSED` or `Restore test FAILED: <field>`, and before that
# it records `fetched=<name> age_min=<n>`, the evidence that the file tested was
# the fresh off-site one.
#
# The live database is only ever READ, with a SELECT that returns one count.
# The throwaway cluster has no network, keeps its data in memory, and is removed
# when the script exits, however it exits.
set -Eeuo pipefail
cd /
umask 077

# Fixed before .env is sourced and read-only, so a line in .env cannot move the
# log or loosen the age limit.
readonly LOG=/srv/makrai/restore-test.log
# 26 hours: a nightly copy plus two hours of slack. An older newest file means
# the off-site copy has stopped, and testing it would prove nothing about today.
readonly RESTORE_MAX_AGE_MIN=1560
touch "$LOG"
chmod 600 "$LOG"
# fd 4 is the real stdout. From here every other byte, stdout or stderr, goes to
# the log, so nothing but the result line can reach the session or cron's mail.
exec 4>&1 >>"$LOG" 2>&1
log() { echo "[$(date -Is)] $*" >>"$LOG"; }

HERE=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")
# shellcheck source=makrai-lib.sh
. "$HERE/makrai-lib.sh"
load_env

STAGE=setup   # the step in progress; names the failure when nothing else does
FIELD=        # what mismatched, when something did
WORK=         # mode-700 temp directory holding the one encrypted file
NAME=         # the throwaway container

# Called for a failed comparison. Exiting runs the EXIT trap, which does the rest.
fail() { FIELD=$1; exit 1; }

# One cleanup for every way out. A failure to clean is logged and never changes
# the verdict.
cleanup() {
  if [ -n "$NAME" ]; then
    docker rm -fv "$NAME" || log "WARNING: could not remove container ${NAME}."
  fi
  if [ -n "$WORK" ] && [ -d "$WORK" ]; then
    find "$WORK" -type f -exec shred -u {} + || log "WARNING: could not shred the temp files in ${WORK}."
    rmdir "$WORK" || log "WARNING: could not remove ${WORK}."
  fi
}

# EXIT, not ERR: it also catches `set -u` violations and a failing `.`.
finish() {
  local rc=$?
  trap - EXIT
  set +e
  cleanup
  if [ "$rc" -eq 0 ] && [ -z "$FIELD" ]; then
    ping_ok HC_RESTORE_PING_URL || log "WARNING: the dead-man ping failed -- the restore is fine, but an absent ping will raise a false alarm."
    log "Restore test PASSED"
    echo "RESTORE MATCH" >&4
    exit 0
  fi
  FIELD=${FIELD:-$STAGE}
  ping_fail HC_RESTORE_PING_URL || log "WARNING: could not report the failure to the dead-man check."
  alert "restore test FAILED: ${FIELD}"
  log "Restore test FAILED: ${FIELD}"
  echo "RESTORE MISMATCH ${FIELD}" >&4
  exit 1
}
trap finish EXIT

log "Starting restore test..."
[ -n "${OFFSITE_TARGET:-}" ] || fail setup
[ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_DB:-}" ] || fail setup
[ -n "${BACKUP_PASSPHRASE:-}" ] || fail setup

# --- 1. Fetch the newest file from the Storage Box, and refuse a stale one ---
STAGE=fetch
WORK=$(mktemp -d)   # mktemp -d creates the directory mode 700
TARGET="${OFFSITE_TARGET%/}/"
# Only names in the exact form the backup writes, makrai-YYYYMMDD-HHMMSS.sql.gz.gpg,
# are candidates: they sort by time, and a hand-named file or an odd name from the
# listing can neither be picked as "newest" nor reach a path below. (grep -E, not
# awk: the default awk on Ubuntu 22.04 is mawk, which may not read {8}.)
NEWEST=$(timeout 300 rsync --list-only --include='makrai-*.sql.gz.gpg' --exclude='*' -e "$OFFSITE_SSH" "$TARGET" \
         | awk '{print $NF}' | grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | sort | tail -1)
[ -n "$NEWEST" ] || fail fetch
timeout 600 rsync -t -e "$OFFSITE_SSH" "${TARGET}${NEWEST}" "$WORK/"

# The file's own modification time, kept across both copies by rsync -t / -a: the
# moment the backup was written, not the moment it was fetched.
AGE_MIN=$(( ( $(date +%s) - $(stat -c %Y "$WORK/$NEWEST") ) / 60 ))
log "fetched=${NEWEST} age_min=${AGE_MIN}"
[ "$AGE_MIN" -gt "$RESTORE_MAX_AGE_MIN" ] && fail age

# --- 2. A throwaway cluster, from the image the live one runs ---
STAGE=cluster
NAME="makrai-restore-test-$$"
IMAGE=$(docker inspect -f '{{.Image}}' docker-postgres-1)
# The superuser is the backup's owner, because the dump carries `ALTER ... OWNER
# TO <owner>` and a cluster owned by anyone else fails on the first of them. The
# password is random and used once. load_env exported the REAL POSTGRES_PASSWORD,
# so the value is set for this one command and passed on by name: a bare
# `-e POSTGRES_PASSWORD` would otherwise hand the production password to a
# container that has no use for it.
POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')" \
  docker run -d --name "$NAME" --network none \
    --mount type=tmpfs,destination=/var/lib/postgresql/data \
    -e POSTGRES_USER="$POSTGRES_USER" -e POSTGRES_DB="$POSTGRES_DB" -e POSTGRES_PASSWORD \
    "$IMAGE" >>"$LOG" 2>&1

# The image starts a temporary server on its socket to initialise, then restarts
# for good. Only the final one listens on TCP, so ask it there.
for _ in $(seq 1 90); do
  docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" && break
  sleep 1
done
docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" || fail cluster

# --- 3. Roles: cluster-level, so the dump has the GRANTs and not the CREATE ROLE ---
# Derived from the migrations at run time, so a role added later is created here
# without anyone remembering to edit this script.
STAGE=roles
ROLES=$(grep -hoE 'CREATE ROLE [a-z_]+' /srv/makrai/app/prisma/migrations/*/migration.sql | awk '{print $3}' | sort -u)
for role in $ROLES; do
  docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "CREATE ROLE ${role} NOLOGIN" >>"$LOG" 2>&1
done

# --- 4. Decrypt and load. The passphrase travels on fd 3, never in argv ---
# ON_ERROR_STOP: without it psql carries on past an error and exits 0, producing
# a restore that reports success with objects missing.
STAGE=restore
gpg --batch --decrypt --passphrase-fd 3 "$WORK/$NEWEST" 3<<<"$BACKUP_PASSPHRASE" 2>>"$LOG" \
  | gunzip 2>>"$LOG" \
  | timeout 900 docker exec -i "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 >>"$LOG" 2>&1

# --- 5. Compare with live. Counts only: a count is not a row ---
STAGE=compare
live_policies=$(docker exec docker-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_policies WHERE schemaname='public'" 2>>"$LOG")
rest_policies=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_policies WHERE schemaname='public'" 2>>"$LOG")
[[ $live_policies =~ ^[0-9]+$ && $rest_policies =~ ^[0-9]+$ ]] && [ "$live_policies" = "$rest_policies" ] || fail policies

live_migrations=$(docker exec docker-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM _prisma_migrations" 2>>"$LOG")
rest_migrations=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM _prisma_migrations" 2>>"$LOG")
[[ $live_migrations =~ ^[0-9]+$ && $rest_migrations =~ ^[0-9]+$ ]] && [ "$live_migrations" = "$rest_migrations" ] || fail migrations

# A schema-only dump restores without a single error and matches on both counts
# above. These two are what say there is data in it.
rest_users=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM users" 2>>"$LOG")
[[ $rest_users =~ ^[0-9]+$ ]] && [ "$rest_users" -gt 0 ] || fail users
rest_orgs=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM organizations" 2>>"$LOG")
[[ $rest_orgs =~ ^[0-9]+$ ]] && [ "$rest_orgs" -gt 0 ] || fail organizations

# Falling off the end exits 0, and `finish` reports the pass.
