# Troubleshooting Runbook

> RAI Toolkit Platform — `makrai.org`
> Last updated: 2026-10-08

---


> **Container names.** Compose derives them from the directory holding the compose file
> -- `docker/` -- not from the repository root, so the services `nextjs`, `postgres` and
> `nginx` run as `docker-nextjs-1`, `docker-postgres-1` and `docker-nginx-1`. This runbook
> said `docker exec nextjs` at ten places until 2026-08-29; every one of them failed with
> "No such container". Confirm with `docker ps --format '{{.Names}}'` if in doubt.

> **Compose commands.** Run them as
> `cd /srv/makrai/app/docker && docker compose --env-file ../.env -f docker-compose.prod.yml ...`,
> the form `deployment.md` section 8 uses. The compose file has no `build:` and reads `WEB_IMAGE` and
> `MIGRATOR_IMAGE` from `.env`, so without `--env-file` Compose stops with "required
> variable WEB_IMAGE is missing a value", even for `ps` or `stop nginx`; and from any other
> directory the relative `-f` path finds no file.

## Overview

This runbook covers common production issues and their fixes for the RAI
Toolkit Platform running on a Hetzner CX32 VPS with Docker.

**Before you start:** Run the diagnostic commands in [Section 7](#7-diagnostic-commands-cheat-sheet)
to gather information about the current state of the system.

---

## 1. SSL Certificate Renewal Failure

### Symptoms

- Browser shows "Your connection is not private" / `ERR_CERT_DATE_INVALID`
- `curl https://makrai.org` returns an SSL error
- UptimeRobot alerts about HTTPS failure

### Diagnosis

```bash
# Check certificate expiry date
echo | openssl s_client -connect makrai.org:443 2>/dev/null \
  | openssl x509 -noout -dates

# Check Certbot renewal status
openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -subject -dates -ext subjectAltName
```

### Fixes

**Fix 1: Port 80 is blocked by Nginx**

Certbot needs port 80 free for the standalone challenge. Stop Nginx first:

```bash
cd /srv/makrai/app/docker

docker compose --env-file ../.env -f docker-compose.prod.yml stop nginx
# There is nothing to renew: this is a Cloudflare Origin CA certificate, valid 15 years.
# If it is genuinely expired or wrong, reissue it in the Cloudflare dashboard
# (SSL/TLS -> Origin Server) and reinstall per deployment.md 5.2.
docker compose --env-file ../.env -f docker-compose.prod.yml start nginx
```

**Fix 2: Firewall blocking port 80**

```bash
ufw allow 80/tcp
ufw reload
```

**Fix 3: DNS not pointing to this server**

```bash
dig makrai.org +short
# Should return your server's IP address
```

**Fix 4: Renew manually**

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml stop nginx
# Not applicable. Certbot cannot obtain a certificate here -- HTTP-01 arrives on
# port 80, which this nginx redirects to HTTPS, which needs the certificate being
# requested. Reissue via the Cloudflare dashboard instead; see deployment.md 5.
docker compose --env-file ../.env -f docker-compose.prod.yml start nginx
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
docker exec docker-postgres-1 pg_isready -U makrai
```

Postgres runs with `log_error_verbosity=terse` (`docker/docker-compose.prod.yml`), which keeps the
`DETAIL`, `HINT`, `QUERY` and `CONTEXT` lines out of its log, because `DETAIL` is where an error
names the row that caused it (`Key (email)=(...) already exists`). The primary message and the
`STATEMENT:` stay. If an error reads too thinly, reproduce it from a client with test data and
`\set VERBOSITY verbose` in `psql`; do not turn the setting off on the host.

### Fixes

**Fix 1: Postgres container is stopped**

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml up -d postgres
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

**Fix 3: `APP_DATABASE_URL` or `IDENTITY_DATABASE_URL` mismatch**

The app connects with `APP_DATABASE_URL` (as `makrai_app`) and `IDENTITY_DATABASE_URL`
(as `makrai_identity`) from `.env`. Each password must match the one its Postgres role was
given (`deployment.md` 6.4). `DATABASE_URL`, the owner's URL, goes to the migrator and
not to the app. The hostname must be `postgres` (the Docker service name), not `localhost`:

```env
APP_DATABASE_URL="postgresql://makrai_app:YOUR_PASSWORD@postgres:5432/makrai"
IDENTITY_DATABASE_URL=postgresql://makrai_identity:YOUR_PASSWORD@postgres:5432/makrai
```

After fixing, recreate the app so that it reads the new values. `restart` would keep the
old environment:

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml up -d --no-deps nextjs
```

**Fix 4: Postgres volume corruption (last resort)**

```bash
# ⚠️ THIS DESTROYS ALL DATA — restore from backup afterward
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml down
docker volume rm toolkit-platform_postgres_data
docker compose --env-file ../.env -f docker-compose.prod.yml up -d
# Then restore from backup — see backup-restore.md
```

---

## 3. OOM (Out of Memory) on Small VPS

### Symptoms

- Containers killed unexpectedly
- `dmesg` shows `oom-killer` entries
- `docker stats` shows memory near 100%
- A release build fails in GitHub Actions (`release.yml`; the host builds nothing)

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
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile

# Make it permanent
echo '/swapfile none swap sw 0 0' | tee -a /etc/fstab

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

The host builds nothing: `release.yml` builds the images on GitHub's runners
(`deployment.md` section 8). If an image ever has to be built by hand and the VPS runs out
of memory doing it, build it on a machine with more RAM and transfer it:

```bash
# On your local machine
docker build -t rai-platform -f docker/Dockerfile .
docker save rai-platform | gzip > rai-platform.tar.gz
scp -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none rai-platform.tar.gz root@<server>:/tmp/

# On the server
docker load < /tmp/rai-platform.tar.gz
```

---

## 4. Next.js Build Failure

### Symptoms

- A release build fails in GitHub Actions, or `docker build` fails on your machine
- Build output shows TypeScript errors, missing modules, or OOM

### Diagnosis

The release workflow builds the images; the host does not. Read the failed run's log,
then reproduce the build from a checkout on a machine with Docker:

```bash
gh run view <run id> -R <owner>/<repo> --log-failed

# From the repository root, with verbose output
docker build --no-cache --target runner -f docker/Dockerfile . 2>&1 | tail -80
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
du -sh /* | sort -rh | head -10

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
journalctl --vacuum-size=100M
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

> The Prisma CLI is a devDependency and is **not** in the serving image -- only
> the generated client is (`docker/Dockerfile`). Every command below therefore
> runs in the one-off `migrator` container, never via `docker exec` into the app.

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml --profile tools run --rm --no-deps migrator npx prisma migrate status
```

### Fixes

**Fix 1: Resolve migration conflicts**

If a migration was partially applied:

```bash
# Mark a failed migration as rolled back
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml --profile tools run --rm --no-deps migrator npx prisma migrate resolve --rolled-back MIGRATION_NAME
```

If a migration was manually applied outside Prisma:

```bash
# Mark it as already applied
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml --profile tools run --rm --no-deps migrator npx prisma migrate resolve --applied MIGRATION_NAME
```

**Fix 2: Reset the database — deliberately not given as a command here**

`prisma migrate reset --force` drops every table and re-seeds. In this runbook
it would run through the `migrator` service, whose `DATABASE_URL` is the
**production** database — so a copy-pasted line would destroy live tenant data
with no prompt and no undo.

It was previously written here as `docker exec nextjs ...`, which failed with
"No such container" and was harmless by accident. Correcting the container name
would have turned a broken command into a working one, so the command is removed
rather than fixed.

If you genuinely need a reset:

- **Production:** you do not. Restore from a backup instead —
  `docs/runbooks/backup-restore.md` §3. A reset discards data a restore recovers.
- **A local or scratch database:** run it against that database explicitly, from
  a checkout, with `DATABASE_URL` pointed at the throwaway instance by hand. Not
  through this compose file, which is wired to production.

**Fix 3: Schema drift**

If the database schema doesn't match the Prisma schema:

```bash
# Pull the actual DB schema into Prisma (creates a diff)
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml --profile tools run --rm --no-deps migrator npx prisma db pull
```

**Do not reach for `prisma migrate dev` to reconcile.** It cannot run in this
repository at all, and has not been able to since 2026-08-03 — register rows
D-109 and D-228 both record it. `migrate dev` first replays every migration into
a shadow database built from nothing, and
`prisma/migrations/20260803062144_add_restricted_app_role/migration.sql` revokes
privileges on `_prisma_migrations`, a table that does not yet exist at that point
in the replay, so the whole command dies. `migrate deploy` is unaffected: no
shadow database, same SQL.

Author the reconciling migration by hand instead — a new directory under
`prisma/migrations/` with a timestamped name and a `migration.sql` — then apply
it with `migrate deploy` through the migrator.

---

## 7. Diagnostic Commands Cheat Sheet

Run these commands to gather system state before troubleshooting:

```bash
# --- Container Status ---
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml ps
docker stats --no-stream

# --- Application Logs ---
docker logs nextjs --tail=100
docker logs postgres --tail=100
docker logs nginx --tail=100

# Combined logs (all services)
docker compose --env-file ../.env -f docker-compose.prod.yml logs --tail=100

# --- System Resources ---
df -h            # Disk space
free -m          # Memory
uptime           # Load average
nproc            # CPU count

# --- Network ---
curl -s -o /dev/null -w "%{http_code}" https://makrai.org
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000   # Direct to Next.js (from inside Docker network)

# --- SSL ---
echo | openssl s_client -connect makrai.org:443 2>/dev/null | openssl x509 -noout -dates

# --- Database ---
docker exec docker-postgres-1 pg_isready -U makrai
docker exec docker-postgres-1 psql -U makrai -d makrai -c "SELECT count(*) FROM pg_stat_activity;"

# --- Docker ---
docker system df          # Docker disk usage
docker system events      # Live event stream (Ctrl+C to stop)
```

---

## 8. Health Check Endpoints

| Endpoint                | Expected   | What it checks           |
| ----------------------- | ---------- | ------------------------ |
| `https://makrai.org/api/health` | HTTP 200, body `{"status":"ok"}` | Nginx → Next.js, and the web process can run `SELECT 1` on the database as `makrai_app` |
| `docker inspect -f '{{.State.Health.Status}}' docker-nextjs-1` | `healthy` | The same request, made from inside the container on `127.0.0.1:3000`, so nginx, Cloudflare and the firewall are not part of the answer |
| `https://makrai.org`    | HTTP 200   | Full stack (Nginx → Next.js → DB) |
| `http://SERVER_IP:80`   | HTTP 301   | Nginx HTTP→HTTPS redirect |

### What `/api/health` says

The body is only ever `{"status":"ok"}` (200) or `{"status":"unavailable"}` (503). It carries no
version, no error text and no timing, and it is never cached. A failed check leaves one line in the
container's log, never in the response. The line is a fixed phrase and how the check ended, either
`(timeout)` or the error's class name; it does not carry the driver's message, so it holds no role,
host or connection detail:

```bash
docker logs docker-nextjs-1 --since 15m 2>&1 | grep 'health: database check failed'
```

For the cause, look at the database itself (section 2), not at that line.

| What you see | What it means | First thing to try |
| ------------ | ------------- | ------------------ |
| 200 `{"status":"ok"}` | The app answers and the database answers `SELECT 1` within 2 seconds. | Nothing. |
| 503 `{"status":"unavailable"}` | The app is up and the database is not: refused, a wrong password (after a rotation, say), or no answer in 2 seconds. The log line says `(timeout)` or the error class. | `cd /srv/makrai/app/docker && docker compose --env-file ../.env -f docker-compose.prod.yml ps postgres`, then [section 2](#2-database-connection-refused). |
| No answer, `unhealthy`, container restarting | Nothing is listening. The boot check in `instrumentation.ts` exits the process when `APP_DATABASE_URL` or `IDENTITY_DATABASE_URL` is unset, or a database role is privileged or cannot be checked, so a restart loop is that check refusing, not a crash. | `docker logs docker-nextjs-1 --tail=50` and look for `Refusing to start`. |
| No answer, container `Up` and `unhealthy` | The server is not listening on loopback. The runner image must set `ENV HOSTNAME=0.0.0.0` (D-236); a stale image built before it was added lacks it. | `docker exec docker-nextjs-1 printenv HOSTNAME` should print `0.0.0.0`. Deploy a release built after the fix (`deployment.md` section 8). |

**`unhealthy` is reported, not repaired.** Compose does not restart an unhealthy container, so the
uptime monitor raises the alert and the owner acts on it. (`restart: unless-stopped` restarts a
container that exits, and nginx waits for the app to start, not to be healthy.) The container's
health shows in `docker compose ps` as `(healthy)` or `(unhealthy)`. After a deploy it reads
`starting` for up to 30 seconds and then `healthy`.

### Uptime monitor

Point the external monitor at the endpoint rather than the home page: type **Keyword**, URL
`https://makrai.org/api/health`, keyword `"status":"ok"`. A 503 fails it by status, and the keyword
fails it if something in front of the app answers 200 with another page.

### Quick health check script

Save as `/usr/local/bin/makrai-healthcheck.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

URL="https://makrai.org/api/health"
RESULT=$(curl -s -w ' %{http_code}' --max-time 10 "${URL}" || echo " 000")

if [ "${RESULT}" = '{"status":"ok"} 200' ]; then
  echo "OK: ${URL} returned ${RESULT}"
  exit 0
else
  echo "FAIL: ${URL} returned ${RESULT}"
  # Optional: send alert
  # curl -X POST "https://your-webhook-url" -d "RAI platform is down! ${RESULT}"
  exit 1
fi
```

```bash
chmod +x /usr/local/bin/makrai-healthcheck.sh
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
| Site is completely down       | `cd /srv/makrai/app/docker && docker compose --env-file ../.env -f docker-compose.prod.yml up -d` |
| SSL error in browser          | `# There is nothing to renew: this is a Cloudflare Origin CA certificate, valid 15 years.
# If it is genuinely expired or wrong, reissue it in the Cloudflare dashboard
# (SSL/TLS -> Origin Server) and reinstall per deployment.md 5.2.` (stop Nginx first)                      |
| 500 errors                    | `docker logs nextjs --tail=100`                               |
| Database connection refused   | `cd /srv/makrai/app/docker && docker compose --env-file ../.env -f docker-compose.prod.yml up -d postgres` then check logs |
| Out of memory                 | Add swap: `fallocate -l 4G /swapfile && mkswap ...` |
| Disk full                     | `docker system prune -a` + clean old backups                  |
| Build failure                 | `npm run build` locally to see errors                         |
| Migration conflict            | `... run --rm migrator npx prisma migrate status`               |
