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
# Section 6.4 provisions the role with the SAME secret, read from this line.
# Never run `npm run db:provision` here: it provisions the dev passwords.
APP_DATABASE_URL="postgresql://makrai_app:STRONG_APP_PASSWORD_HERE@postgres:5432/makrai"

# The identity lane (ADR-0009): sign-in, registration, invitations and
# organisation creation connect as makrai_identity. Do not type this line;
# generate it below. The app will not start without it, or if it names a
# superuser. It is deliberately unquoted: section 6.4 reads it with sed.
# IDENTITY_DATABASE_URL=postgresql://makrai_identity:<64 hex characters>@postgres:5432/makrai

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

Then append the identity lane's URL, generated on the server so the password is
never displayed, typed or pasted (run from `/srv/makrai/app`, in a terminal outside
any AI session):

```bash
umask 077
printf 'IDENTITY_DATABASE_URL=postgresql://makrai_identity:%s@postgres:5432/%s\n' \
  "$(openssl rand -hex 32)" "$(sed -n 's/^POSTGRES_DB=//p' .env)" >> .env
grep -c '^IDENTITY_DATABASE_URL=postgresql://makrai_identity:[0-9a-f]\{64\}@postgres:5432/' .env
```

The last line prints `1` and nothing else. Hex, not base64: a base64 password can
contain `/` and `+`, which a URL would have to escape.

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
cd /srv/makrai/app

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

All three services (`nextjs`, `postgres`, `nginx`) should show `Up`. On a first
deployment `nextjs` restarts in a loop until 6.4 has run: at start it checks both
database roles and exits while the identity role has no password (ADR-0009).

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

### 6.4 Give the `makrai_app` and `makrai_identity` roles their passwords

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
APP_DB_PASSWORD="$APP_DB_PASSWORD" \
  PSQL_CMD="docker exec -i docker-postgres-1 psql -U $POSTGRES_USER" \
  scripts/provision-app-db-role.sh "$POSTGRES_DB" makrai_app
```

The script refuses the well-known development password unless
`ALLOW_DEV_DB_PASSWORD=1` is set, whatever `NODE_ENV` says, and refuses it even
when it arrives in `APP_DB_PASSWORD` (D-076) — so a `.env` still carrying
`app_dev_password` stops here instead of being provisioned. Never set that flag
on the server. The container name is
`docker-postgres-1` because Compose takes its project name from the directory
holding the compose file — `docker/` — not from the repository root.

Then clear it from the shell so it does not sit in the environment or in history:

```bash
unset APP_DB_PASSWORD; history -d $((HISTCMD-1)) 2>/dev/null || true
```

#### The identity role

Migration `20261008000100_identity_lane_role` creates `makrai_identity` the same
way: able to log in, no password (ADR-0009). Until it has one the `nextjs`
container will not start — its start-up check cannot connect as that role, and a
server that cannot verify both roles exits rather than serve. Provision it from
the `IDENTITY_DATABASE_URL` line generated in section 4. Run from `/srv/makrai/app`;
nothing is loaded into the shell and no value is printed:

```bash
IDENTITY_DB_PASSWORD="$(sed -n 's#^IDENTITY_DATABASE_URL=postgresql://makrai_identity:\([^@]*\)@.*#\1#p' .env)" \
PSQL_CMD="docker exec -i docker-postgres-1 psql -U $(sed -n 's/^POSTGRES_USER=//p' .env)" \
  scripts/provision-app-db-role.sh "$(sed -n 's/^POSTGRES_DB=//p' .env)" makrai_identity
```

Expect `makrai_identity password provisioned on '<db>'`. An empty
`IDENTITY_DB_PASSWORD` (the line is missing or quoted) is refused rather than
provisioned with a default. The script turns off statement logging for its own
session before `ALTER ROLE`, so the password does not reach the Postgres log even
where `log_statement` is on.

Then start the app and check that both lanes connect as their own unprivileged
role:

```bash
docker compose --env-file .env -f docker/docker-compose.prod.yml up -d nextjs
docker exec docker-nextjs-1 node -e "
const { Client } = require('pg');
(async () => {
  for (const name of ['APP_DATABASE_URL', 'IDENTITY_DATABASE_URL']) {
    const c = new Client({ connectionString: process.env[name] });
    await c.connect();
    const { rows: [r] } = await c.query('SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    console.log(name, r.current_user, r.rolsuper, r.rolbypassrls);
    await c.end();
  }
})();"
docker inspect docker-nextjs-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1 | grep -cx DATABASE_URL
```

Expect `APP_DATABASE_URL makrai_app false false`,
`IDENTITY_DATABASE_URL makrai_identity false false`, and `0`: the web container
holds no owner-role URL.

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

### 7.3 Security log retention (DEP-07)

The application's audit trail — logins, lockouts, admin actions, membership
changes, evidence uploads — is written by `lib/security-logger.ts` as one JSON
object per line on stdout. Two pieces of configuration decide what happens to
that stream, and **neither works without the other**:

| Where | What it decides | File |
| --- | --- | --- |
| Repo | *Where* the stream goes | `docker/docker-compose.prod.yml` — every service sets `logging: driver: journald` |
| Host | *How long* it is kept | `/etc/systemd/journald.conf.d/99-makrai.conf` — source of truth kept at `docker/journald/99-makrai.conf` |

**Retention is 90 days**, enforced by `MaxRetentionSec=90day`, capped at 2 GB of
disk by `SystemMaxUse`.

#### Why not the Docker defaults

`/etc/docker/daemon.json` already carried `{"max-size":"10m","max-file":"5"}`,
and this looks like a retention policy. It is not. Those options bound how much
disk the log file uses; they do not change the fact that the file lives at
`/var/lib/docker/containers/<id>/<id>-json.log` and is **deleted with the
container**. Since a redeploy recreates the container, every redeploy destroyed
the audit trail. `json-file` also has no time-based rotation at all, so "90
days" cannot be expressed in it even in principle.

This was not theoretical. Before the fix, nginx's own log recorded a successful
login, two membership additions, an invitation registration and a password
change between 29 and 31 August 2026 — all before the then-current container
started at `2026-08-31T07:15:40Z`, and none of them recoverable.

#### Installing the host half

```bash
sudo install -m 0644 docker/journald/99-makrai.conf /etc/systemd/journald.conf.d/99-makrai.conf
sudo ln -sf /dev/null /etc/systemd/journald.conf.d/syslog.conf
sudo systemctl restart systemd-journald
```

**The second line is required, not optional.** systemd orders drop-ins by
*filename across all directories* — `/etc` does not outrank `/usr/lib` except
for files of the same name. The vendor drop-in
`/usr/lib/systemd/journald.conf.d/syslog.conf` sorts after `99-makrai.conf`, so
without the mask its `ForwardToSyslog=yes` wins and every entry is duplicated
into `/var/log/syslog` under logrotate's own shorter schedule — a second copy of
other organisations' personal data that the 90-day policy does not describe.
This failed silently on first install; see "Verifying" below for the check that
caught it.

#### Reading the log

```bash
# Everything the app has emitted, newest last
journalctl CONTAINER_TAG=makrai/docker-nextjs-1

# Just the security events, as JSON
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 -o cat | grep '"event":'

# One organisation's activity over a window
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since "2026-09-01" -o cat | grep '"event":'

# How much disk the journal holds, and the oldest entry still kept
journalctl --disk-usage
journalctl -o short-iso | head -1
```

Tags are `makrai/docker-nextjs-1`, `makrai/docker-postgres-1`,
`makrai/docker-nginx-1`, `makrai/docker-migrator-run-*`.

#### Verifying (do not trust the config file)

Every setting below was checked by observing behaviour, not by reading config
back — writing the file and restarting the service reports success either way.

```bash
# 1. The driver is actually attached to the containers
docker inspect -f '{{.HostConfig.LogConfig.Type}}' docker-nextjs-1   # -> journald

# 2. Forwarding is really off: the marker must appear in ONE place, not two
MARK="fwdtest-$(date +%s)"; logger -t makrai-test "$MARK"; sleep 3
journalctl -t makrai-test --since -2min | grep -c "$MARK"   # -> 1
grep -c "$MARK" /var/log/syslog                             # -> 0   (1 means the mask is missing)

# 3. The disk cap took effect — journald reports its own limit
journalctl -u systemd-journald -o cat | grep 'System Journal' | tail -1   # -> "max 2.0G"

# 4. THE ONE THAT MATTERS: logs survive a redeploy
OLD=$(docker inspect -f '{{.Id}}' docker-nextjs-1 | cut -c1-12)
cd /srv/makrai/app/docker && docker compose --env-file ../.env -f docker-compose.prod.yml up -d --force-recreate nextjs
docker ps -a --format '{{.ID}}' | grep -c "^$OLD"      # -> 0  (old container is gone)
journalctl CONTAINER_ID=$OLD | grep -c 'Next.js'       # -> 1  (its logs are NOT)
```

Step 4 is the acceptance test for this whole mechanism. It was run on
2026-09-01 and passed: container `f1aa56807a3a` was destroyed and its entries
remained queryable.

#### Trade-offs accepted, so they are not "tidied up" later

- **Everything the containers print is captured, not only security events.**
  More noise, better context — when investigating you see what surrounded the
  event. The 90 days applies to all of it.
- **Rate limiting is disabled** (`RateLimitBurst=0`). journald silently discards
  messages above the default 10000-per-30s cap; for an audit trail that means a
  burst of failed logins could be partly thrown away with no error and no gap
  marker. `SystemMaxUse` carries the disk risk instead. The full reasoning is in
  `docker/journald/99-makrai.conf`.

---

## 8. Update / Redeployment Procedure

> **Check the directory before running these.** The commands below run Compose
> from `/srv/makrai/app`, which makes the project name `app`. The stack actually
> running in production was created from `/srv/makrai/app/docker` and its project
> name is **`docker`** (`docker-nextjs-1`, `docker-postgres-1`,
> `docker-nginx-1`). Compose derives the project from the working directory, so
> running these as written does **not** update the live stack — it starts a
> second one, with its own empty `app_postgres_data` volume, while the real
> containers keep running. Verified 2026-09-01 against the running containers'
> `com.docker.compose.project` label.
>
> Until this is reconciled, deploy with:
>
> ```bash
> cd /srv/makrai/app && git pull origin main
> cd /srv/makrai/app/docker
> docker compose --env-file ../.env -f docker-compose.prod.yml up -d --build
> ```

When you push new code and want to deploy it:

```bash
cd /srv/makrai/app

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
cd /srv/makrai/app

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
