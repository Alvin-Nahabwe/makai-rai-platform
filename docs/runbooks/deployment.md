# Deployment Runbook

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

This runbook walks through deploying the RAI Toolkit Platform from a bare
Hetzner CX32 VPS to a fully running production environment.

| Item             | Value                                           |
| ---------------- | ----------------------------------------------- |
| Server           | Hetzner CX32 (4 vCPU, 8 GB RAM, 80 GB disk)    |
| OS               | Ubuntu 22.04 LTS                                |
| Domain           | `makrai.org`                                    |
| SSL              | Let's Encrypt (Certbot)                         |
| Stack            | Next.js + PostgreSQL 16 + Nginx (Docker)        |
| Compose file     | `docker/docker-compose.prod.yml`                |

---

## 1. Initial Server Setup

### 1.1 SSH into the server

```bash
ssh root@YOUR_SERVER_IP
```

### 1.2 Create a non-root user

```bash
adduser alvin
usermod -aG sudo alvin

# Allow SSH for the new user
rsync --archive --chown=alvin:alvin ~/.ssh /home/alvin
```

### 1.3 Configure the firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
ufw status
```

### 1.4 Update the system

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw
```

### 1.5 Set the timezone

```bash
sudo timedatectl set-timezone Africa/Kampala
timedatectl
```

---

## 2. Install Docker & Docker Compose

```bash
# Install Docker (official method)
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group (avoids needing sudo)
sudo usermod -aG docker alvin

# Apply group change (or log out and back in)
newgrp docker

# Verify installation
docker --version
docker compose version
```

---

## 3. Clone the Repository

The repository is **private** (ruling R1), so an unauthenticated HTTPS clone fails with
`could not read Username for 'https://github.com'`. The server needs its own read-only
credential. Do this once, as the deploy user:

```bash
sudo -u alvin ssh-keygen -t ed25519 -f /home/alvin/.ssh/github_deploy -N '' -C 'makrai-vps-deploy-readonly'
sudo -u alvin tee /home/alvin/.ssh/config <<'CFG'
Host github.com
  HostName github.com
  User git
  IdentityFile /home/alvin/.ssh/github_deploy
  IdentitiesOnly yes
CFG
sudo -u alvin chmod 600 /home/alvin/.ssh/config
cat /home/alvin/.ssh/github_deploy.pub
```

Add that public key to the repository under **Settings → Deploy keys**, **without** write access.
A deploy key is scoped to the one repository, unlike a personal access token, and read-only means a
compromised server cannot push to it.

Then clone over SSH, into the server path rather than a developer's laptop path:

```bash
sudo -u alvin git clone git@github.com:Alvin-Nahabwe/makai-rai-platform.git /srv/makrai/app
cd /srv/makrai/app
```

> **Corrected 2026-08-27.** This step previously read
> `cd /home/alvin/Downloads/MAK_RAI` and
> `git clone https://github.com/YOUR_ORG/toolkit-platform.git` — a local development path and a
> placeholder org and repository name, neither of which exists. It could not be followed as
> written, and the HTTPS URL would have failed on a private repository even with the names
> corrected.

---

## 4. Configure Environment Variables

```bash
cp .env.example .env
nano .env
```

> **`--env-file .env` is not optional on the commands below, and this was found
> the hard way.** Compose looks for `.env` in the *project directory*, which
> defaults to the directory holding the compose file — `docker/`, not the repo
> root where this step just created it. Without the flag every `${VAR}` in
> `docker-compose.prod.yml` interpolates to an empty string: verified by running
> `docker compose -f docker/docker-compose.prod.yml config` with a populated
> root `.env` and reading back `NEXTAUTH_SECRET: ""`. The container then starts
> with no auth secret and no database credentials.
>
> Do **not** "fix" this with `--project-directory .` instead. It also resolves
> the variables, and it silently moves the build context one directory up — to
> `MAK_RAI/` rather than `MAK_RAI/toolkit-platform/` — so the image builds from
> the wrong tree. Both were tested; only `--env-file` is correct.

Set production values:

```env
DATABASE_URL="postgresql://makrai:STRONG_PASSWORD_HERE@postgres:5432/makrai"
POSTGRES_DB=makrai
POSTGRES_USER=makrai
POSTGRES_PASSWORD=STRONG_PASSWORD_HERE

# MUST be changed. .env.example ships the well-known local default
# `app_dev_password`; leaving it means production runs on a credential
# published in a public repository, for the role RLS depends on (D-076).
# Use the SAME secret you pass as APP_DB_PASSWORD to `npm run db:provision`.
APP_DATABASE_URL="postgresql://makrai_app:STRONG_APP_PASSWORD_HERE@postgres:5432/makrai"

NEXTAUTH_SECRET=GENERATE_WITH_openssl_rand_-base64_32
NEXTAUTH_URL=https://makrai.org

RESEND_API_KEY=re_your_production_key
# Must be an address at a domain VERIFIED in Resend. Until makrai.org is
# verified there, Resend's shared sender onboarding@resend.dev delivers only
# to the address that owns the API key above -- so invitations to anyone else
# silently do not arrive. See CLOUDFLARE_SETUP.md step 4.
EMAIL_FROM_ADDRESS=noreply@makrai.org
ADMIN_EMAIL=admin@air.ug
ADMIN_PASSWORD=STRONG_ADMIN_PASSWORD
ADMIN_NAME="Platform Admin"
```

> **Generate a secret:** `openssl rand -base64 32`
>
> **Generate a strong password:** `openssl rand -base64 24`

---

## 5. TLS certificate — Cloudflare Origin CA

**Not certbot.** This section said `certbot certonly --standalone` until
2026-08-29 and it could never have worked here: the HTTP-01 challenge arrives on
port 80, which `docker/nginx/default.conf` redirects to HTTPS unconditionally,
and the HTTPS leg needs the very certificate the challenge is trying to obtain.
It also carried a renewal cron pointing at `/home/alvin/Downloads/...`, a laptop
path that does not exist on the server.

A Cloudflare Origin CA certificate removes the problem entirely: no ACME client,
no renewal cron, no nightly nginx restart, and a 15-year lifetime. Browsers do
not trust it, which does not matter because browsers only ever talk to
Cloudflare — but it does mean **the DNS record cannot go back to grey** without
breaking the site.

### 5.1 Create it (Cloudflare dashboard)

**SSL/TLS → Origin Server → Create Certificate.** Defaults are correct: RSA 2048,
hostnames `makrai.org, *.makrai.org`, 15 years. Cloudflare shows the certificate
and the private key **once**.

### 5.2 Install it on the server

The key is a credential: keep it out of terminals that log, out of chat, and out
of the repository. Write each block to a file locally, then stream it over SSH
without printing it:

```bash
ssh root@<server> 'mkdir -p /etc/ssl/makrai && chmod 700 /etc/ssl/makrai'
cat fullchain.pem | ssh root@<server> 'cat > /etc/ssl/makrai/fullchain.pem'
cat privkey.pem   | ssh root@<server> 'cat > /etc/ssl/makrai/privkey.pem'
ssh root@<server> 'chmod 644 /etc/ssl/makrai/fullchain.pem; chmod 600 /etc/ssl/makrai/privkey.pem; chown -R root:root /etc/ssl/makrai'
```

### 5.3 Verify the pair before starting nginx

A mismatched key and certificate fail at nginx startup with a message that does
not say which one is wrong. Compare their moduli — this prints hashes, never the
key:

```bash
ssh root@<server> 'openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -modulus | openssl sha256; openssl rsa -in /etc/ssl/makrai/privkey.pem -noout -modulus | openssl sha256'
```

The two hashes must be identical. Also confirm the names and expiry:

```bash
ssh root@<server> 'openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -dates -ext subjectAltName'
```

**Put the `notAfter` date in a calendar.** Cloudflare sends no renewal reminder,
and fifteen years is comfortably longer than anyone's memory of this runbook.

---

## 6. First Deployment

### 6.1 Build and start all services

```bash
cd /home/alvin/Downloads/MAK_RAI/toolkit-platform

docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build
```

This will:
- Build the Next.js app from `docker/Dockerfile`
- Pull `postgres:16-alpine` and `nginx:alpine`
- Start all three services

### 6.2 Verify containers are running

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml ps
```

All three services (`nextjs`, `postgres`, `nginx`) should show `Up`.

### 6.3 Run database migrations

**Not** `docker exec <app> npx prisma migrate deploy`. That is what this runbook
said until 2026-08-29 and it cannot work: `prisma` and `tsx` are both
devDependencies and neither reaches the serving image, so `npx` would try to
fetch the CLI from the network at run time as an unprivileged user. Migrations
run from their own short-lived image instead — `docker/Dockerfile`'s `migrator`
stage, which is `builder` plus a default command, kept out of `up` by the
`tools` profile.

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator
```

`run --rm` removes the container afterwards; the image stays cached for the next
deploy. Expect `All migrations have been successfully applied.`

### 6.4 Give the `makrai_app` role its password

The migration in 6.3 **creates** `makrai_app`
(`prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:12`,
`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) but deliberately does
not give it a password — a password in a committed migration would publish
production's application credential to every environment and to git history.
So the role exists, is allowed to log in, and cannot authenticate until this
step runs. Skip it and the app starts cleanly and then fails every tenant-scoped
query.

`--env-file .env` hands those values to **Compose**, not to your shell, so this
step has to load them itself — and the password is derived from
`APP_DATABASE_URL` rather than retyped, so what is provisioned here cannot drift
from what the app will present:

```bash
set -a; . ./.env; set +a
APP_DB_PASSWORD="$(printf '%s' "$APP_DATABASE_URL" | sed -n 's#.*://makrai_app:\([^@]*\)@.*#\1#p')"
[ -n "$APP_DB_PASSWORD" ] && echo "parsed a ${#APP_DB_PASSWORD}-character password" || echo 'FAILED to parse — check APP_DATABASE_URL in .env'
```

That prints the password's *length*, never the password. If it reports a failure,
`APP_DATABASE_URL` is not in the expected
`postgresql://makrai_app:PASSWORD@postgres:5432/DB` shape — fix it before
continuing rather than provisioning a password the app will not send.

```bash
NODE_ENV=production APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  PSQL_CMD="docker exec -i docker-postgres-1 psql -U $POSTGRES_USER" \
  scripts/provision-app-db-role.sh "$POSTGRES_DB"
```

`NODE_ENV=production` is load-bearing: the script refuses to fall back to its
well-known development password when it is set
(`scripts/provision-app-db-role.sh:15-18`). The container name is
`docker-postgres-1` because Compose takes its project name from the directory
holding the compose file — `docker/` — not from the repository root.

Then clear it from the shell so it does not sit in the environment or in history:

```bash
unset APP_DB_PASSWORD; history -d $((HISTCMD-1)) 2>/dev/null || true
```

### 6.5 Seed the admin user

Same image, same reason as 6.3. `prisma/seed.ts` imports `lib/data/identity` and
`lib/data/preauth`, so it runs the application's own connection code and needs
6.4 to have happened first.

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator npx prisma db seed
```

### 6.6 Verify the deployment

```bash
# Should return 200
curl -s -o /dev/null -w "%{http_code}" https://makrai.org

# Check logs for errors
docker compose --env-file .env -f docker/docker-compose.prod.yml logs --tail=50
```

Open `https://makrai.org` in a browser and log in with the admin credentials
from your `.env` file.

---

## 7. Monitoring Setup

### 7.1 UptimeRobot (free tier)

1. Go to [https://uptimerobot.com](https://uptimerobot.com) and create an account
2. Add a new monitor:
   - **Type:** HTTP(s)
   - **URL:** `https://makrai.org`
   - **Interval:** 5 minutes
   - **Alert contacts:** Add your email / Slack / Telegram
3. Optionally add a keyword monitor checking for a known string on the page

### 7.2 Basic server monitoring (on the VPS)

Check resource usage at any time:

```bash
# Container CPU/memory
docker stats --no-stream

# Disk usage
df -h

# Memory
free -m

# Top processes
htop
```

---

## 8. Update / Redeployment Procedure

When you push new code and want to deploy it:

```bash
cd /home/alvin/Downloads/MAK_RAI/toolkit-platform

# Pull the latest code
git pull origin main

# Rebuild and restart (zero-downtime if no schema changes)
docker compose --env-file .env -f docker/docker-compose.prod.yml build nextjs
docker compose --env-file .env -f docker/docker-compose.prod.yml up -d

# Run any new migrations
docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator
```

**One-liner for simple updates (no migrations):**

```bash
git pull && docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build
```

---

## 9. Rollback Procedure

If a deployment goes wrong:

### 9.1 Roll back the code

```bash
cd /home/alvin/Downloads/MAK_RAI/toolkit-platform

# Find the last known good commit
git log --oneline -10

# Reset to that commit
git checkout <COMMIT_HASH>
```

### 9.2 Rebuild and restart

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build
```

### 9.3 Roll back the database (if migrations were applied)

If the new deployment included Prisma migrations that need to be undone:

1. Restore the database from the most recent backup (see
   [backup-restore.md](./backup-restore.md))
2. Then run migrations for the rolled-back code version:

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator
```

### 9.4 Verify

```bash
curl -s -o /dev/null -w "%{http_code}" https://makrai.org
docker compose --env-file .env -f docker/docker-compose.prod.yml logs --tail=30 nextjs
```

---

## 10. DNS Configuration

Make sure your DNS is configured before deployment:

| Type  | Name  | Value            | TTL  |
| ----- | ----- | ---------------- | ---- |
| A     | rai   | YOUR_SERVER_IP   | 3600 |
| AAAA  | rai   | YOUR_IPV6 (opt.) | 3600 |

You can verify DNS propagation:

```bash
dig makrai.org +short
```

---

## 11. Quick Reference

| Task                   | Command                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| Start all services     | `docker compose --env-file .env -f docker/docker-compose.prod.yml up -d`                      |
| Stop all services      | `docker compose --env-file .env -f docker/docker-compose.prod.yml down`                       |
| Rebuild & restart      | `docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build`              |
| View logs              | `docker compose --env-file .env -f docker/docker-compose.prod.yml logs -f`                    |
| Run migrations         | `docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator`                               |
| Seed admin             | `docker compose --env-file .env -f docker/docker-compose.prod.yml --profile tools run --rm migrator npx prisma db seed`                                      |
| Check container status | `docker compose --env-file .env -f docker/docker-compose.prod.yml ps`                        |
| Check SSL expiry       | `openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -dates` (Origin CA, no renewal) |
| Check SSL expiry       | `echo \| openssl s_client -connect makrai.org:443 2>/dev/null \| openssl x509 -noout -dates` |
