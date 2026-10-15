# Deployment Runbook

> **NOT YET EXECUTED.** The domain is `makrai.org` (confirmed 2026-08-18), but
> nothing is configured: no server, no DNS, no TLS. This runbook has never been
> run end to end, and the 2026-08-17 audit found the procedure as written cannot
> produce a working deployment — it starts after the server already exists and
> omits roughly nine provisioning steps. Expect to correct it while performing
> the first real deployment, not before.

> RAI Toolkit Platform — `makrai.org`
> Last updated: 2026-10-15

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
| Images           | Built by GitHub Actions on a tag, run by digest (section 8) |

---

## 1. Initial Server Setup

### 1.1 SSH into the server

```bash
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server>
```

### 1.2 Create a non-root user

```bash
adduser alvin
```

This account has no authorized key, so it has no SSH login. It has no sudo rule and is not in
the sudo group: every SSH login is root's, with the operator key and a TOTP code (section 12).
Besides the cron jobs, it holds the read-only GitHub deploy key and owns the server checkout
(section 3), and section 2 puts it in the docker group, which is root-equivalent. That residual
is recorded for the M0-10 evaluation.

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
apt update && apt upgrade -y
apt install -y curl git ufw
```

### 1.5 Set the timezone

```bash
timedatectl set-timezone Africa/Kampala
timedatectl
```

---

## 2. Install Docker & Docker Compose

```bash
# Install Docker (official method)
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (avoids needing sudo)
usermod -aG docker alvin

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
>
> The Compose commands in sections 6 and 11 run the way section 8's do: from
> `/srv/makrai/app/docker`, with `--env-file ../.env`.

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

# The images this host runs, by digest. Section 8 sets them from the `web:` and
# `migrator:` lines of a GitHub release body: not typed from memory, and never a
# tag. Compose refuses to start while either is unset or empty.
WEB_IMAGE=ghcr.io/<owner>/makrai-web@sha256:<64 hex characters>
MIGRATOR_IMAGE=ghcr.io/<owner>/makrai-migrator@sha256:<64 hex characters>

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

### 4.1 The registry pull credential

The release images are in a private package on ghcr.io, so the host needs a
credential to pull them. It is **read-only, expires after 90 days, lives only on the
server, and is removed once the packages are public, at the move to the public
repository (Phase C Task 36)**, because a public package needs no credential to pull.

1. **The owner creates it**, in their own browser: GitHub, Settings, Developer
   settings, Personal access tokens (classic), Generate new token (classic). Tick
   **`read:packages`** and nothing else, and set the expiry to 90 days. GitHub shows
   the token once.
2. **The owner logs the host in**, in their own SSH session (section 12.1) in a
   terminal outside the Claude app. The token is typed at the hidden password prompt,
   never put in a command line, a file or a chat:

   ```bash
   docker login ghcr.io -u <github-user>
   ```

3. **Check it** without printing anything but a count. Expect `1`:

   ```bash
   grep -c '"ghcr.io"' /root/.docker/config.json
   ```

4. **Record the expiry date** in the owner's credential register (row C26), with
   the date to renew it by.

Docker keeps the token in `/root/.docker/config.json`, readable by root only. When it
expires, `docker compose pull` fails with `unauthorized` or `denied` and nothing else
changes: the running containers are unaffected, and only a deploy, or a rollback to
an image no longer on the host, stops. To renew, create a new token and repeat step
2, then delete the old token in GitHub. To remove the credential, run
`docker logout ghcr.io` and delete the token in GitHub.

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
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'mkdir -p /etc/ssl/makrai && chmod 700 /etc/ssl/makrai'
cat fullchain.pem | ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'cat > /etc/ssl/makrai/fullchain.pem'
cat privkey.pem   | ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'cat > /etc/ssl/makrai/privkey.pem'
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'chmod 644 /etc/ssl/makrai/fullchain.pem; chmod 600 /etc/ssl/makrai/privkey.pem; chown -R root:root /etc/ssl/makrai'
```

Each `ssh` line is a login of its own (section 12.1). It asks for the key's passphrase, then a
code not used before.

### 5.3 Verify the pair before starting nginx

A mismatched key and certificate fail at nginx startup with a message that does
not say which one is wrong. Compare their moduli — this prints hashes, never the
key:

```bash
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -modulus | openssl sha256; openssl rsa -in /etc/ssl/makrai/privkey.pem -noout -modulus | openssl sha256'
```

The two hashes must be identical. Also confirm the names and expiry:

```bash
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> 'openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -dates -ext subjectAltName'
```

**Put the `notAfter` date in a calendar.** Cloudflare sends no renewal reminder,
and fifteen years is comfortably longer than anyone's memory of this runbook.

---

## 6. First Deployment

### 6.1 Pull and start all services

The host builds nothing. `WEB_IMAGE` and `MIGRATOR_IMAGE` in `.env` (section 4) name
a release's images, so a release has to exist first (section 8.1), and the host has
to be logged in to the registry (section 4.1).

```bash
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

$C pull nextjs migrator
$C up -d
```

Every block in this section that runs Compose sets `$C` and moves to
`/srv/makrai/app/docker` itself, and every block that reads `.env` or `scripts/` moves to
`/srv/makrai/app` first, so each can be run on its own (6.4's first two share the values
the first one loads or derives from `.env`, `APP_DB_PASSWORD`, `POSTGRES_USER` and `POSTGRES_DB`, so
they run in one shell). This one has no `--no-deps`: it
starts all three services.

This will:
- Pull the two release images by digest
- Pull postgres and nginx at the digests `docker/docker-compose.prod.yml` pins
- Start all three services

### 6.2 Verify containers are running

```bash
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

$C ps
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
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

$C --profile tools run --rm --no-deps migrator
```

`run --rm` removes the container afterwards; the image stays cached for the next
deploy. Expect `All migrations have been successfully applied.` `--no-deps` does not
wait for Postgres, so run it once `$C ps` shows `postgres` as `(healthy)`.

### 6.4 Give the `makrai_app` and `makrai_identity` roles their passwords

The migration in 6.3 **creates** `makrai_app`
(`prisma/migrations/20260803062144_add_restricted_app_role/migration.sql:12`,
`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`) but deliberately does
not give it a password — a password in a committed migration would publish
production's application credential to every environment and to git history.
So the role exists, is allowed to log in, and cannot authenticate until this
step runs. Skip it and the app starts cleanly and then fails every tenant-scoped
query.

`--env-file ../.env` hands those values to **Compose**, not to your shell, so this
step has to load them itself — and the password is derived from
`APP_DATABASE_URL` rather than retyped, so what is provisioned here cannot drift
from what the app will present:

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a
APP_DB_PASSWORD="$(printf '%s' "$APP_DATABASE_URL" | sed -n 's#.*://makrai_app:\([^@]*\)@.*#\1#p')"
[ -n "$APP_DB_PASSWORD" ] && echo "parsed a ${#APP_DB_PASSWORD}-character password" || echo 'FAILED to parse — check APP_DATABASE_URL in .env'
```

That prints the password's *length*, never the password. If it reports a failure,
`APP_DATABASE_URL` is not in the expected
`postgresql://makrai_app:PASSWORD@postgres:5432/DB` shape — fix it before
continuing rather than provisioning a password the app will not send.

```bash
cd /srv/makrai/app
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
cd /srv/makrai/app
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
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

$C up -d --no-deps nextjs
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

`ADMIN_PASSWORD` must be set in `.env` first. The seed refuses, naming the variable, when it is
empty; it never generates a password. It prints neither the password nor the admin's address,
because the migrator's output goes to the host journal.

```bash
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

$C --profile tools run --rm --no-deps migrator npx prisma db seed
```

### 6.6 Verify the deployment

```bash
# Should return 200
curl -s -o /dev/null -w "%{http_code}" https://makrai.org

# Check logs for errors
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"
$C logs --tail=50
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

On the server, do not paste the block below as written: its first line installs straight from
the checkout, which the operator can write. Install that file with the staged-install rule in
[`ops/host/README.md`](../../ops/host/README.md) ("Installing from the checkout"), then run the
other two lines.

```bash
install -m 0644 docker/journald/99-makrai.conf /etc/systemd/journald.conf.d/99-makrai.conf
ln -sf /dev/null /etc/systemd/journald.conf.d/syslog.conf
systemctl restart systemd-journald
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

### 7.4 Synthetic journey

Once an hour, a synthetic account signs in to `https://makrai.org`, saves its in-progress
assessment and reads it back (`scripts/synthetic-journey.mjs`; RL 2.3). It is the one check that
goes through the whole product the way a person does: DNS, Cloudflare, nginx, Next.js, the
session and Postgres. It publishes `"syntheticJourneyInterval": "PT1H"`
(`public/service-parameters.json`), and GitHub's `schedule` could not keep that (it fires hours
late or not at all), so the hourly run is on the host.

- **Where it runs.** Root's crontab, at 7 past every hour: `makrai-synthetic.sh --ping`
  (`ops/host/crontab.root`). The journey runs in a throwaway container built from the image the
  running web container `docker-nextjs-1` is using, with root's copy of the script in
  `/usr/local/lib/makrai`. The install, the post-check and the rollback are in
  [`ops/host/README.md`](../../ops/host/README.md), "Hourly synthetic journey (Task 20b)"; they
  take one approval window (12.2) after the release that carries them is deployed (section 8).
- **The check.** A pass sends one success ping, and a failure sends `/fail`, to the healthchecks
  check whose URL is `HC_SYNTHETIC_PING_URL` in the server `.env`. During the soak that check is
  `makrai-synthetic-host`; the README says what it becomes. Silence (the host, cron or Docker
  dead) is reported by the check's own timing.
- **The log.** `/var/log/makrai/synthetic.log`, mode 600. `tail -n 8` shows the last run: one
  `step=<name> status=<code>` line per step, every attempt's lines, and `result=pass|fail at=<UTC
  time>` last. A fault that clears on the retry is on record there even though nothing alerted.
- **Deploys.** A failed first attempt is tried once more after 60 seconds, so a swap at 7 past in
  D2 step 5 is absorbed by the retry: the old container is replaced, the first attempt fails, the
  second passes against the new one, and healthchecks hears one success ping. A swap that takes
  longer than that sends `/fail` once, and the next hour's ping clears it. Do not run the script
  by hand between :05 and :12.
- **Drift.** Root runs its own copy of the journey, not the checkout's, so the host does not move
  when the checkout does. Any change to `scripts/synthetic-journey.mjs` ships with a staged
  reinstall of it (the install chain in the README); so does a change to `makrai-synthetic.sh` or
  to the `7 * * * *` line in `crontab.root`. Until then the host keeps running the old one.

---

## 8. Update / Redeployment Procedure

Every deploy runs a **release**: the two images, `web` and `migrator`, that
`.github/workflows/release.yml` built from a version tag, pushed to ghcr.io and
named by digest in the GitHub release body. The host builds nothing. Compose
refuses to start while `WEB_IMAGE` or `MIGRATOR_IMAGE` in `.env` is unset or
empty (section 4), so a host with no image reference does not start by accident.
This is procedure **D2**.

Every step that changes the server is the owner's: root, in the owner's own SSH
session (section 12.1), in a terminal outside the Claude app. An agent reaches the
server only through a window the owner opens (12.2), and only to read.

**Rules for every step in sections 8 and 9:**

- **Run Compose from `/srv/makrai/app/docker`, nowhere else.** The running stack's
  project name is `docker` (`docker-nextjs-1`, `docker-postgres-1`,
  `docker-nginx-1`), checked 2026-09-01 against the running containers'
  `com.docker.compose.project` label. The relative `-f docker-compose.prod.yml` and
  `--env-file ../.env` resolve only from `/srv/makrai/app/docker`, and Compose names
  the project after the compose file's directory.
- **`--no-deps` on every `up` and `run`.** A step that names one service touches that
  service only.
- **Git on the checkout runs as `<operator>`, from root's session.**
  `/srv/makrai/app` is owned by that account, and git refuses to run as root there
  (dubious ownership). Use `sudo -u <operator> git -C /srv/makrai/app …`. Never
  `git pull` as root, and never change the checkout's owner to get past the refusal.
- **After a change to `docker/nginx/default.conf`, `docker restart docker-nginx-1`.
  Never `nginx -s reload`.** The file is a single-file bind mount. Git replaces the
  file with a new one, the container keeps the old one, and a reload reads the old
  content and reports success. For the same reason `nginx -t` inside the running
  container tests the old file, not the new one.
- **No migration deploys between 00:00 and 01:10 UTC.** The 01:00 restore test
  compares the restored backup with the live database, and a migration added after
  the 00:00 backup shows up as `MISMATCH migrations`
  ([backup-restore.md](./backup-restore.md), "Deploy window").

Set these once per session:

```bash
cd /srv/makrai/app/docker
C="docker compose --env-file ../.env -f docker-compose.prod.yml"

# Sets KEY=value in .env: replaces the line or appends it, keeps the file's mode,
# opens no editor. For values that are not secret; the image references are not.
set_env() { local k="$1" v="$2" f=/srv/makrai/app/.env
  ( umask 077; V="$v" awk -v k="$k" 'index($0,k"=")==1{print k"="ENVIRON["V"];d=1;next}{print}END{if(!d)print k"="ENVIRON["V"]}' "$f" >"$f.new" ) \
  && cat "$f.new" >"$f" && rm -f "$f.new"; }
```

### 8.1 Cut the release (before every deploy)

Every deploy needs a release of its own, including one made only so that the server
checkout holds new tracked files: 8.3 moves the checkout to the release tag. The
release workflow builds only when the tag **equals the `version` in `package.json`**
and the tagged commit is **on `main`**, and it never rebuilds a tag that already has
a release.

1. The change's pull request raises `version` in `package.json` and
   `package-lock.json` above the last release:
   `npm version X.Y.Z --no-git-tag-version`.
2. After the merge, **owner approval required:** the owner tags the merged commit and
   pushes the tag, from a clone on their own machine:

   ```bash
   git fetch origin main
   git tag vX.Y.Z <merge commit>
   git push origin vX.Y.Z
   ```

3. Watch the run for this tag, on the same machine. It must succeed. A tag push
   records the tag as the run's branch, so `--branch vX.Y.Z` selects this tag's run
   and not the previous release's; the loop waits until the run exists:

   ```bash
   ID=
   until [ -n "$ID" ]; do
     ID=$(gh run list -R <owner>/<repo> --workflow release.yml --branch vX.Y.Z --limit 1 --json databaseId --jq '.[0].databaseId // empty')
     [ -n "$ID" ] || sleep 5
   done
   gh run watch "$ID" -R <owner>/<repo> --exit-status
   ```

4. Read the two references this section uses:

   ```bash
   gh release view vX.Y.Z -R <owner>/<repo> --json body --jq .body
   ```

   Two lines, `web: ghcr.io/<owner>/makrai-web@sha256:<64 hex>` and
   `migrator: ghcr.io/<owner>/makrai-migrator@sha256:<64 hex>`.

A run that refuses a tag (not a plain `vX.Y.Z`, not equal to `package.json`, not on
`main`, or already released) has built and published nothing. Correct the cause,
usually a version that was not raised, and tag the corrected version.

### 8.2 Pre-check

Run these, read the output, and write down the PREV lines: section 9 returns to them.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://makrai.org/login
sudo -u <operator> git -C /srv/makrai/app status --porcelain
sudo -u <operator> git -C /srv/makrai/app describe --tags --always
grep -E '^(WEB_IMAGE|MIGRATOR_IMAGE)=' ../.env
docker inspect -f '{{.Image}}' docker-nextjs-1
```

`/login` returns `200` and the status prints nothing. The last three lines are PREV:
the tag or commit now checked out, the two references now in `.env`, and the image
ID now running. Before the first release is deployed, `.env` has no image lines and
the host runs an image it built itself; step 0 of 8.3 gives that image a name.

**If the release adds a migration** (the pull request says so):

```bash
tail -n 1 /srv/makrai/restore-test.log | grep -c 'Restore test FAILED'
sudo -u <operator> /usr/local/bin/makrai-backup.sh
tail -n 2 /srv/makrai/backup.log | grep -cE '(watchdog pinged|Backup complete\.)$'
ls -t /srv/makrai/backups/makrai-*.sql.gz.gpg | head -n 1
```

The first prints `0`: a failed restore test stops a schema change. The third prints
`2`: the backup you just took finished and pinged. The live script writes
`Backup complete.` after `watchdog pinged`, so a `tail -n 1` form would always
print `0`. The last prints the name of that backup. **Write it down as BACKUP:** it
is the last copy of the database from before the migrator runs, and 9.3 restores
exactly that file.

### 8.3 Apply

```bash
# 0. The first release only: name the images the host built itself, so that 9.2 and
#    9.3 can return to them. They are local to this host and are in no registry.
docker image tag "$(docker inspect -f '{{.Image}}' docker-nextjs-1)" makrai-nextjs:rollback
docker image tag docker-migrator makrai-migrator:rollback

# 1. The checkout moves to the release tag, as <operator>. Prints vX.Y.Z.
sudo -u <operator> git -C /srv/makrai/app fetch --tags origin
sudo -u <operator> git -C /srv/makrai/app checkout --detach vX.Y.Z
sudo -u <operator> git -C /srv/makrai/app describe --tags --exact-match

# 2. Point .env at the release: the two references from 8.1 step 4.
set_env WEB_IMAGE 'ghcr.io/<owner>/makrai-web@sha256:<64 hex>'
set_env MIGRATOR_IMAGE 'ghcr.io/<owner>/makrai-migrator@sha256:<64 hex>'
grep -cE '^(WEB|MIGRATOR)_IMAGE=ghcr\.io/[a-z0-9-]+/makrai-(web|migrator)@sha256:[0-9a-f]{64}$' ../.env

# 3. Pull. The only step that needs the registry login (section 4.1).
$C pull nextjs migrator

# 4. Only if the release adds a migration: run it while the old app is still serving.
$C --profile tools run --rm --no-deps migrator

# 5. Replace the app, and wait up to 120 seconds for its health check to pass.
$C up -d --no-deps --wait --wait-timeout 120 nextjs

# 6. Another service, other than nginx, whose definition changed in the compose file
#    (postgres on a new digest, say). The diff shows which service block changed.
#    Postgres is down for seconds; its volume stays.
sudo -u <operator> git -C /srv/makrai/app diff <PREV tag> <new tag> -- docker/docker-compose.prod.yml
$C up -d --no-deps <service>

# 7. nginx, if its image digest in the compose file (step 6's diff shows it) or
#    docker/nginx/default.conf changed. This shows whether the file changed; empty
#    output means it did not, and 7b does not apply:
sudo -u <operator> git -C /srv/makrai/app diff --stat <PREV tag> <new tag> -- docker/nginx/default.conf
#
#    Nothing recreates or restarts nginx except the commands below, each
#    chained on a test of the NEW image with the NEW file in a throwaway container,
#    on the stack's network so that `nextjs` resolves. A broken file or image
#    therefore never reaches the running nginx. Never reload (rules above).
#
#    7a. The image digest changed: the recreate picks up the new file too.
docker run --rm --network docker_default \
  -v /srv/makrai/app/docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/ssl/makrai:/etc/ssl/makrai:ro \
  "$($C config --images | grep '^nginx:')" nginx -t \
  && $C up -d --no-deps nginx

#    7b. Only the file changed: git replaced it and the container keeps the old one,
#        so it is restarted.
docker run --rm --network docker_default \
  -v /srv/makrai/app/docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/ssl/makrai:/etc/ssl/makrai:ro \
  "$($C config --images | grep '^nginx:')" nginx -t \
  && docker restart docker-nginx-1
```

Step 0 names what the last build on this host left: `docker-nextjs-1` runs the web
image, and `docker-migrator` is the name Compose gave the migrator image it built. If
`docker image inspect docker-migrator` fails, the host has no earlier migrator image:
skip that line, and 9.3 then has no migrator to return to for the first release.

The `grep` in step 2 prints `2`: both lines are digest references, not tags. The
migrator prints `All migrations have been successfully applied.` Step 7 prints
`test is successful` before it acts; a failing test leaves the running nginx
untouched, and the cause is in its output. `$C config --images` prints each image
exactly as the compose file pins it (`nginx:1.31-alpine@sha256:…`), so the test runs the
nginx the checked-out file names. `docker_default` is the stack's network because the
project is `docker`; `docker network ls` shows it. Step 5 exits non-zero
if `nextjs` is not healthy within the 120 seconds: roll back (section 9).

If step 3 fails (an expired credential, a mistyped digest), the running stack has not
changed. Fix the cause and repeat step 3, or put the checkout and `.env` back to PREV
with the first three commands of 9.2: the `checkout --detach`, `set_env WEB_IMAGE` and
`set_env MIGRATOR_IMAGE`. Do not leave `.env` pointing at images the host has not
pulled.

### 8.4 Post-check

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://makrai.org/login
$C ps
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since -10min -p err -o cat | wc -l
[ "$(docker inspect -f '{{.Config.Image}}' docker-nextjs-1)" = "$(sed -n 's/^WEB_IMAGE=//p' ../.env)" ] && echo SAME || echo DIFFERENT
[ "$(docker inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' docker-nextjs-1)" = "$(sudo -u <operator> git -C /srv/makrai/app describe --tags --exact-match | sed 's/^v//')" ] && echo SAME || echo DIFFERENT
```

Expect `200`; every service `Up` and `nextjs` `healthy`; `0`; and `SAME` twice. The
first `SAME` says the container runs the image `.env` names. The second says that
image is the release the checkout is on: `release.yml` labels every image with the
version it was built for, and the checkout's tag is read as `<operator>`. Anything
else is a failed deploy: roll back (section 9) and look at the logs afterwards.
The one expected exception is `makrai-nextjs:rollback`, which the host built and
which carries no version label: after a rollback to it the second line prints
`DIFFERENT`, and that is correct.

---

## 9. Rollback Procedure

Rolling back is a deploy of the previous release. It needs no new release and no
build: the previous images are in the registry and, until someone prunes them, on
this host. Do not run `docker image prune` until the release after has passed its
post-check. The rules in section 8 apply, and so do `$C` and `set_env`.

### 9.1 Find the release to return to

The PREV lines recorded in 8.2 are the answer. If they are lost, the previous
release's body has the same two references:

```bash
gh release list -R <owner>/<repo> --limit 5
gh release view vA.B.C -R <owner>/<repo> --json body --jq .body
```

### 9.2 Roll the app back

```bash
# The checkout goes back to PREV's tag, as <operator>.
sudo -u <operator> git -C /srv/makrai/app checkout --detach vA.B.C

# .env goes back to PREV's references.
set_env WEB_IMAGE 'ghcr.io/<owner>/makrai-web@sha256:<64 hex>'
set_env MIGRATOR_IMAGE 'ghcr.io/<owner>/makrai-migrator@sha256:<64 hex>'

# Only if the web image is no longer on this host. Never for makrai-nextjs:rollback,
# which is local and in no registry.
$C pull nextjs

$C up -d --no-deps --wait --wait-timeout 120 nextjs

# Did the release you are leaving change another service? Compare the two tags'
# docker/ directories, then the compose file itself, which shows which service block
# changed. vX.Y.Z is the release you are rolling back from.
sudo -u <operator> git -C /srv/makrai/app diff --stat vA.B.C vX.Y.Z -- docker/
sudo -u <operator> git -C /srv/makrai/app diff vA.B.C vX.Y.Z -- docker/docker-compose.prod.yml

# For each service whose definition differs there, other than nginx (a postgres on
# another digest, say; 8.3 step 6 recreated it), recreate it from the checkout you
# are on.
$C up -d --no-deps <service>

# nginx, if its image digest or docker/nginx/default.conf differs: the tested steps of
# 8.3 step 7, now with the old image and the old file.
# The image digest differs: the recreate picks up the old file too.
docker run --rm --network docker_default \
  -v /srv/makrai/app/docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/ssl/makrai:/etc/ssl/makrai:ro \
  "$($C config --images | grep '^nginx:')" nginx -t \
  && $C up -d --no-deps nginx
# Only the file differs: restart.
docker run --rm --network docker_default \
  -v /srv/makrai/app/docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /etc/ssl/makrai:/etc/ssl/makrai:ro \
  "$($C config --images | grep '^nginx:')" nginx -t \
  && docker restart docker-nginx-1
```

**The first release has no earlier release to return to.** Do not check out the
earlier commit: its compose file builds on the host and ignores `WEB_IMAGE`. Leave
the checkout on the release tag, set `WEB_IMAGE=makrai-nextjs:rollback` (the image
8.3 step 0 named), and run only the `$C up -d --no-deps --wait --wait-timeout 120 nextjs`
line; the rest of the block does not apply, because the checkout has not moved.
`MIGRATOR_IMAGE` still needs a value, because Compose reads the whole file: leave it on
the release's migrator, which an app rollback does not run.

### 9.3 Roll back the database (if migrations were applied)

Only when the release's migrations must be undone, and it is destructive: the restore
replaces the database with a copy from the past, and **every write since that copy was
taken is lost for good**. Do 9.2 first, so that the checkout and `.env` are PREV's.

1. Take a fresh backup of the current state, as [backup-restore.md](./backup-restore.md)
   section 4 opens by saying, so that the restore can itself be undone:

   ```bash
   sudo -u <operator> /usr/local/bin/makrai-backup.sh
   ```

2. Restore **BACKUP**, the file 8.2 wrote down: the backup taken before the migrator
   ran. Not simply the newest. The 00:00 backup after the migration, and the fresh one
   from step 1, already contain it, and restoring either undoes nothing.
3. **Before** backup-restore.md section 4.4, which runs the migrator, point
   `MIGRATOR_IMAGE` at the previous release's migrator. For the first release that is
   the image the host built, `makrai-migrator:rollback` (8.3 step 0):

   ```bash
   set_env MIGRATOR_IMAGE 'ghcr.io/<owner>/makrai-migrator@sha256:<64 hex>'   # or makrai-migrator:rollback
   $C pull migrator                                                            # not for makrai-migrator:rollback
   ```

4. Follow backup-restore.md section 4 in order, naming BACKUP in 4.3. Its 4.4 then
   runs PREV's migrator against the restored database.

Migrations in this project are additive unless their pull request says otherwise, so
the previous release's code normally runs against the newer schema, and 9.2 alone is
the rollback.

### 9.4 Verify

Run the post-check in 8.4. `SAME` now means the container runs the image PREV named.
After a rollback to `makrai-nextjs:rollback` the second line prints `DIFFERENT`, as 8.4
says it should.

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

Run from `/srv/makrai/app/docker`, with `$C` set as in section 8:
`C="docker compose --env-file ../.env -f docker-compose.prod.yml"`.

| Task                   | Command                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| Start all services     | `$C up -d`                                                                    |
| Stop all services      | `$C down`                                                                     |
| Deploy a release       | Section 8. The host does not build: `up -d --build` has nothing to build.     |
| View logs              | `$C logs -f`                                                                  |
| Run migrations         | `$C --profile tools run --rm --no-deps migrator`                              |
| Seed admin             | `$C --profile tools run --rm --no-deps migrator npx prisma db seed`           |
| Check container status | `$C ps`                                                                       |
| Check SSL expiry       | `openssl x509 -in /etc/ssl/makrai/fullchain.pem -noout -dates` (Origin CA, no renewal) |
| Check SSL expiry       | `echo \| openssl s_client -connect makrai.org:443 2>/dev/null \| openssl x509 -noout -dates` |

---

## 12. Operator access

Every SSH login is root's and needs two factors: the operator key, which has a passphrase and is
never loaded into `ssh-agent`, and a TOTP code from the authenticator app on the owner's phone
(ADR-0010; OD I.5). Neither opens a session alone. Two tracked files set this:
`ops/host/50-makrai-sshd.conf`, installed as `/etc/ssh/sshd_config.d/50-makrai-sshd.conf`, and
`ops/host/pam.d-sshd`, installed as `/etc/pam.d/sshd`.

- `AuthenticationMethods publickey,keyboard-interactive:pam`: the key first, then the code. The
  code is asked for only after the key has been accepted.
- The PAM auth stack asks for the code and nothing else. It has no password module, so root's
  password is never accepted over SSH, and no `nullok`, so a missing secret file refuses the login.
- `PermitRootLogin yes`, because `prohibit-password` also turns off keyboard-interactive for root
  and would lock it out of the code stage.
- sshd reads only `.ssh/authorized_keys`. The `<operator>` account has no key there, no sudo
  rule, and is not in the sudo group.

A host set up with the earlier version of this runbook put the operator in the sudo group. The
access change takes it out, and the check is that `id -nG <operator>` lists no `sudo`:

```bash
gpasswd -d <operator> sudo
id -nG <operator>
```

Every step below that asks for the key's passphrase or a code, or shows a QR code, runs in a
terminal outside the Claude app, never in its Terminal panel, which AI sessions can read. The
root password and the TOTP secret are never typed, displayed or generated in an AI session. The
Hetzner Console is a page in a browser, so it is opened only in a browser no AI tool can read:
never the Claude app's Browser pane, and never with an AI browser extension active. Close the
console tab when you are done.

### 12.1 The operator key, and the owner's own sessions

The operator key is never loaded into an SSH agent (OD I.5 (C)), and on an Ubuntu desktop that
takes one more step. GNOME Keyring's SSH agent (gnome-keyring 46.1, the default there) lists
every `~/.ssh/*.pub` key in its agent. The first time anything asks the agent to sign with a
passphrase-protected key, a desktop passphrase prompt appears. A passphrase entered there leaves
the key decrypted in the agent for the rest of the login session. So:

- Keep the key's public file outside `~/.ssh`, for example as `~/makrai-keys/makrai_operator.pub`.
  `ssh-keygen` writes it beside the private key, so move it once the key exists:

  ```bash
  mkdir -p ~/makrai-keys && mv ~/.ssh/makrai_operator.pub ~/makrai-keys/
  ```

  `ssh -i ~/.ssh/makrai_operator` and `ssh-keygen -lf ~/.ssh/makrai_operator` still work, because
  a new-format key carries its public half inside the private file.
- Type the passphrase only at an ssh prompt in a terminal, never into a desktop pop-up.
- Check that no agent holds the key. `ssh-keygen -lf ~/.ssh/makrai_operator` prints the
  fingerprint to put in place of the placeholder:

  ```bash
  ssh-add -l | grep -c '<operator fingerprint>'
  ```

  Expected: `0`. If it prints `1`, move the `.pub` file out of `~/.ssh` as above, then ask the
  keyring's agent directly. If it still lists the key, the key was decrypted into the agent:
  remove it with the second line, or log out of the desktop session.

  ```bash
  SSH_AUTH_SOCK=/run/user/$(id -u)/keyring/.ssh ssh-add -l
  SSH_AUTH_SOCK=/run/user/$(id -u)/keyring/.ssh ssh-add -d ~/.ssh/makrai_operator
  ```

  If the passphrase was typed into the keyring pop-up and its "Automatically unlock this key
  whenever I'm logged in" box was ticked, the passphrase is also saved in the login keyring,
  where neither command reaches it. Open Passwords and Keys (Seahorse), go to Login, delete the
  "Unlock password for: …makrai_operator" item, then log out of the desktop session.

The owner's own sessions:

```bash
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server>
```

It asks for the key's passphrase, then `Verification code:`. `~/.ssh/config` has no entry for
this host.

### 12.2 Approval windows

An AI agent reaches the server only through a connection the owner opened, for as long as the
owner's timer allows. The owner opens one window per approved task, in a terminal outside the
Claude app, and states its end time in UTC:

```bash
timeout --foreground <N>m ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none -o AddKeysToAgent=no -o ControlMaster=yes -o ControlPath=~/.ssh/makrai-window.sock -o ControlPersist=no -o ServerAliveInterval=30 -N root@<server>
```

It asks for the passphrase, then the code. The window lasts while that command runs: the timer
or Ctrl-C ends it, and every agent command riding on it ends too. `ControlPersist` with a time is
never the limit, because ssh_config(5) defines it as an idle timeout and a busy agent would keep
the window open past it. The socket path stays short: Unix sockets are limited to 108 bytes.

The agent's `$SSH` rides that connection and never authenticates on its own:

```bash
SSH="ssh -S $HOME/.ssh/makrai-window.sock -o ControlMaster=no -o BatchMode=yes -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=no -o PasswordAuthentication=no -o GSSAPIAuthentication=no -o HostbasedAuthentication=no -o ConnectTimeout=10 root@<server>"
```

It fails closed. With no socket, a `ControlMaster=no` client falls back to a normal connection
(ssh_config(5)), and with every method disabled on the client that connection is refused:
`Permission denied`, exit status 255.

- **Before each step** the agent runs `ssh -S $HOME/.ssh/makrai-window.sock -O check root@<server>`,
  which must print `Master running`. If it does not, the agent stops and asks for a window, and
  never reaches the server another way.
- The agent starts no step it cannot finish before the stated end.
- **Before the window closes** the agent re-runs the access baseline below and compares the
  output with the recorded baseline. Any difference stops the task and goes to the owner.
- While a window is open the agent holds root. The comparison catches a change to what it
  covers, not other persistence, such as a cron job or a systemd unit (ADR-0010).

The window is opened with `-N`, so it has no shell: the agent sends one command per `$SSH` call.
It sends the baseline as one script to `bash -s` on standard input, byte for byte, with the
locale fixed so that globs and `sort -u` order their output the same way every time. The step
that records the baseline and P-APPROVE's window-close check use this same form:

```bash
$SSH 'bash -s' <<'EOF'
export LC_ALL=C
sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods|authorizedkeysfile|usepam) '
grep -lE '^\s*Match\b' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf
sha256sum /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf /etc/pam.d/sshd /etc/pam.d/login /etc/pam.d/common-auth /etc/pam.d/common-account /etc/pam.d/common-session /etc/pam.d/common-password /etc/pam.d/sudo /etc/pam.d/su /etc/sudoers /etc/sudoers.d/* /etc/makrai/allowed-keys.fp
for d in $(getent passwd | cut -d: -f6 | sort -u); do for f in "$d"/.ssh/authorized_keys "$d"/.ssh/authorized_keys2; do [ -f "$f" ] && ssh-keygen -lf "$f" | awk -v f="$f" '{print f, $2}'; done; done
getent group sudo admin wheel docker
getent passwd | awk -F: -v g="$(getent group sudo admin wheel docker | cut -d: -f3 | paste -sd'|')" '$4 ~ "^("g")$" {print $1, $4}'
stat -c '%a %U %n' /root/.google_authenticator
EOF
```

It covers:
- the effective authentication settings, and any `Match` block;
- the hashes of the sshd configuration and its drop-ins; of the `sshd`, `login`, `sudo` and `su`
  PAM files; of `common-auth`, `common-account`, `common-session` and `common-password`; of
  `/etc/sudoers` and every file in `/etc/sudoers.d`; and of the allowed-keys list;
- the fingerprint of every authorized key;
- the supplementary members of the `sudo`, `admin`, `wheel` and `docker` groups (the
  `getent group` line), and every account whose primary group is one of them (the line after it);
- the secret file's mode and owner. Its content changes at every login, because each code is
  recorded as used (`DISALLOW_REUSE`), so it is never hashed.

A package upgrade can change the hash of `/etc/ssh/sshd_config` or a `common-*` file. That
difference also goes to the owner.

### 12.3 Re-enrolling the TOTP code

Re-enrol after moving to a new phone, or if the secret may have been seen. Over SSH, open a
session as in 12.1 and run as root:

```bash
google-authenticator -t -d -f -r 3 -R 30 -w 3 -e 0 -Q UTF8 -l makrai-root -i makrai -s /root/.google_authenticator
```

At the Hetzner Console (12.5), when SSH is unavailable, draw the QR code with `-Q ANSI` instead:

```bash
google-authenticator -t -d -f -r 3 -R 30 -w 3 -e 0 -Q ANSI -l makrai-root -i makrai -s /root/.google_authenticator
```

If the console draws no usable QR code, run it with `-Q NONE` and type the secret key it prints
into the authenticator app by hand:

```bash
google-authenticator -t -d -f -r 3 -R 30 -w 3 -e 0 -Q NONE -l makrai-root -i makrai -s /root/.google_authenticator
```

Scan the QR code with the authenticator app, or enter the key. If the tool asks
`Enter code from app (-1 to skip):`, enter the code the app shows; never `-1`. Only the QR form
differs between the three; what the other flags set:

- `-t`: codes are time-based. `-d`: each code works once.
- `-r 3 -R 30`: at most 3 attempts per 30 seconds. `-w 3`: the previous, current and next code
  are accepted.
- `-e 0`: no emergency codes. Recovery is the Hetzner Console, so the phone stays a real second
  factor.
- `-f`: the file is written without asking. That replaces the old secret, so codes from the old
  app entry stop working.

Keep the session you re-enrolled in open until a new login as in 12.1, with a code from the new
entry, succeeds. The check prints only counts, so the agent can run it in a window:

```bash
$SSH 'stat -c "%a %U" /root/.google_authenticator; grep -cE "^[0-9]{8}$" /root/.google_authenticator; grep -cxE "\" (TOTP_AUTH|DISALLOW_REUSE)" /root/.google_authenticator'
```

Expected: `400 root`, then `0` (no emergency codes), then `2`.

### 12.4 A lost phone

If the lost phone also held the Hetzner account's two-factor authentication, first recover the
Hetzner account with its 2FA recovery material (the key-inventory row "Hetzner account 2FA
recovery"). The console sits behind that account.

The key alone opens nothing, so a lost phone closes SSH until the code is re-enrolled. Whoever
finds the phone gains nothing without the key and its passphrase. Re-enrol at the Hetzner
Console (12.5) with the console form of the command in 12.3, setting up the new entry on the
replacement phone. The new secret replaces the old one, so the lost phone's codes stop working.
There are no emergency codes to fall back on, by design.

This is a console login that is not a drill. Afterwards the owner rotates root's console
password, confirms that the break-glass notice arrived, and records the event, as set out at the
end of 12.5.

### 12.5 Recovery through the Hetzner Console

The Hetzner Console is the way back when SSH is unavailable: after a lost phone, or a change to
sshd or its PAM stack that refuses every login. Open the Hetzner Cloud Console (the web
interface, behind the Hetzner account's two-factor authentication) only in a browser no AI tool
can read: never the Claude app's Browser pane, and never with an AI browser extension active. A
re-enrolment shows the QR code and the secret on that page. Open the server's console and log in
as root with the password from the password manager. The console goes through
`/etc/pam.d/login`, never sshd, so it needs neither the key nor a code. Every console login is
recorded and announced (ADR-0010). Close the console tab when you are done.

From the console:

- **A lost phone:** re-enrol with the console form in 12.3.
- **A missing `/root/.google_authenticator`:** without `nullok` it refuses every login.
  Re-enrol with the console form in 12.3.
- **sshd or PAM refuses every login:** check the secret file, the clock and the module's log
  lines, then compare the live files with the tracked copies in the server checkout, and check
  the settings sshd is using:

  ```bash
  stat -c '%a %U' /root/.google_authenticator
  timedatectl show -p NTPSynchronized
  journalctl -u ssh --since -15min | grep -i google_authenticator
  cmp /srv/makrai/app/ops/host/pam.d-sshd /etc/pam.d/sshd
  cmp /srv/makrai/app/ops/host/50-makrai-sshd.conf /etc/ssh/sshd_config.d/50-makrai-sshd.conf
  sshd -t
  sshd -T | grep -E '^(permitrootlogin|passwordauthentication|kbdinteractiveauthentication|authenticationmethods|authorizedkeysfile) '
  ```

  Expected:
  - `400 root`;
  - `NTPSynchronized=yes`, since every code depends on the clock;
  - the journal lines show any error the module logged in the last 15 minutes;
  - `sshd -t` prints nothing when the configuration is valid;
  - the last command prints `permitrootlogin yes`, `passwordauthentication no`,
    `kbdinteractiveauthentication yes`, `authenticationmethods publickey,keyboard-interactive:pam`
    and `authorizedkeysfile .ssh/authorized_keys`.

  To reinstall the tracked files, follow the rule for every install from the checkout into a
  root-owned path ([`ops/host/README.md`](../../ops/host/README.md), "Installing from the
  checkout"). The server checkout is owned by, and writable by, the operator account. So each
  file is first copied into a directory only root can write. That copy is compared with the
  reviewed, merged commit, and that copy is installed. A file swapped in the checkout after the
  copy is never the one installed. First compute the two sha256 values on the workstation, from
  that commit:

  ```bash
  git show <commit>:ops/host/pam.d-sshd | sha256sum
  git show <commit>:ops/host/50-makrai-sshd.conf | sha256sum
  ```

  Then run one chain at the console, with those two values in place of the placeholders. Each
  step runs only if the one before it succeeded, so a missing file, a hash that differs or a
  malformed one installs nothing and reloads nothing. `--strict` is what makes a malformed value,
  such as a placeholder left in or a hash typed one character short, a failure: without it,
  sha256sum skips that line with a warning and exits 0, and the file goes in unchecked.

  ```bash
  test -f /srv/makrai/app/ops/host/pam.d-sshd && test -f /srv/makrai/app/ops/host/50-makrai-sshd.conf \
    && install -d -m 0700 /root/makrai-stage \
    && install -m 0600 /srv/makrai/app/ops/host/pam.d-sshd /root/makrai-stage/pam.d-sshd \
    && install -m 0600 /srv/makrai/app/ops/host/50-makrai-sshd.conf /root/makrai-stage/50-makrai-sshd.conf \
    && printf '%s  %s\n' '<pam.d-sshd sha256>' /root/makrai-stage/pam.d-sshd '<50-makrai-sshd.conf sha256>' /root/makrai-stage/50-makrai-sshd.conf | sha256sum -c --strict \
    && install -m 0644 /root/makrai-stage/pam.d-sshd /etc/pam.d/sshd \
    && install -m 0644 /root/makrai-stage/50-makrai-sshd.conf /etc/ssh/sshd_config.d/50-makrai-sshd.conf \
    && sshd -t && systemctl reload ssh
  ```

After any console login that is not a drill, a lost-phone recovery included, the owner:

1. rotates root's console password. The owner generates the new one in the password manager,
   letters and digits only (ADR-0010), sets it with `passwd` at the console, and keeps it
   nowhere else;
2. confirms that the break-glass notice email arrived;
3. records the event, and the reason for it, in `records/EXECUTION-LOG.md`.
