# Troubleshooting Runbook

> RAI Toolkit Platform — `rai.air.ug`
> Last updated: 2026-06-29

---

## Overview

This runbook covers common production issues and their fixes for the RAI
Toolkit Platform running on a Hetzner CX32 VPS with Docker.

**Before you start:** Run the diagnostic commands in [Section 7](#7-diagnostic-commands-cheat-sheet)
to gather information about the current state of the system.

---

## 1. SSL Certificate Renewal Failure

### Symptoms

- Browser shows "Your connection is not private" / `ERR_CERT_DATE_INVALID`
- `curl https://rai.air.ug` returns an SSL error
- UptimeRobot alerts about HTTPS failure

### Diagnosis

```bash
# Check certificate expiry date
echo | openssl s_client -connect rai.air.ug:443 2>/dev/null \
  | openssl x509 -noout -dates

# Check Certbot renewal status
sudo certbot certificates
```

### Fixes

**Fix 1: Port 80 is blocked by Nginx**

Certbot needs port 80 free for the standalone challenge. Stop Nginx first:

```bash
cd /home/alvin/Downloads/DSWB_RAI/toolkit-platform

docker compose -f docker/docker-compose.prod.yml stop nginx
sudo certbot renew
docker compose -f docker/docker-compose.prod.yml start nginx
```

**Fix 2: Firewall blocking port 80**

```bash
sudo ufw allow 80/tcp
sudo ufw reload
```

**Fix 3: DNS not pointing to this server**

```bash
dig rai.air.ug +short
# Should return your server's IP address
```

**Fix 4: Renew manually**

```bash
docker compose -f docker/docker-compose.prod.yml stop nginx
sudo certbot certonly --standalone -d rai.air.ug --force-renewal
docker compose -f docker/docker-compose.prod.yml start nginx
```

### Prevention

Make sure the auto-renewal cron is set up (see
[deployment.md](./deployment.md#53-set-up-auto-renewal)).

---

## 2. Database Connection Refused

### Symptoms

- App shows "500 Internal Server Error"
- Logs contain: `Connection refused`, `ECONNREFUSED`, or
  `could not connect to server`

### Diagnosis

```bash
# Check if the Postgres container is running
docker ps --filter name=postgres

# Check Postgres logs
docker logs postgres --tail=50

# Test database connectivity from inside the container
docker exec postgres pg_isready -U makrai
```

### Fixes

**Fix 1: Postgres container is stopped**

```bash
docker compose -f docker/docker-compose.prod.yml up -d postgres
```

**Fix 2: Postgres is crash-looping**

Check logs for the cause:

```bash
docker logs postgres --tail=100
```

Common causes:
- Disk full → See [Section 5](#5-disk-full)
- Corrupted data → Restore from backup (see [backup-restore.md](./backup-restore.md))
- Wrong credentials → Check `.env` matches the Postgres volume's saved credentials

**Fix 3: `DATABASE_URL` mismatch**

The `DATABASE_URL` in `.env` must match the Postgres container's credentials.
The hostname must be `postgres` (the Docker service name), not `localhost`:

```env
DATABASE_URL="postgresql://makrai:YOUR_PASSWORD@postgres:5432/makrai"
```

After fixing, restart the app:

```bash
docker compose -f docker/docker-compose.prod.yml restart nextjs
```

**Fix 4: Postgres volume corruption (last resort)**

```bash
# ⚠️ THIS DESTROYS ALL DATA — restore from backup afterward
docker compose -f docker/docker-compose.prod.yml down
docker volume rm toolkit-platform_postgres_data
docker compose -f docker/docker-compose.prod.yml up -d
# Then restore from backup — see backup-restore.md
```

---

## 3. OOM (Out of Memory) on Small VPS

### Symptoms

- Containers killed unexpectedly
- `dmesg` shows `oom-killer` entries
- `docker stats` shows memory near 100%
- Next.js build fails during `docker compose build`

### Diagnosis

```bash
# Check current memory usage
free -m

# Check if OOM killer has acted recently
dmesg | grep -i "oom\|killed" | tail -10

# Check per-container memory usage
docker stats --no-stream
```

### Fixes

**Fix 1: Add swap space (recommended for CX32)**

```bash
# Create a 4 GB swap file
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make it permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verify
free -m
```

**Fix 2: Limit container memory**

Add memory limits to `docker-compose.prod.yml`:

```yaml
services:
  nextjs:
    deploy:
      resources:
        limits:
          memory: 2G
  postgres:
    deploy:
      resources:
        limits:
          memory: 1G
```

**Fix 3: Build on a different machine**

If the VPS runs out of memory during `docker compose build`, build the image
on a machine with more RAM and transfer it:

```bash
# On your local machine
docker build -t rai-platform -f docker/Dockerfile .
docker save rai-platform | gzip > rai-platform.tar.gz
scp rai-platform.tar.gz alvin@YOUR_SERVER_IP:/tmp/

# On the server
docker load < /tmp/rai-platform.tar.gz
```

---

## 4. Next.js Build Failure

### Symptoms

- `docker compose build` fails
- Build output shows TypeScript errors, missing modules, or OOM

### Diagnosis

```bash
# Try building with verbose output
docker compose -f docker/docker-compose.prod.yml build --no-cache nextjs 2>&1 | tail -80
```

### Fixes

**Fix 1: TypeScript / lint errors**

Fix the errors in your code, then rebuild:

```bash
# Run locally first to see errors clearly
npm run build
```

**Fix 2: Missing dependencies**

```bash
# Make sure package-lock.json is committed
npm install
git add package-lock.json
git commit -m "fix: update package-lock.json"
```

**Fix 3: Out of memory during build**

See [Section 3](#3-oom-out-of-memory-on-small-vps), Fix 1 (add swap) or Fix 3
(build on another machine).

**Fix 4: Prisma client not generated**

The Dockerfile runs `npx prisma generate` during build. If it fails:

```bash
# Check that the prisma schema is valid
npx prisma validate
```

---

## 5. Disk Full

### Symptoms

- Database writes fail
- Backup script fails
- `df -h` shows 100% usage on `/`

### Diagnosis

```bash
# Check disk usage
df -h

# Find large files
sudo du -sh /* | sort -rh | head -10

# Check Docker disk usage
docker system df
```

### Fixes

**Fix 1: Clean up Docker**

```bash
# Remove unused images, containers, volumes, and build cache
docker system prune -a --volumes

# ⚠️ The --volumes flag removes unused volumes. Make sure your
# postgres_data volume is still in use before running this.
```

**Fix 2: Clean old backups**

```bash
# Remove backups older than 30 days
find /backups -name "makrai-*.sql.gz" -mtime +30 -delete
```

**Fix 3: Clean system logs**

```bash
# Truncate large log files
sudo journalctl --vacuum-size=100M
```

**Fix 4: Clean old Docker build cache**

```bash
docker builder prune --all
```

---

## 6. Prisma Migration Conflicts

### Symptoms

- `prisma migrate deploy` fails with "migration already applied" or
  "migration not found"
- Schema drift errors

### Diagnosis

```bash
# Check migration status
docker exec nextjs npx prisma migrate status
```

### Fixes

**Fix 1: Resolve migration conflicts**

If a migration was partially applied:

```bash
# Mark a failed migration as rolled back
docker exec nextjs npx prisma migrate resolve --rolled-back MIGRATION_NAME
```

If a migration was manually applied outside Prisma:

```bash
# Mark it as already applied
docker exec nextjs npx prisma migrate resolve --applied MIGRATION_NAME
```

**Fix 2: Reset the database (development/staging only)**

```bash
# ⚠️ THIS DESTROYS ALL DATA
docker exec nextjs npx prisma migrate reset --force
```

**Fix 3: Schema drift**

If the database schema doesn't match the Prisma schema:

```bash
# Pull the actual DB schema into Prisma (creates a diff)
docker exec nextjs npx prisma db pull

# Then create a new migration to reconcile
docker exec nextjs npx prisma migrate dev --name reconcile
```

---

## 7. Diagnostic Commands Cheat Sheet

Run these commands to gather system state before troubleshooting:

```bash
# --- Container Status ---
docker compose -f docker/docker-compose.prod.yml ps
docker stats --no-stream

# --- Application Logs ---
docker logs nextjs --tail=100
docker logs postgres --tail=100
docker logs nginx --tail=100

# Combined logs (all services)
docker compose -f docker/docker-compose.prod.yml logs --tail=100

# --- System Resources ---
df -h            # Disk space
free -m          # Memory
uptime           # Load average
nproc            # CPU count

# --- Network ---
curl -s -o /dev/null -w "%{http_code}" https://rai.air.ug
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000   # Direct to Next.js (from inside Docker network)

# --- SSL ---
echo | openssl s_client -connect rai.air.ug:443 2>/dev/null | openssl x509 -noout -dates

# --- Database ---
docker exec postgres pg_isready -U makrai
docker exec postgres psql -U makrai -d makrai -c "SELECT count(*) FROM pg_stat_activity;"

# --- Docker ---
docker system df          # Docker disk usage
docker system events      # Live event stream (Ctrl+C to stop)
```

---

## 8. Health Check Endpoints

| Endpoint                | Expected   | What it checks           |
| ----------------------- | ---------- | ------------------------ |
| `https://rai.air.ug`    | HTTP 200   | Full stack (Nginx → Next.js → DB) |
| `http://SERVER_IP:80`   | HTTP 301   | Nginx HTTP→HTTPS redirect |

### Quick health check script

Save as `/usr/local/bin/makrai-healthcheck.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

URL="https://rai.air.ug"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "${URL}" || echo "000")

if [ "${STATUS}" = "200" ]; then
  echo "OK: ${URL} returned ${STATUS}"
  exit 0
else
  echo "FAIL: ${URL} returned ${STATUS}"
  # Optional: send alert
  # curl -X POST "https://your-webhook-url" -d "RAI platform is down! HTTP ${STATUS}"
  exit 1
fi
```

```bash
sudo chmod +x /usr/local/bin/makrai-healthcheck.sh
```

Run it from cron every 5 minutes:

```cron
*/5 * * * * /usr/local/bin/makrai-healthcheck.sh >> /var/log/makrai-healthcheck.log 2>&1
```

---

## 9. Escalation Contacts & Procedures

| Level | Who                | Contact             | When to escalate                                |
| ----- | ------------------ | -------------------- | ----------------------------------------------- |
| L1    | On-call sysadmin   | (Update with email)  | Any alert from UptimeRobot                      |
| L2    | Lead developer     | (Update with email)  | App errors not fixable by restart/rollback       |
| L3    | Hetzner support    | https://console.hetzner.cloud | Hardware / network / datacenter issues |

### Escalation procedure

1. **L1 (first 15 min):** Check this runbook. Run diagnostic commands. Try
   restarting containers. If the issue is resolved, document what happened.

2. **L2 (after 15 min):** If restart/rollback doesn't fix it, contact the
   lead developer with:
   - Output of diagnostic commands (Section 7)
   - Last 100 lines of relevant container logs
   - Description of what changed recently (deploy, config change, etc.)

3. **L3 (infrastructure):** If the VPS itself is unreachable or showing
   hardware issues, open a ticket with Hetzner support.

---

## 10. Quick Reference

| Issue                        | First thing to try                                            |
| ---------------------------- | ------------------------------------------------------------- |
| Site is completely down       | `docker compose -f docker/docker-compose.prod.yml up -d`     |
| SSL error in browser          | `sudo certbot renew` (stop Nginx first)                      |
| 500 errors                    | `docker logs nextjs --tail=100`                               |
| Database connection refused   | `docker compose up -d postgres` then check logs               |
| Out of memory                 | Add swap: `sudo fallocate -l 4G /swapfile && sudo mkswap ...` |
| Disk full                     | `docker system prune -a` + clean old backups                  |
| Build failure                 | `npm run build` locally to see errors                         |
| Migration conflict            | `docker exec nextjs npx prisma migrate status`               |
