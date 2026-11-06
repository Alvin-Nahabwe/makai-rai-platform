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
# Set by the last statement of the script, and by nothing else.
COMPLETED=

# Called for a failed comparison; the optional second argument is logged (never
# printed). Exiting runs the EXIT trap, which does the rest.
fail() { FIELD=$1; [ -z "${2:-}" ] || log "$1: $2"; exit 1; }

# A signal ends the run as a failure. Bash runs the EXIT trap after a signal with
# $? left over from the last command that finished, usually 0, so the exit status
# cannot be what tells a finished run from a killed one: that is COMPLETED.
interrupted() { FIELD=interrupted; exit 1; }

# One cleanup for every way out. A failure to clean is logged and never changes
# the verdict.
cleanup() {
  if [ -n "$NAME" ]; then
    docker rm -fv "$NAME" || log "WARNING: could not remove container ${NAME}."
    # The seal-check container, if the signal timeout sent did not stop it. Absent after a normal run, so
    # a failure here is expected and is not logged.
    timeout 30 docker rm -f "${NAME}-seal" >/dev/null 2>&1 || true
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
  trap '' HUP INT TERM   # a second signal must not cut the cleanup and the report short
  set +e
  cleanup
  # Only a run that reached its last statement can pass. Anything else that exits 0
  # was stopped part-way (a signal, or an early exit), and has compared nothing.
  if [ "$rc" -eq 0 ] && [ -z "$FIELD" ] && [ "$COMPLETED" = 1 ]; then
    ping_ok HC_RESTORE_PING_URL || log "WARNING: the dead-man ping failed -- the restore is fine, but an absent ping will raise a false alarm."
    log "Restore test PASSED"
    echo "RESTORE MATCH" >&4
    exit 0
  fi
  [ "$rc" -eq 0 ] && FIELD=interrupted
  FIELD=${FIELD:-$STAGE}
  ping_fail HC_RESTORE_PING_URL || log "WARNING: could not report the failure to the dead-man check."
  alert "restore test FAILED: ${FIELD}"
  log "Restore test FAILED: ${FIELD}"
  echo "RESTORE MISMATCH ${FIELD}" >&4
  exit 1
}
trap finish EXIT
trap interrupted HUP INT TERM

log "Starting restore test..."
[ -n "${OFFSITE_TARGET:-}" ] || fail setup
[ -n "${POSTGRES_USER:-}" ] && [ -n "${POSTGRES_DB:-}" ] || fail setup
[ -n "${BACKUP_PASSPHRASE:-}" ] || fail setup

# --- 1. Fetch the newest file from the Storage Box, and refuse a stale one ---
STAGE=fetch
WORK=$(mktemp -d)   # mktemp -d creates the directory mode 700
# OFFSITE_TARGET is either `user@host:` (an empty path: the sub-account's home) or
# `user@host:dir/`. A file name is appended directly after `:` or `/`, and a
# target written without the trailing slash gets one. Never add a slash after a
# bare `:`: `user@host:/` is the root of the box, not the home.
TARGET=$OFFSITE_TARGET; [[ $TARGET == *: || $TARGET == */ ]] || TARGET+=/
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
# without anyone remembering to edit this script. The grep is 4.2a's of
# backup-restore.md: a name followed by its LOGIN or NOLOGIN, so a comment that
# mentions CREATE ROLE is not read as a role. Every role is NOLOGIN here; the NOLOGIN
# set is kept for the live check in step 5.
STAGE=roles
ROLES=$(grep -hoE 'CREATE ROLE [a-z_]+ (NO)?LOGIN' /srv/makrai/app/prisma/migrations/*/migration.sql | awk '{print $3}' | sort -u)
NOLOGIN_ROLES=$(grep -hoE 'CREATE ROLE [a-z_]+ (NO)?LOGIN' /srv/makrai/app/prisma/migrations/*/migration.sql | awk '$4 == "NOLOGIN" {print $3}' | sort -u)
[ -n "$NOLOGIN_ROLES" ] || fail roles "no NOLOGIN role found in the migrations"
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
[[ $live_policies =~ ^[0-9]+$ && $rest_policies =~ ^[0-9]+$ ]] && [ "$live_policies" = "$rest_policies" ] || fail policies "live=${live_policies} restored=${rest_policies}"

live_migrations=$(docker exec docker-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM _prisma_migrations" 2>>"$LOG")
rest_migrations=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM _prisma_migrations" 2>>"$LOG")
[[ $live_migrations =~ ^[0-9]+$ && $rest_migrations =~ ^[0-9]+$ ]] && [ "$live_migrations" = "$rest_migrations" ] || fail migrations "live=${live_migrations} restored=${rest_migrations}"

# A schema-only dump restores without a single error and matches on both counts
# above. These two are what say there is data in it.
rest_users=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM users" 2>>"$LOG")
[[ $rest_users =~ ^[0-9]+$ ]] && [ "$rest_users" -gt 0 ] || fail users "restored=${rest_users}"
rest_orgs=$(docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM organizations" 2>>"$LOG")
[[ $rest_orgs =~ ^[0-9]+$ ]] && [ "$rest_orgs" -gt 0 ] || fail organizations "restored=${rest_orgs}"

# The roles a migration creates NOLOGIN own the SECURITY DEFINER functions and are reached only
# through them (SRS 9.5). On the live cluster none may be able to log in: a fresh-cluster restore
# that created them LOGIN would have left them so, and migrate deploy does not reset them. The names
# come from the grep above ([a-z_]+ only).
nologin_in=$(printf "'%s'," $NOLOGIN_ROLES); nologin_in=${nologin_in%,}
live_logins=$(docker exec docker-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_roles WHERE rolcanlogin AND rolname IN (${nologin_in})" 2>>"$LOG")
[[ $live_logins =~ ^[0-9]+$ ]] && [ "$live_logins" = 0 ] || fail logins "live=${live_logins}"

# --- 6. Every seal, checked on the restored copy (NFR-INT-07) ---
# The check is the application's own code: lib/integrity/sealCheck.mjs and canonical.mjs, installed
# beside seal-check.mjs in /usr/local/lib/makrai from the stage (with lib/findings/state.mjs, the one
# module sealCheck.mjs imports from outside lib/integrity/) and run by node in the image the live
# web container runs, in a container with no network and a read-only root, from root's installed
# copies and never the operator's checkout (T22-3). The SQL of the sealed tables is the module's own
# (SEAL_SOURCE_SQL), written out by `seal-check.mjs plan`: no SQL of a sealed table lives here.
# Five steps, each under `timeout --kill-after=10 300`; a non-zero exit of any, a timeout (124) included, is
# `fail seals`, through set -e and the EXIT trap, because STAGE names the step in progress.
# The check prints counts and, per failure, a seal id and a field path: its lines go to the log.
# The rows themselves are only ever on a pipe: psql's output goes straight into the check.
STAGE=seals
SEAL_IMAGE=$(timeout 30 docker inspect -f '{{.Image}}' docker-nextjs-1)
# --init: node as PID 1 cannot die of SIGTERM (its handler re-raises the signal, and the init of a PID
# namespace ignores a signal whose action is the default), so without tini the signal that `timeout`
# sends would not stop the check. --name lets cleanup() remove it.
# --mount type=bind, not -v: a missing source fails the run at once and creates nothing on the host.
SEAL_RUN=(docker run --rm -i --init --name "${NAME}-seal" --pull never --network none --read-only --cap-drop ALL
  --security-opt no-new-privileges
  --mount type=bind,src=/usr/local/lib/makrai/seal-check.mjs,dst=/ops/ops/host/seal-check.mjs,readonly
  --mount type=bind,src=/usr/local/lib/makrai/integrity,dst=/ops/lib/integrity,readonly
  --mount type=bind,src=/usr/local/lib/makrai/findings,dst=/ops/lib/findings,readonly
  --entrypoint node "$SEAL_IMAGE" /ops/ops/host/seal-check.mjs)
# 1. the organisation ids (ids only; the only SQL this script writes for the check), and the number of
#    rows of seals, which the check must account for (a row with no organisation would be in neither)
ORG_IDS=$(timeout --kill-after=10 300 docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -c 'SELECT DISTINCT "orgId" FROM seals ORDER BY 1')
SEAL_ROWS=$(timeout --kill-after=10 300 docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -c 'SELECT count(*) FROM seals')
[[ $SEAL_ROWS =~ ^[0-9]+$ ]] || fail seals "seal_rows=${SEAL_ROWS}"
# The count and the export run as the cluster's bootstrap superuser, which bypasses row security. Pin that:
# a role subject to the tenant policies would see no rows in either, and seals=0 would equal a count of 0.
SEAL_ROLE=$(timeout --kill-after=10 300 docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -c 'SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user')
[ "$SEAL_ROLE" = t ] || fail seals "the seal count runs as a role subject to row security"
log "seal_rows=${SEAL_ROWS}"
# 2. the plan: a psql script made from the module's statements
{ [ -z "$ORG_IDS" ] || printf '%s\n' "$ORG_IDS"; } | timeout --kill-after=10 300 "${SEAL_RUN[@]}" plan >"$WORK/seal-plan.sql"
# 3 and 4. the rows, from the plan, into the check; its lines (counts, ids, paths) are logged
CHECK_RC=0
CHECK_OUT=$(timeout --kill-after=10 300 docker exec -i "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -v ON_ERROR_STOP=1 -f - <"$WORK/seal-plan.sql" \
  | timeout --kill-after=10 300 "${SEAL_RUN[@]}" check) || CHECK_RC=$?
printf '%s\n' "$CHECK_OUT"
[ "$CHECK_RC" -eq 0 ] || fail seals "the seal check exited ${CHECK_RC}"
# Every row of seals must have been checked.
[[ $CHECK_OUT =~ ^seals=([0-9]+)\  ]] || fail seals "the check printed no seals= line"
[ "${BASH_REMATCH[1]}" = "$SEAL_ROWS" ] || fail seals "the table has ${SEAL_ROWS} seals and the check saw ${BASH_REMATCH[1]}"

# --- 7. Growth figures (NFR-REL-03, SRS 7.5.8) ---
# Counts of bytes, by organisation id; no names. Held: evidence file bytes plus issued document
# bytes (the NFR-REL-09 total). Unattached: file evidence that no decision_evidence and no
# mitigation_evidence row links (FR-EVD-06). Each value is checked to be a number before it is logged.
STAGE=sizes
psql_restored() { timeout 300 docker exec "$NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -At -c "$1"; }
UNATTACHED='e.kind = '"'"'file'"'"' AND NOT EXISTS (SELECT 1 FROM decision_evidence d WHERE d."orgId" = e."orgId" AND d."evidenceId" = e.id) AND NOT EXISTS (SELECT 1 FROM mitigation_evidence m WHERE m."orgId" = e."orgId" AND m."evidenceId" = e.id)'
db_bytes=$(psql_restored 'SELECT pg_database_size(current_database())')
unattached_bytes=$(psql_restored "SELECT COALESCE(SUM(e.\"byteSize\"), 0) FROM evidence e WHERE ${UNATTACHED}")
[[ $db_bytes =~ ^[0-9]+$ && $unattached_bytes =~ ^[0-9]+$ ]] || fail sizes "db=${db_bytes} unattached=${unattached_bytes}"
log "db_bytes=${db_bytes} unattached_bytes=${unattached_bytes}"
per_org=$(psql_restored "SELECT o.id, COALESCE((SELECT SUM(e.\"byteSize\") FROM evidence e WHERE e.\"orgId\" = o.id AND e.kind = 'file'), 0) + COALESCE((SELECT SUM(i.\"byteSize\") FROM issued_documents i WHERE i.\"orgId\" = o.id), 0), COALESCE((SELECT SUM(e.\"byteSize\") FROM evidence e WHERE e.\"orgId\" = o.id AND ${UNATTACHED}), 0) FROM organizations o ORDER BY o.id")
while IFS='|' read -r org held unattached; do
  [ -n "$org" ] || continue
  [[ $org =~ ^[A-Za-z0-9_-]{1,64}$ && $held =~ ^[0-9]+$ && $unattached =~ ^[0-9]+$ ]] || fail sizes "an organisation row is not an id and two numbers"
  log "org=${org} held_bytes=${held} unattached_bytes=${unattached}"
done <<<"$per_org"

# Every comparison ran to the end. `finish` reports a pass only because of this.
COMPLETED=1
