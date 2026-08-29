# Backup & Restore Runbook

> **NOT YET EXECUTED.** The domain is `makrai.org` (confirmed 2026-08-18), but
> nothing is configured: no server, no DNS, no TLS. This runbook has never been
> run end to end, and the 2026-08-17 audit found the procedure as written cannot
> produce a working deployment — it starts after the server already exists and
> omits roughly nine provisioning steps. Expect to correct it while performing
> the first real deployment, not before.

> RAI Toolkit Platform — `makrai.org`
> Last updated: 2026-06-29

---

## Overview

This runbook covers automated and manual backup procedures for the RAI Toolkit
Platform PostgreSQL database running in Docker on a Hetzner CX32 VPS.

| Item               | Value                                         |
| ------------------ | --------------------------------------------- |
| Database engine    | PostgreSQL 16 (Alpine)                        |
| Docker service     | `postgres` (in `docker-compose.prod.yml`)     |
| Backup location    | `/srv/makrai/backups/` on the host                       |
| Retention policy   | 30 days                                       |
| Automated schedule | Daily at 03:00 EAT (00:00 UTC)               |
| Domain             | `makrai.org`                                  |

---

## 1. Automated Daily Backup (Cron)

### 1.1 Create the backup directory

```bash
sudo mkdir -p /srv/makrai/backups
sudo chown $(whoami):$(whoami) /srv/makrai/backups
sudo touch /srv/makrai/backup.log
sudo chown $(whoami):$(whoami) /srv/makrai/backup.log
```

The log deliberately does **not** live in `/var/log`. That directory is
`root:syslog`, §1.3 installs a *user* crontab, and nothing here ever chowned a
file there — so every run would have died on its first log write, having
recorded nothing. The whole point of the script's error handling is defeated if
it cannot write its own log.

### 1.2 Create the backup script

Save this as `/usr/local/bin/makrai-backup.sh`:

```bash
#!/usr/bin/env bash
# /usr/local/bin/makrai-backup.sh
# Automated PostgreSQL backup for the RAI Toolkit Platform.
#
# Rewritten 2026-08-29 after an adversarial review executed five distinct ways
# the previous version failed silently. Each guard below names the failure it
# closes; do not remove one without reproducing that failure first.

set -Eeuo pipefail
# -E matters on its own. Without `errtrace` the trap is NOT inherited by shell
# functions, so a failing `log()` -- the very thing meant to record failures --
# killed the script from inside the function with the trap never entered.

BACKUP_DIR="/srv/makrai/backups"
RETENTION_DAYS=30
APP_DIR="/srv/makrai/app"
POSTGRES_CONTAINER="docker-postgres-1"
# Not /var/log: that is root:syslog, and 1.3 installs a USER crontab. Every run
# would have died on its first write having logged nothing. Keep the log where
# the cron user owns the directory.
LOG_FILE="/srv/makrai/backup.log"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/makrai-${TIMESTAMP}.sql.gz"
VERIFIED=0

# Second-resolution names collide, and `flock` below does not help: it stops
# CONCURRENT runs, not a second run started within the same second. Observed
# while testing this very script -- the second run silently overwrote the first
# good backup and then, on failing, deleted it. Refuse rather than clobber.
[ -e "${BACKUP_FILE}" ] && { echo "[$(date -Is)] ERROR: ${BACKUP_FILE} already exists; refusing to overwrite." >&2; exit 1; }

# Send everything -- including stderr -- to the log. Without this, "No such
# container" and "permission denied on the docker socket" went to cron's
# stderr, which on a box with no MTA is discarded, leaving an error line with
# no cause attached.
exec >>"${LOG_FILE}" 2>&1 || { echo "FATAL: cannot write ${LOG_FILE}" >&2; exit 1; }
log() { echo "[$(date -Is)] $*"; }

# Alerting. The platform already has a verified sending domain and a send-only
# Resend key, so a failure can reach a human without adding a dependency.
#
# Never let alerting failure mask the failure being alerted about: this is the
# one place in this script where a non-zero exit is deliberately swallowed. If
# the alert cannot be sent, that fact is logged and the original error still
# propagates.
alert() { # $1 = subject, $2 = body
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ALERT_TO:-}" ]; then
    log "WARNING: RESEND_API_KEY or ALERT_TO unset -- no alert sent. This failure is in the log only."
    return 0
  fi
  local payload
  payload=$(FROM="${ALERT_FROM}" TO="${ALERT_TO}" SUBJ="$1" BODY="$2" python3 -c '
import json, os
print(json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                  "subject": os.environ["SUBJ"], "text": os.environ["BODY"]}))') || {
    log "WARNING: could not build the alert payload"; return 0; }
  # `curl -sS` exits 0 on an HTTP 4xx/5xx. Checking only its exit status would
  # log "alert sent" for a rejected key, an unverified sending domain or a
  # malformed address -- an alerting mechanism that reports success while
  # delivering nothing, which is the exact failure it exists to prevent.
  local resp code
  resp=$(curl -sS --max-time 20 -w '\n%{http_code}' -X POST https://api.resend.com/emails \
         -H "Authorization: Bearer ${RESEND_API_KEY}" \
         -H "Content-Type: application/json" -d "${payload}" 2>&1) || true
  code=$(printf '%s' "${resp}" | tail -n1)
  case "${code}" in
    2*) log "alert accepted by Resend (HTTP ${code}) for ${ALERT_TO}" ;;
    *)  log "WARNING: alert NOT delivered (HTTP ${code:-none}): $(printf '%s' "${resp}" | head -c 300)" ;;
  esac
  return 0
}

# cron and `sudo -u` both leave the working directory set to something the
# running user may not be able to read -- /root, in the case that found this.
# GNU find then fails with "Failed to restore initial working directory:
# Permission denied" AFTER producing correct output, so the size check and the
# prune below both broke while the dump itself was fine. Every path here is
# absolute, so the working directory has no other job.
cd /

# EXIT, not ERR. `.` (source) is a POSIX SPECIAL BUILTIN: its failure terminates
# a non-interactive shell immediately and bypasses an ERR trap entirely. A
# missing or unreadable .env -- the likeliest failure on a fresh box -- produced
# no log line at all under an ERR trap. An EXIT trap catches it, and catches
# `set -u` violations too.
cleanup() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    log "ERROR: backup FAILED (exit ${rc})."
    if [ "$VERIFIED" -eq 1 ]; then
      # The previous version deleted unconditionally, so a failure in the prune
      # -- after a good dump had been written and verified -- destroyed it and
      # then logged that no backup was produced. Self-inflicted data loss.
      log "NOTE: ${BACKUP_FILE} is complete and verified; KEEPING it."
    else
      rm -f "${BACKUP_FILE}"
    fi
    alert "[makrai] BACKUP FAILED on $(hostname)" \
"The nightly database backup failed.

host:   $(hostname)
exit:   ${rc}
when:   $(date -Is)

Last lines of ${LOG_FILE}:
$(tail -n 15 "${LOG_FILE}" 2>/dev/null)

Nothing is broken in the running application by this -- it means there is no
backup from this run. Check the log above, then run
/usr/local/bin/makrai-backup.sh by hand once the cause is fixed."
  fi
  exit "$rc"
}
trap cleanup EXIT

# Second-resolution timestamps collide, and a hand-run during an incident is
# exactly when a second copy gets started. Two concurrent runs silently produced
# one file.
exec 9>/var/lock/makrai-backup.lock
flock -n 9 || { log "ERROR: another backup is already running."; exit 1; }

log "Starting backup..."

# Read only the two values needed, in a subshell. Sourcing .env directly at this
# point let it silently redefine BACKUP_DIR, RETENTION_DAYS and LOG_FILE -- a
# RETENTION_DAYS=0 in .env made the prune delete everything while the log
# reported normal operation.
[ -r "${APP_DIR}/.env" ] || { log "ERROR: ${APP_DIR}/.env missing or unreadable."; exit 1; }
POSTGRES_USER=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_USER:-}")
POSTGRES_DB=$(set -a;   . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${POSTGRES_DB:-}")
RESEND_API_KEY=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${RESEND_API_KEY:-}")
ALERT_TO=$(set -a;      . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${ADMIN_EMAIL:-}")
ALERT_FROM=$(set -a;    . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${EMAIL_FROM_ADDRESS:-}")
[ -n "${POSTGRES_USER}" ] && [ -n "${POSTGRES_DB}" ] \
  || { log "ERROR: POSTGRES_USER/POSTGRES_DB are not set in ${APP_DIR}/.env."; exit 1; }

# `timeout` because a container that accepts the exec and never streams leaves
# cron holding an open process and a zero-byte .sql.gz that looks like a backup.
# `pipefail` because without it the pipeline reports gzip's status, so a dead
# pg_dump still produced a well-formed gzip of nothing.
timeout 3600 docker exec "${POSTGRES_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" | gzip > "${BACKUP_FILE}"

gunzip -t "${BACKUP_FILE}"

# THE CHECK THAT MATTERS MOST. `gunzip -t` validates the gzip CONTAINER, not the
# SQL inside it. A dump truncated mid-stream while docker exec still exits 0
# closes as a perfectly valid gzip. Under the previous script that passed every
# check and logged "Backup complete." -- and because the prune runs on success,
# 31 consecutive truncated runs deleted all 35 good backups with a clean log.
# This marker is pg_dump's own statement that it finished.
gunzip -c "${BACKUP_FILE}" | tail -5 | grep -q 'PostgreSQL database dump complete' \
  || { log "ERROR: dump has no completion marker -- TRUNCATED. Discarding."; exit 1; }

# Relative to the last good backup, not an absolute floor. A schema-only dump of
# this database with ZERO rows gzips to ~1.4 KB, which cleared the old 1000-byte
# constant and was logged as success -- so a restore against the wrong database
# looked healthy.
BYTES=$(stat -c %s "${BACKUP_FILE}")
# The default is applied AFTER the pipeline, not with `|| echo 0`. Under
# `pipefail` a failing stage makes the whole pipeline fail even when earlier
# stages printed correct output, so `|| echo 0` APPENDED a zero instead of
# substituting one -- yielding "8075\n0" and `[: integer expression expected`.
PREV=$(find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz' ! -name "*${TIMESTAMP}*" \
       -printf '%s\n' 2>/dev/null | sort -n | tail -1)
PREV=${PREV:-0}
if [ "${PREV}" -ne 0 ] && [ "${BYTES}" -lt $((PREV / 2)) ]; then
  log "ERROR: ${BYTES} bytes is under half the previous backup (${PREV}). Discarding."
  exit 1
fi

VERIFIED=1
log "Backup verified: ${BACKUP_FILE} (${BYTES} bytes)"

# Prune only after a verified success, so a run of failures can never eat the
# archive. Verified: three consecutive failures left all seeded backups intact.
find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz' -mtime "+${RETENTION_DAYS}" -delete
log "Pruned backups older than ${RETENTION_DAYS} days."
log "Backup complete."
```

**On the trap, and why the previous shape could not work.** `set -e` and a
trailing `if [ $? -eq 0 ]` are mutually exclusive: the first makes the second
unreachable on failure, and on success `$?` is always `0`, so the `else` branch
was dead code in both directions. Every backup either worked, or stopped
writing to the log with no explanation. If you edit this script, keep the trap
and do not reintroduce a post-hoc `$?` check.

Make it executable:

```bash
sudo chmod +x /usr/local/bin/makrai-backup.sh
```

### 1.3 Add the crontab entry

Open crontab for editing:

```bash
crontab -e
```

Add this line (runs daily at 03:00 EAT / 00:00 UTC):

```cron
MAILTO=""
0 0 * * * /usr/local/bin/makrai-backup.sh
0 6 * * * /usr/local/bin/makrai-backup-check.sh
```

**These are UTC**, because the server is (`timedatectl` reports `Etc/UTC`). So
the backup runs 03:00 EAT and the check 09:00 EAT, six hours later — far enough
apart that a slow backup is never mistaken for a missing one. If you ever move
the box to local time, both numbers change; the six-hour gap is the thing to
preserve.

`MAILTO` is deliberately **empty**. cron would otherwise try to mail every line
of output to a local mailbox on a machine with no MTA, which goes nowhere and
tells you nothing. Alerting does not depend on it — §1.2 and §1.6 send through
Resend, which was verified end to end on 2026-08-29 (HTTP 200 from the real
script, not a hand-written request).

> **Note:** The Hetzner VPS system clock should be set to EAT (`Africa/Kampala`)
> or UTC. If the server is UTC, use `0 0 * * *` instead to match 03:00 EAT.

### 1.6 Alerting

Every guard in §1.2 makes a failure visible **in a log**. On its own that is not
monitoring: the signal for "the backup failed" would be the absence of a line in
a file nobody opens. Two mechanisms close that, and they cover different
failures — you need both.

**A. The script alerts when it fails.** Built into §1.2's `cleanup` trap. It
posts to the Resend API using the platform's own verified sending domain and
send-only key, already in `.env` — no new dependency, no new account. Alerting
failure is the one non-zero exit this script deliberately swallows: if the email
cannot go out, that is logged and the original error still propagates, because
an alerting problem must never mask the problem being alerted about.

**B. A separate check notices when the script did not run at all.** This is the
failure A structurally cannot report — a hung `docker exec`, a broken crontab, a
full disk, a script deleted or made non-executable. In all of those the backup
script produces nothing, including no alert. Save as
`/usr/local/bin/makrai-backup-check.sh`:

```bash
#!/usr/bin/env bash
# Dead-man's switch for makrai-backup.sh.
#
# The backup script can only alert about failures it survives long enough to
# notice. This one asks a question that does not depend on the script running
# at all: is there a recent backup on disk? Silent when healthy, so it is safe
# to run often.
set -Eeuo pipefail
cd /

# Overridable so the ALERT path can be exercised without faking a backup
# failure: point BACKUP_DIR at an empty directory and this script sends a real
# alert through the real code. An alerting mechanism nobody has ever seen fire
# is indistinguishable from one that does not work.
BACKUP_DIR="${BACKUP_DIR:-/srv/makrai/backups}"
APP_DIR="${APP_DIR:-/srv/makrai/app}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"   # one missed nightly run, plus slack
MIN_BYTES="${MIN_BYTES:-1000}"

RESEND_API_KEY=$(set -a; . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${RESEND_API_KEY:-}")
ALERT_TO=$(set -a;       . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${ADMIN_EMAIL:-}")
ALERT_FROM=$(set -a;     . "${APP_DIR}/.env" >/dev/null 2>&1; echo "${EMAIL_FROM_ADDRESS:-}")

alert() {
  [ -n "${RESEND_API_KEY}" ] && [ -n "${ALERT_TO}" ] || {
    echo "no RESEND_API_KEY/ADMIN_EMAIL -- cannot alert: $1" >&2; return 0; }
  payload=$(FROM="${ALERT_FROM}" TO="${ALERT_TO}" SUBJ="[makrai] $1" BODY="$2" python3 -c '
import json, os
print(json.dumps({"from": os.environ["FROM"], "to": [os.environ["TO"]],
                  "subject": os.environ["SUBJ"], "text": os.environ["BODY"]}))')
  # Status-checked, not exit-checked: curl exits 0 on HTTP 4xx, so an exit-only
  # test would call a rejected send a success.
  resp=$(curl -sS --max-time 20 -w '\n%{http_code}' -X POST https://api.resend.com/emails \
         -H "Authorization: Bearer ${RESEND_API_KEY}" \
         -H "Content-Type: application/json" -d "${payload}" 2>&1) || true
  code=$(printf '%s' "${resp}" | tail -n1)
  case "${code}" in
    2*) echo "alert accepted by Resend (HTTP ${code})" >&2 ;;
    *)  echo "ALERT NOT DELIVERED (HTTP ${code:-none}): $(printf '%s' "${resp}" | head -c 300)" >&2 ;;
  esac
}

NEWEST=$(find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null \
         | sort -n | tail -1 | cut -d' ' -f2-)
NEWEST=${NEWEST:-}

if [ -z "${NEWEST}" ]; then
  alert "NO BACKUPS AT ALL on $(hostname)" \
"There is no backup file in ${BACKUP_DIR} on $(hostname).

Either the backup has never run here, or every file has been removed. This is
not a warning -- there is currently nothing to restore from."
  exit 1
fi

AGE_H=$(( ( $(date +%s) - $(stat -c %Y "${NEWEST}") ) / 3600 ))
BYTES=$(stat -c %s "${NEWEST}")

if [ "${AGE_H}" -gt "${MAX_AGE_HOURS}" ] || [ "${BYTES}" -lt "${MIN_BYTES}" ]; then
  alert "BACKUP IS STALE on $(hostname)" \
"The newest backup on $(hostname) is not healthy.

file:  ${NEWEST}
age:   ${AGE_H}h (limit ${MAX_AGE_HOURS}h)
size:  ${BYTES} bytes (floor ${MIN_BYTES})

The backup job has not produced a usable file recently, and did not report a
failure itself -- so it probably did not run. Check the crontab, then
/srv/makrai/backup.log."
  exit 1
fi

exit 0   # healthy: say nothing
```

```bash
sudo chmod +x /usr/local/bin/makrai-backup-check.sh
```

Add it to the same crontab, several hours after the backup so a slow run is not
mistaken for a missing one:

Already included in the crontab in §1.3 — shown here so this section reads on
its own:

```cron
0 6 * * * /usr/local/bin/makrai-backup-check.sh   # 09:00 EAT
```

**What neither mechanism catches: the machine being down.** Both run *on* the
server, so if it is off or unreachable, both are silent — and silence is what
"healthy" looks like. Closing that needs something outside the box: an external
uptime monitor, or a dead-man's-switch service the script pings on success so
the *absence* of a ping raises the alarm. Worth adding before the pilot; not
worth pretending the two above cover it.

### 1.4 Verify the cron is registered

```bash
crontab -l | grep makrai
```

### 1.5 Check backup logs

```bash
tail -20 /var/log/makrai-backup.log
```

---

## 2. Manual Backup

Run this from the project directory
(`/srv/makrai/app`):

```bash
# Load your environment variables
source .env

# Create a timestamped backup
docker exec docker-postgres-1 pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > /srv/makrai/backups/makrai-$(date +%Y%m%d-%H%M%S).sql.gz
```

Verify the backup was created:

```bash
ls -lh /srv/makrai/backups/makrai-*.sql.gz | tail -5
```

---

## 3. Backup Integrity Verification

Always verify a backup before relying on it:

```bash
# Test gzip integrity (returns silently if OK)
gunzip -t /srv/makrai/backups/makrai-20260629-030001.sql.gz

# Optionally, peek at the contents
zcat /srv/makrai/backups/makrai-20260629-030001.sql.gz | head -50
```

If `gunzip -t` reports errors, the file is corrupt — do not use it for restore.

---

## 4. Restore Procedure

> **⚠️ WARNING:** Restoring a backup will **destroy all current data** in the
> database. Make sure you have a fresh backup of the current state before
> restoring an older one.

### 4.1 Stop the application

```bash
cd /srv/makrai/app

# Stop the Next.js and Nginx containers (keep Postgres running)
docker compose -f docker/docker-compose.prod.yml stop nextjs nginx
```

### 4.2 Drop and recreate the database

```bash
source .env

# Drop the existing database
docker exec docker-postgres-1 dropdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"

# Recreate it
docker exec docker-postgres-1 createdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

### 4.2a On a FRESH cluster only — create the `makrai_app` role first

**Skip this when restoring onto the existing server; it is mandatory on a new
one.** This is the disaster-recovery case: new VPS, new Postgres, backup in hand.

`pg_dump` dumps a DATABASE, and `makrai_app` is a CLUSTER-level object. The dump
contains **11 `GRANT ... TO makrai_app` statements and zero `CREATE ROLE`**, so
on a cluster where that role does not exist the restore hits
`ERROR: role "makrai_app" does not exist`.

Demonstrated 2026-08-29 against a throwaway `postgres:16-alpine` cluster, both
directions:

| | Result |
|---|---|
| Fresh cluster, no role | `exit 3`, `ERROR: role "makrai_app" does not exist` |
| Role created first | `exit 0`, 0 errors, 13 tables, 9 RLS policies |

**The dangerous part is what a hurried operator sees.** Thirteen tables *were*
created before it stopped, so the database looks restored. Every `GRANT` after
the failure was skipped, so the application — which connects as `makrai_app` —
can read nothing. And this only surfaces at all because of the
`-v ON_ERROR_STOP=1` in 4.3: without it psql continues past the error and exits
**0**, producing a restore that reports success and has no grants.

```bash
docker exec -i docker-postgres-1 psql -U "${POSTGRES_USER}" -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='makrai_app') THEN
     CREATE ROLE makrai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
   END IF; END \$\$;"
```

Same attributes as the migration that normally creates it
(`prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:12`) —
`NOBYPASSRLS` above all, since a role that can bypass row-level security would
silently defeat every tenant boundary in the restored data.

No password here: **step 4.5a sets it**, after the restore, from `.env`.

---

### 4.3 Restore from the backup file

```bash
# Replace the filename with the backup you want to restore
gunzip -c /srv/makrai/backups/makrai-20260629-030001.sql.gz \
  | docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

### 4.4 Run database migrations

This ensures the schema is up to date in case the backup predates recent
migrations:

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator
```

### 4.5a On a fresh cluster — give the role its password

The role created in 4.2a can log in and has no password, so the application
still cannot authenticate. Same step as `deployment.md` §6.4, deriving the value
from `.env` so it cannot drift from what the app presents:

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a
APP_DB_PASSWORD="$(printf '%s' "$APP_DATABASE_URL" | sed -n 's#.*://makrai_app:\([^@]*\)@.*#\1#p')"
NODE_ENV=production APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  PSQL_CMD="docker exec -i docker-postgres-1 psql -U $POSTGRES_USER" \
  scripts/provision-app-db-role.sh "$POSTGRES_DB"
unset APP_DB_PASSWORD
```

---

### 4.5 Restart the application

```bash
docker compose -f docker/docker-compose.prod.yml up -d
```

### 4.6 Verify the restore

```bash
# Check the app is responding
curl -s -o /dev/null -w "%{http_code}" https://makrai.org

# Check database row counts (quick sanity check)
docker exec docker-postgres-1 psql -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  -c "SELECT schemaname, relname, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC;"
```

---

## 5. Off-Site Backup (Recommended)

Keeping backups only on the same server is risky. If the VPS disk fails, you
lose both the data and the backups.

### Option A: Rsync to a second server

```bash
# One-time setup: generate an SSH key and copy to backup server
ssh-keygen -t ed25519 -f ~/.ssh/backup_key -N ""
ssh-copy-id -i ~/.ssh/backup_key.pub user@backup-server.example.com

# Add to the backup script or a separate cron job:
rsync -avz -e "ssh -i ~/.ssh/backup_key" \
  /srv/makrai/backups/makrai-*.sql.gz \
  user@backup-server.example.com:/srv/makrai/backups/rai/
```

### Option B: AWS S3 (or S3-compatible storage)

```bash
# Install the AWS CLI
sudo apt install awscli -y

# Configure credentials
aws configure

# Sync backups to S3
aws s3 sync /srv/makrai/backups/ s3://your-bucket-name/rai-backups/ \
  --exclude "*" --include "makrai-*.sql.gz"
```

Add this to cron to run after the backup script:

```cron
15 3 * * * aws s3 sync /srv/makrai/backups/ s3://your-bucket-name/rai-backups/ --exclude "*" --include "makrai-*.sql.gz"
```

---

## 6. Quick Reference

| Task                  | Command                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Manual backup         | `docker exec docker-postgres-1 pg_dump -U $POSTGRES_USER $POSTGRES_DB \| gzip > /srv/makrai/backups/makrai-$(date +%Y%m%d-%H%M%S).sql.gz` |
| Verify backup         | `gunzip -t /srv/makrai/backups/makrai-YYYYMMDD-HHMMSS.sql.gz`                                                                    |
| List backups          | `ls -lhtr /srv/makrai/backups/makrai-*.sql.gz`                                                                                    |
| Restore               | `gunzip -c /srv/makrai/backups/FILE.sql.gz \| docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER $POSTGRES_DB`                       |
| Check cron            | `crontab -l`                                                                                                           |
| View backup log       | `tail -20 /var/log/makrai-backup.log`                                                                                  |
| Prune old backups     | `find /srv/makrai/backups -name "makrai-*.sql.gz" -mtime +30 -delete`                                                             |
