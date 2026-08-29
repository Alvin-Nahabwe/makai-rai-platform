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
PREV=$(find "${BACKUP_DIR}" -maxdepth 1 -name 'makrai-*.sql.gz' ! -name "*${TIMESTAMP}*" \
       -printf '%s\n' 2>/dev/null | sort -n | tail -1 || echo 0)
if [ "${PREV:-0}" -ne 0 ] && [ "${BYTES}" -lt $((PREV / 2)) ]; then
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
MAILTO=you@example.com
0 3 * * * /usr/local/bin/makrai-backup.sh
```

**`MAILTO` is not optional decoration — see §1.6.** Set it to a real address you
read. Without it, a failed backup is a line in a file nobody opens.

> **Note:** The Hetzner VPS system clock should be set to EAT (`Africa/Kampala`)
> or UTC. If the server is UTC, use `0 0 * * *` instead to match 03:00 EAT.

### 1.6 Alerting — the gap none of the above closes

Every guard in §1.2 makes a failure **visible in a log**. None of them tells a
human. Detection today is §1.5: somebody remembering to run `tail`. A backup
system whose failure signal is *the absence of a line in a file nobody opens*
is not monitored, however good its error handling.

This is the open half of the 2026-08-17 audit's DEP-08 and it is deliberately
called out rather than quietly left. Three options, cheapest first:

1. **`MAILTO` in the crontab (§1.3).** Zero dependencies. cron mails any output
   to that address — and because §1.2 redirects stderr into the log rather than
   to the terminal, a *successful* run is silent and only failures that escape
   the log produce mail. Requires a working MTA on the box, which this VPS does
   not currently have; without one, cron's mail is discarded.
2. **A dead-man's switch** (healthchecks.io, Cronitor, or similar). The script
   pings a URL on success; the service alerts when a ping does **not** arrive.
   This is the only option that catches the failure modes where the script
   produces no output at all — a hung `docker exec`, a full disk, the box being
   down. That is why it is worth more than the other two combined.
3. **A staleness check.** A second, much simpler cron job that alerts when the
   newest file in `/srv/makrai/backups` is older than 48 hours. Catches
   everything a missing ping would, without a third-party service.

**Before the pilot admits real data, one of these must be in place.** Until then
the backups are best-effort and should be treated as such.

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
(`/home/alvin/Downloads/MAK_RAI/toolkit-platform`):

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
cd /home/alvin/Downloads/MAK_RAI/toolkit-platform

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
