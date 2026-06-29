# Backup & Restore Runbook

> RAI Toolkit Platform — `rai.air.ug`
> Last updated: 2026-06-29

---

## Overview

This runbook covers automated and manual backup procedures for the RAI Toolkit
Platform PostgreSQL database running in Docker on a Hetzner CX32 VPS.

| Item               | Value                                         |
| ------------------ | --------------------------------------------- |
| Database engine    | PostgreSQL 16 (Alpine)                        |
| Docker service     | `postgres` (in `docker-compose.prod.yml`)     |
| Backup location    | `/backups/` on the host                       |
| Retention policy   | 30 days                                       |
| Automated schedule | Daily at 03:00 EAT (00:00 UTC)               |
| Domain             | `rai.air.ug`                                  |

---

## 1. Automated Daily Backup (Cron)

### 1.1 Create the backup directory

```bash
sudo mkdir -p /backups
sudo chown $(whoami):$(whoami) /backups
```

### 1.2 Create the backup script

Save this as `/usr/local/bin/makrai-backup.sh`:

```bash
#!/usr/bin/env bash
# /usr/local/bin/makrai-backup.sh
# Automated PostgreSQL backup for RAI Toolkit Platform

set -euo pipefail

# --- Configuration ---
BACKUP_DIR="/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/makrai-${TIMESTAMP}.sql.gz"
LOG_FILE="/var/log/makrai-backup.log"

# Load env vars (POSTGRES_USER, POSTGRES_DB)
# Adjust path if your project lives elsewhere
source /home/alvin/Downloads/DSWB_RAI/toolkit-platform/.env

# --- Run backup ---
echo "[$(date)] Starting backup..." >> "${LOG_FILE}"

docker exec postgres pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > "${BACKUP_FILE}"

if [ $? -eq 0 ]; then
  echo "[$(date)] Backup created: ${BACKUP_FILE} ($(du -h "${BACKUP_FILE}" | cut -f1))" >> "${LOG_FILE}"
else
  echo "[$(date)] ERROR: Backup failed!" >> "${LOG_FILE}"
  exit 1
fi

# --- Verify integrity ---
gunzip -t "${BACKUP_FILE}"
if [ $? -eq 0 ]; then
  echo "[$(date)] Integrity check passed." >> "${LOG_FILE}"
else
  echo "[$(date)] ERROR: Integrity check FAILED for ${BACKUP_FILE}" >> "${LOG_FILE}"
  exit 1
fi

# --- Prune old backups ---
find "${BACKUP_DIR}" -name "makrai-*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Pruned backups older than ${RETENTION_DAYS} days." >> "${LOG_FILE}"

echo "[$(date)] Backup complete." >> "${LOG_FILE}"
```

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
0 3 * * * /usr/local/bin/makrai-backup.sh
```

> **Note:** The Hetzner VPS system clock should be set to EAT (`Africa/Kampala`)
> or UTC. If the server is UTC, use `0 0 * * *` instead to match 03:00 EAT.

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
(`/home/alvin/Downloads/DSWB_RAI/toolkit-platform`):

```bash
# Load your environment variables
source .env

# Create a timestamped backup
docker exec postgres pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > /backups/makrai-$(date +%Y%m%d-%H%M%S).sql.gz
```

Verify the backup was created:

```bash
ls -lh /backups/makrai-*.sql.gz | tail -5
```

---

## 3. Backup Integrity Verification

Always verify a backup before relying on it:

```bash
# Test gzip integrity (returns silently if OK)
gunzip -t /backups/makrai-20260629-030001.sql.gz

# Optionally, peek at the contents
zcat /backups/makrai-20260629-030001.sql.gz | head -50
```

If `gunzip -t` reports errors, the file is corrupt — do not use it for restore.

---

## 4. Restore Procedure

> **⚠️ WARNING:** Restoring a backup will **destroy all current data** in the
> database. Make sure you have a fresh backup of the current state before
> restoring an older one.

### 4.1 Stop the application

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform

# Stop the Next.js and Nginx containers (keep Postgres running)
docker compose -f docker/docker-compose.prod.yml stop nextjs nginx
```

### 4.2 Drop and recreate the database

```bash
source .env

# Drop the existing database
docker exec postgres dropdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"

# Recreate it
docker exec postgres createdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

### 4.3 Restore from the backup file

```bash
# Replace the filename with the backup you want to restore
gunzip -c /backups/makrai-20260629-030001.sql.gz \
  | docker exec -i postgres psql -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

### 4.4 Run database migrations

This ensures the schema is up to date in case the backup predates recent
migrations:

```bash
docker exec nextjs npx prisma migrate deploy
```

### 4.5 Restart the application

```bash
docker compose -f docker/docker-compose.prod.yml up -d
```

### 4.6 Verify the restore

```bash
# Check the app is responding
curl -s -o /dev/null -w "%{http_code}" https://rai.air.ug

# Check database row counts (quick sanity check)
docker exec postgres psql -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
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
  /backups/makrai-*.sql.gz \
  user@backup-server.example.com:/backups/rai/
```

### Option B: AWS S3 (or S3-compatible storage)

```bash
# Install the AWS CLI
sudo apt install awscli -y

# Configure credentials
aws configure

# Sync backups to S3
aws s3 sync /backups/ s3://your-bucket-name/rai-backups/ \
  --exclude "*" --include "makrai-*.sql.gz"
```

Add this to cron to run after the backup script:

```cron
15 3 * * * aws s3 sync /backups/ s3://your-bucket-name/rai-backups/ --exclude "*" --include "makrai-*.sql.gz"
```

---

## 6. Quick Reference

| Task                  | Command                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Manual backup         | `docker exec postgres pg_dump -U $POSTGRES_USER $POSTGRES_DB \| gzip > /backups/makrai-$(date +%Y%m%d-%H%M%S).sql.gz` |
| Verify backup         | `gunzip -t /backups/makrai-YYYYMMDD-HHMMSS.sql.gz`                                                                    |
| List backups          | `ls -lhtr /backups/makrai-*.sql.gz`                                                                                    |
| Restore               | `gunzip -c /backups/FILE.sql.gz \| docker exec -i postgres psql -U $POSTGRES_USER $POSTGRES_DB`                       |
| Check cron            | `crontab -l`                                                                                                           |
| View backup log       | `tail -20 /var/log/makrai-backup.log`                                                                                  |
| Prune old backups     | `find /backups -name "makrai-*.sql.gz" -mtime +30 -delete`                                                             |
