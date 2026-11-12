# Deployment Runbook

> **NOT YET EXECUTED.** The domain is `makrai.org` (confirmed 2026-08-18), but
> nothing is configured: no server, no DNS, no TLS. This runbook has never been
> run end to end, and the 2026-08-17 audit found the procedure as written cannot
> produce a working deployment — it starts after the server already exists and
> omits roughly nine provisioning steps. Expect to correct it while performing
> the first real deployment, not before.

> RAI Toolkit Platform — `makrai.org`
> Last updated: 2026-10-31

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
  take one session of the owner's own (12.1) after the release that carries them is deployed
  (section 8).
- **The check.** A pass sends one success ping, and a failure sends `/fail`, to the healthchecks
  check `makrai-synthetic` (Cron `7 * * * *`, UTC, grace 30 minutes), whose URL is
  `HC_SYNTHETIC_PING_URL` in the server `.env`. The host is its only sender:
  `.github/workflows/synthetic.yml` is manual-only and never pings (`gh workflow run
  synthetic.yml` runs the journey once from a GitHub runner, to tell a host fault from a fault in
  the world). Silence (the host, cron or Docker dead) is reported when a :07 slot goes 30 minutes
  without its ping. The owner's steps that finish the move right after the manual-only workflow has
  merged (delete the old check and the GitHub secret, rename `makrai-synthetic-host`, switch it to
  Cron, check that GitHub has stopped scheduling the workflow) are in the README, "Hourly
  synthetic journey (Task 20b)", under "The check". If the hourly run is ever given back to GitHub (the README's rollback), whatever
  the state of the owner's steps, the GitHub secret is set before the revert merges, to the URL of
  a new check, `makrai-synthetic-gh` (Simple, period 1 day, grace 36 h, email on), never this one:
  GitHub's schedule is hours late or does not fire, so it cannot meet an hourly check.
- **The log.** `/var/log/makrai/synthetic.log`, mode 600. A run prints a `run at=` line, one
  `step=<name> status=<code>` line per step, and `result=pass|fail at=<UTC time>` last: 7 lines when
  the first attempt passes (8 with a `waiting for the lock` line), so `tail -n 8` shows it whole. A
  retried run adds an `attempt=2 at=` line and the second attempt's steps, up to 14 lines in all, so
  `tail -n 14` covers it. A fault that clears on the retry is on record there even though nothing
  alerted.
- **Deploys.** A failed first attempt is tried once more after 60 seconds, so a swap at 7 past in
  D2 step 5 is absorbed by the retry: the old container is replaced, the first attempt fails, the
  second passes against the new one, and healthchecks hears one success ping. A swap that takes
  longer than that sends `/fail` once, and the next hour's ping clears it. Do not run the script
  by hand between :05 and :12; a hand run that does overlap makes the cron run wait for it (up to
  500 seconds), and stopping a run that is waiting removes nothing.
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
session (section 12.1), in a terminal outside the Claude app. No agent reaches the
server (12.2).

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

# Removes the line KEY=... from .env, in the same way: keeps the file's mode and owner,
# opens no editor, touches no other line. Prints nothing, so it cannot show a value.
unset_env() { local k="$1" f=/srv/makrai/app/.env
  ( umask 077; awk -v k="$k" 'index($0,k"=")!=1' "$f" >"$f.new" ) \
  && cat "$f.new" >"$f" && rm -f "$f.new"; }

# The owner role (`makrai`), read from .env into a variable. Never echoed. 8.5 step 2,
# 8.6 step 5, 9.3 step 5, 9.5, 9.5a and 12.6 use it to run SQL as the owner.
PGU=$(sed -n 's/^POSTGRES_USER=//p' ../.env)
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

**After the tag, before the deploy: the image scan.** Start it from the owner's own machine and
wait for the run:

```bash
gh workflow run image-scan.yml -R <owner>/<repo> -f scanners=vuln,secret
```

It scans the two release images and the postgres and nginx images the compose file pins. It fails
when an image has a CRITICAL advisory that has a fix, or a CRITICAL-rated secret, or could not be
scanned (`.github/workflows/image-scan.yml`: `--severity CRITICAL --ignore-unfixed --exit-code 1`).
A failed run stops the deploy until the owner has read which image and which advisory
(`gh run view <run id> -R <owner>/<repo> --log-failed`) and has decided: move the pin or the
dependency in a new release, or deploy with the finding. The decision and its reason go in the
register. For v0.6.1 the run failed on the nginx image and the owner chose a new release, v0.6.2.
A green run says nothing about advisories below CRITICAL or without a fix. Run it before anything
else is merged to `main`: started this way it reads the compose file's pins from `main`, not from
the tag, and the two release images from the latest release. The same scan also runs every day on
`main`; while a finding stays, that daily run fails and its dead-man check alerts.

**Before the v0.6.1 tag.** No v0.6.1 tag before the pull request that publishes version 2 of the
legal texts is merged. CI does not run the release-candidate cases (`.github/workflows/ci.yml:241`
runs `npx vitest run` without `RELEASE_CANDIDATE`), and `.github/workflows/release.yml` runs no
tests on a tag. So the tag gate is the unit run. Whoever prepares the release may run it, on a
checkout of the commit to be tagged; the owner tags (8.1 step 2). Run it with the test database
up, migrated and provisioned (`CONTRIBUTING.md:11-23`)
and `pdftotext` installed (CI's unit job installs `poppler-utils`, `.github/workflows/ci.yml:224`),
and see it pass first:

```bash
RELEASE_CANDIDATE=1 npx vitest run
```

If any test fails, do not tag. A failing release-candidate case names something the release still
lacks. Clear it by supplying what is missing or, where the owner accepts shipping without it, by a
waiver entry the owner records for this release in `docs/releases/release-waivers.json`. A waiver
recorded for an earlier release waives nothing: a waiver counts only when its `release` equals
`package.json`'s version (`__tests__/helpers/releaseWaivers.ts:76`).

For v0.6.1, one case passes on a waiver: the screen-reader walk (NFR-A11Y-07,
`__tests__/lint/screen-reader-walk.test.ts:114-118`; the walk sheet
`docs/accessibility/screen-reader-walk-v0.6.0.md` says "not yet walked"). The owner deferred the
walk for v0.6.1 (register D-301), and the file holds that entry for 0.6.1, with the owner's words.
It is the only entry for 0.6.1: the three entries for 0.6.0 waive nothing in this release.

**v0.6.2.** v0.6.1 was tagged on 12 November 2026 and was not deployed: the image scan run after
its tag failed on the pinned nginx image, which holds a library with a CRITICAL advisory (register
D-339). v0.6.2 is v0.6.1 with the nginx pin moved to an image that holds the fixed library; nothing
in the application changed. The release it replaces on the host is still v0.6.0, so 8.3 steps 6
and 7a move postgres and nginx from v0.6.0's digests. Read 8.6, 9.4, 9.5a and 9.6 with v0.6.2 in
place of v0.6.1: they apply to it unchanged. v0.6.1 is never a deploy or a rollback target. A
rollback of v0.6.2 returns to v0.6.0 (9.1), whose nginx image holds the same unfixed library
(D-339), and a return deploy after 9.6's emergency stop is to v0.6.2 or later. The tag gate is the
same command. The walk is deferred again, by a waiver entry for 0.6.2 with the owner's words
(register D-301); the entries for 0.6.0 and 0.6.1 waive nothing in it.

Some end-to-end cases also read `RELEASE_CANDIDATE` (`e2e/claims-crawl.spec.ts:53,719`). No job
runs them and no command for them has been rehearsed, so they are not part of the gate yet
(register D-308).

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

A release that carries a content version (9.6 describes one) has one more effect between
steps 4 and 5. The migrator marks the earlier content version as no longer published, and
the app still serving was built for that version, so from the moment step 4 ends until the
swap in step 5 it refuses three actions: saving a decision, withdrawing a decision and
sealing a review. A person who presses Save sees "Not saved: the server had a problem. Your
answer is kept on this device. Retry." Some pages also fail with a 503 in that interval. The
project page, the review page, the review's documents page and the seal page fail for a
project that has a sealed review, and a stage page fails when that stage has one. The seal
page also fails, for a person who can seal, in any project that is not archived. A single
question's page and a question's history still open. Run step 5 straight after step 4, so
that the interval is short.

Each refusal in that interval also writes an error line to the app's log. A refused save,
withdrawal or seal writes one line that holds `"code":"content_not_published"`
(`lib/http/toResponse.ts`, `lib/http/supportReference.ts`); a page that fails writes lines of
its own. The old and the new container write under the same log name, and the post-check (8.4)
counts the error lines of the last 10 minutes, so after such a release its third line prints
more than `0` when someone saved, withdrew or sealed, or opened one of those pages, in the
interval. That alone is not a failed deploy: 8.4 says how to tell the two apart.

If step 3 fails (an expired credential, a mistyped digest), the running stack has not
changed. Fix the cause and repeat step 3, or put the checkout and `.env` back to PREV
with the first three commands of 9.2: the `checkout --detach`, `set_env WEB_IMAGE` and
`set_env MIGRATOR_IMAGE`. Do not leave `.env` pointing at images the host has not
pulled.

### 8.4 Post-check

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://makrai.org/login
$C ps
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since -10min -p err -o cat | grep -vE '^[{]"timestamp":"[^"]*","level":"warn","event":"[A-Z_]+",' | wc -l
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

The third line counts the app's error lines and leaves out its audit warnings. Docker's
journald driver records every line a container writes to its error stream at priority `err`
(`daemon/logger/journald/journald.go` in Docker's source; read there, not observed on the host), and
the app writes its audit warnings to that stream with `console.warn` (`lib/security-logger.ts:94-95`):
one line each, beginning `{"timestamp":"…","level":"warn","event":"…",`. Inviting a member or an
administrator's correction writes one; so do a failed or locked sign-in, a rate limit and a
refused password change, which anyone on the internet can cause. So this count does not show
whether signing in works. Signing in does: yours, as 8.6 step 4 has you do for v0.6.1, or the
next hourly synthetic journey. The `grep` drops those lines,
only where the line starts with that form, and counts every other line, so an audit line at
level `error` still counts, and so does a warning the app writes as plain text. A failing page
writes several lines: a first line beginning `⨯`, then its stack and fields.

Lines that show `[auth][error]`, `[auth][cause]` or `[auth][details]` (in red in the
count's output: each starts with a colour code there, so a search for a line beginning `[auth]`
may find nothing), with stack lines between
them, are written by the sign-in library when a browser sends a session cookie the app cannot
read. They count. A few from one request are a stale or made-up cookie, not a failed deploy; one
for every signed-in person means the app cannot read any session, and is. Their form is read from
the library's logger (`node_modules/@auth/core/lib/utils/logger.js`); they were not seen from the
running app in the rehearsal.

A second expected exception, only for a release that carries a content version (8.3): the
third line may print more than `0`. Do not roll back on that count alone. Print the error
lines with their times, and the time the new container started with its restart count, all
in UTC:

```bash
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since -10min -p err -o short-iso-precise --utc | grep -vE '^[^]]*\]: [{]"timestamp":"[^"]*","level":"warn","event":"[A-Z_]+",'
docker inspect -f '{{.State.StartedAt}} restarts={{.RestartCount}}' docker-nextjs-1
```

The second line must end in `restarts=0`; any other count is a failed deploy, as above. A
line stamped before the start time that holds `"code":"content_not_published"` was written by
the old app while it refused in the interval between 8.3 steps 4 and 5, and is expected. Any
other line stamped before the start time was also written by the old app (a failing page in
that interval, or something from before step 4): read it before you decide, and do not count
it as expected if it holds another `"code"`. A line stamped at or after the start time was
written by the new app: that is a failed deploy, as above, except for the few sign-in library
lines described above. The first line leaves out the audit warnings, as the count does, so an
invitation or an administrator's action in those ten minutes does not show here; it finds them
right after the journal's own prefix, which ends at the first `]: ` of the line. The two commands were run on a workstation to check that their times can be
compared; they have not been run on the host after a content release. The `grep` was run on the
app's error lines captured with `docker logs` in the local rehearsal of 12 November 2026, not
read from a journal: it kept the old app's one `content_not_published` line, dropped the new
app's three audit warnings, and kept an error line and a failing page's lines added by hand.

### 8.5 v0.6.0: the owner's steps

v0.6.0 is deployed. For v0.6.1, follow 8.6.

Every step here is the owner's, in the owner's own session (12.1), in a terminal outside any AI
session. No output of the host is pasted into an AI session (NFR-SEC-17). Run the "Set these once
per session" block of section 8 first: this section uses `$C`, `$PGU` and `unset_env` from it.

These are the steps of the v0.6.0 release, in order, with their commands. Where a step says to run
8.2, 8.3 or 8.4, it means that section as written, with the differences the step names. Each
"estimate" is the plan's judgment of the minutes; V-prog replaces it with the timing of the
rehearsal on a local copy with the release images. Steps 5 to 13 come to about 2 hours 40 minutes
of the 3-hour window, 18:00 to 21:00.

**Before the deploy day (by Saturday)**

**Step 1.** Verify the Resend sending domain `makrai.org` in the Resend dashboard (A-4, K-8). It
must show as verified. Until it does, invitations and reminders reach only the address that owns
the API key (see the note beside `EMAIL_FROM_ADDRESS` in section 4); the in-app lists and the copy
link keep working. No command.

**Step 2.** Take the read-only counts that decide whether the deploy goes ahead: the real
projects, assessments and evidence outside the synthetic organisation (A-6), and the accounts that
hold the platform role admin (the first migration of step 7 stops when there is more than one).
They read numbers and no row; run them from `/srv/makrai/app/docker`:

```bash
SLUG=$(sed -n 's/^SYNTHETIC_ORG_SLUG=//p' ../.env)
$C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 -v "slug=$SLUG" <<'SQL'
select (select count(*) from projects p join organizations o on o.id = p."orgId" where o.slug <> :'slug'),
       (select count(*) from assessments a join organizations o on o.id = a."orgId" where o.slug <> :'slug'),
       (select count(*) from evidence e join organizations o on o.id = e."orgId" where o.slug <> :'slug');
select count(*) from users where role = 'admin';
SQL
```

Expect two lines: `0|0|0` (projects, assessments and evidence, in that order), then `1` (the one
platform administrator). Anything else is a stop, as a count above zero is: an error message, no
output, or a different number. If `.env` holds no `SYNTHETIC_ORG_SLUG`, the first count covers
every organisation, so a non-zero result stops the deploy whatever the cause. A count above zero
stops the deploy and comes back to the owner as a decision: no export command is built, and v0.5.0
ratings are not converted into decisions (SRS 11.3). More than one administrator is corrected on
v0.5.0 before the deploy day: step 7 names the correction, and the rehearsal confirms the screen.
The same two counts are the pre-check for the owner check of step 7. The owner runs the count outside any AI session and tells the release team only
their own decision, "I proceed with the deploy" or "I stop", never a number or whether it is zero;
the numbers, and anything about the rows, stay out of any AI session (NFR-PRIV-05).

**Step 3.** Confirm the legal text files to be published (A-1): one file per kind and version,
each with its header (SRS 6.7). Each must hold the wording legal supplied, say version 1, and say
whether acceptance is required. No command.

**Step 4.** Check the Cloudflare zone for rate-limiting or bot rules on `/api/auth` (NFR-SEC-06),
in the Cloudflare dashboard. v0.6.0 limits sign-in per account only, and removes the per-address
limit at nginx and in the application (ADR-0019); a Cloudflare rule per address would bring it
back at the edge. Write down every rule whose expression covers `/api/auth`. What to do with such a
rule is the owner's decision.

Every new secret and outside-account action also comes before the deploy day:

**Step 4a.** Create the healthchecks check for the reminder job (NFR-OBS-02), in the monitoring
service, in your own browser: name `makrai-reminders`, schedule Cron `20 * * * *`, time zone UTC,
grace time 2 hours, so that a run that does not happen for 3 hours alerts. Keep its ping address
(`https://hc-ping.com/` and 36 characters) in the password manager: it is a secret, it goes into
the server `.env` in step 8 at a hidden prompt, and it is never pasted into an AI session. The
cron line that pings it is installed in step 12.

**Step 4b.** Generate the reminder-job token on the host and put it in the server `.env`, never in
an AI session (ADR-0014, NFR-SEC-14). The token is made and appended in one command, so it is never
displayed, typed or pasted, and the check counts the line without printing it. The first line adds
a newline to `.env` only if its last line lacks one, so that the token cannot be glued to it. The
second makes the token under `umask 077` in a subshell, so that the setting ends with the line and
does not change the files that later commands of the same session write:

```bash
[ "$(tail -c1 /srv/makrai/app/.env | wc -l)" = 1 ] || echo >> /srv/makrai/app/.env
( umask 077; printf 'REMINDER_JOB_TOKEN=%s\n' "$(openssl rand -hex 32)" >> /srv/makrai/app/.env )
grep -c '^REMINDER_JOB_TOKEN=[0-9a-f]\{64\}$' /srv/makrai/app/.env
```

The last line prints `1` and nothing else. Hex, as section 4 does for the identity lane's password,
and the reminder route accepts exactly 64 lowercase hex characters. Run these lines once. `2` means
they ran twice. `0` means no valid token line was written, most likely because `openssl` failed and
left a bare `REMINDER_JOB_TOKEN=` line. For either, run `unset_env REMINDER_JOB_TOKEN`, then the
lines again, and do not go on until the check prints `1`. A v0.5.0 container does not read this key,
so adding it early changes nothing that runs today.

**Step 4c.** Confirm auto-renew and the registrar lock on `makrai.org` at the registrar, and note
the renewal date. No command.

**Step 4d.** Name the monitored MAK-AI address that the Help and contact page gives (UX-03), and
tell the release team before the deploy day. It is a public address, not a secret.

**Deploy day (Monday 2 November, or Tuesday 3 November), by 14:00**

**Step 4f.** Estimate: 13:30 to 14:00, at the latest at the 17:00 cut-off. Once the candidate has
passed the full live run, and its CI run on `release/0.6.0` shows the `verify` job within 15 minutes
and the `test-e2e` job within 30 minutes (NFR-MNT-02; the release notes record the two times),
merge `release/0.6.0` into `main`. The candidate's `package.json` already says `0.6.0`; the release
workflow refuses a tag that differs (8.1). **Owner approval required:** then tag the merged commit
and push the tag from a clone on your own machine, which is 8.1 step 2 with `0.6.0`:

```bash
git fetch origin main
git tag v0.6.0 <merge commit>
git push origin v0.6.0
```

Watch the run, and read the two image references, as 8.1 steps 3 and 4 say. The run must succeed
before the evening window.

**Deploy-day evening, in the working window 18:00 to 21:00**

**Step 5.** Run the pre-check, 8.2, including the block for a release that adds a migration (this
one does): write down the PREV lines, check that the last restore test did not fail, take the
backup, and write down BACKUP. Estimate: about 10 minutes. Rehearsed on 6 Nov 2026 on a local copy, from the v0.5.0
images on a v0.5.0-shaped database (`scripts/live-run/v050-shape.sql`): the commands and the backup ran in under 1
minute of machine time; the estimate stays for reading and writing down.

**Step 6.** Pause the hourly synthetic journey, whose old steps fail against v0.6.0, without
editing the committed crontab: save root's crontab, comment out the 7-past line in the live one,
and check that exactly one line is commented. Estimate: about 2 minutes.

```bash
install -d -m 0700 /root/makrai-stage
test -s /root/makrai-stage/crontab.root.v060-pause || { crontab -l > /root/makrai-stage/crontab.root.v060-pause.tmp && mv /root/makrai-stage/crontab.root.v060-pause.tmp /root/makrai-stage/crontab.root.v060-pause; }
sed 's|^7 \* \* \* \* /usr/local/sbin/makrai-synthetic.sh|#v060-pause 7 * * * * /usr/local/sbin/makrai-synthetic.sh|' /root/makrai-stage/crontab.root.v060-pause > /root/makrai-stage/crontab.root.v060-paused
[ "$(grep -c '^#v060-pause ' /root/makrai-stage/crontab.root.v060-paused)" = 1 ] && crontab /root/makrai-stage/crontab.root.v060-paused
crontab -l | grep -c '^#v060-pause '
```

The last line prints `1`. If it prints anything else, root's crontab has not been changed by this
step (the paused copy is installed only when it holds exactly one commented line): find the cause
before going on. Then pause the `makrai-synthetic` check in the healthchecks dashboard, so that the
silence is not an alert. The saved copy is root's crontab exactly as it was. It is written through a
temporary file and only if it is absent or empty, so a failed `crontab -l` leaves no saved file, and
running step 6 again never saves the paused crontab over the original. Step 11 puts the original
back, and every restore line in this runbook runs only if the saved file is not empty.

**Step 7.** Apply the release, 8.3 steps 1 to 7 in order; step 0 only if 8.2 showed no image lines
in `.env`. This release adds migrations, so step 4 runs. Its first file stops before changing
anything if more than one account holds the platform role admin; otherwise it removes the platform
administrator's membership and archives the seeded organisation, or stops naming an organisation
that has a project (FR-ORG-04). Time the container swap (NFR-AVL-02) by running 8.3 step 5 as:

```bash
time $C up -d --no-deps --wait --wait-timeout 120 nextjs
```

Write down the `real` time. nginx's configuration changes in this release (NFR-SEC-06, NFR-SEC-13,
NFR-OBS-01), so step 7 applies: 7a if the nginx image digest changed, 7b if only the file did, each
after its own `nginx -t`. Estimate: about 25 minutes for the step. Rehearsed on 6 Nov 2026 on a local copy, from
the v0.5.0 images to the release's, through nginx with a probe of `/api/health` every second: the migrator applied the
15 migrations of v0.6.0, the owner check first (it removed the platform administrator's membership and archived the
seeded organisation), in 2 seconds; the timed swap printed `real 0m5.844s`, with one failed probe (a 502, 1 second)
while the container was replaced; 7b's nginx restart cost none; the step's commands took 9 seconds (NFR-AVL-02's 300
seconds).

If the migrator stops on the owner check, it ends with an error and nothing of v0.6.0 is applied.
The check has two messages, both beginning `v0.6.0 step 0:`. One names an organisation that has no
owner once the platform administrator's membership is removed, and has a project. The other says
`N accounts hold the platform role admin`. Prisma then records that migration as failed and refuses
later runs until it is resolved. Seen in the rehearsal of 6 Nov 2026, on a copy of the v0.5.0-shaped database with a
project in the seeded organisation: the first run stopped with `Error: P3018` and the organisation message, and no
`20261030` migration had finished; a second run refused with `Error: P3009`; once the organisation had an owner again
(simulated by archiving it in the copy), the `migrate resolve` line below printed `Migration
20261030000000_v060_00_owner_check marked as rolled back.` and the next run applied the 15 v0.6.0 migrations (37
recorded). Do not run 8.3 step 5:
the v0.5.0 app keeps serving, and the correction is made on v0.5.0, where nothing of v0.6.0 has run:

- For the organisation message, promote an existing member of that organisation, who is not the
  platform administrator, to owner on its members page. If it has no other member, stop the
  release: it is a real organisation, and what to do is the owner's decision under step 2
  (OD-15 (a)). The rehearsal confirms that the members page of v0.5.0 allows the promotion.
- For the administrator message, on the Admin > Users page of v0.5.0 (`/admin/users`), signed in as
  the administrator who keeps the role, set the role of all but one of those accounts to assessor,
  as the message says; the owner chooses which one keeps the role. The rehearsal confirms that this
  page allows it.

Never delete a project or edit rows by hand, for either message.

If the correction cannot be made in this window, go back first, in this order. Undo step 6; the
files are removed only after the restore has worked:

```bash
[ -s /root/makrai-stage/crontab.root.v060-pause ] && crontab /root/makrai-stage/crontab.root.v060-pause && rm -f /root/makrai-stage/crontab.root.v060-pause /root/makrai-stage/crontab.root.v060-paused
crontab -l | grep -c '^#v060-pause '
```

The last line must print `0`. The restore line does nothing, and prints nothing, when the saved
file is empty or missing, so anything else is a stop before you resume the check. When it prints
`0`, resume the `makrai-synthetic` check. Then put the checkout and `.env` back to PREV with the
first three commands of 9.2 (the `checkout --detach`, `set_env WEB_IMAGE` and
`set_env MIGRATOR_IMAGE`), as 8.3 says for a failed step 3, and run the post-check of 8.4: the line
that compares the running image with `.env` must print SAME. If it prints DIFFERENT, run the two
`set_env` lines of 9.2 again with the PREV references written down in 8.2 (the value without its
`WEB_IMAGE=` or `MIGRATOR_IMAGE=` prefix), and repeat the check. If it still prints DIFFERENT after
the second try, stop: v0.5.0 keeps serving, run 9.2 in full, and do not start step 5 again until the
cause is found; compare by eye `docker inspect -f '{{.Config.Image}}' docker-nextjs-1` with the
`WEB_IMAGE` line of `.env` (image references, not secrets). Do not leave the window until it prints
SAME or you have run 9.2 in full. Without that, the checkout and `.env` name v0.6.0 while
the v0.5.0 container serves, the next evening's 8.2 records v0.6.0 as PREV, and a later rollback
returns to v0.6.0. Start again at step 5 on a later evening. There, once the cause is corrected,
run the line below after 8.3 step 3 and before 8.3 step 4, because the failed row is still
recorded. Then run the backup lines of 8.2 again and write the new file down as BACKUP, still
before 8.3 step 4: the BACKUP taken at step 5 holds that failed `_prisma_migrations` row, and a 9.3
restore of it would stop on Prisma's refusal (P3009) of a history with a failed migration.

When the cause is corrected, record the migration as rolled back, inside the migrator image, which
carries the full `node_modules` (the `migrator` stage of `docker/Dockerfile`):

```bash
$C --profile tools run --rm --no-deps migrator npx prisma migrate resolve --rolled-back 20261030000000_v060_00_owner_check
```

Then run 8.3 step 4 again. The command names only this migration; never resolve another one.

A migrator error that is not the owner check is not covered by this recovery: earlier v0.6.0 files
may have been applied. Do not run 8.3 step 5. Never resolve a file other than the owner check. Run
the first three commands of 9.2, so that the checkout and `.env` are PREV's again (the container
never changed). Then do 9.3 with BACKUP, which also restores the migration history, so that no
failed row remains. Diagnose the cause on the rehearsal copy and fix it in a v0.6.x. The v0.5.0
writes since BACKUP are lost, which the rollback rule of 9.5 accepts before the first real v1
record. The synthetic journey is handled as 9.5 says.

**Step 8.** Environment. Estimate: about 10 minutes (rehearsed 6 Nov 2026 from v0.5.0, without the hidden-prompt
address: the commands ran in 1 second). Remove the retired organisation limit (FR-OPS-03) and
check that it is gone:

```bash
unset_env ORG_LIMIT_PER_USER
grep -cE '^ORG_LIMIT_PER_USER=' ../.env
```

The last line prints `0` (and exits 1, which is how `grep` reports no match). Check that the token
of step 4b is still there, then add the dead-man check's address from step 4a at a hidden prompt,
which shows nothing as you paste it from the password manager:

```bash
grep -c '^REMINDER_JOB_TOKEN=[0-9a-f]\{64\}$' /srv/makrai/app/.env
unset_env HC_REMINDER_PING_URL
[ "$(tail -c1 /srv/makrai/app/.env | wc -l)" = 1 ] || echo >> /srv/makrai/app/.env
read -rs -p 'HC_REMINDER_PING_URL: ' V && echo && ( umask 077; printf 'HC_REMINDER_PING_URL=%s\n' "$V" >> /srv/makrai/app/.env ); unset V
grep -cE '^HC_REMINDER_PING_URL=https://hc-ping\.com/[0-9a-f-]{36}$' /srv/makrai/app/.env
```

Both checks print `1`. If the second prints `0`, the paste was not an address of that form: run the
last four lines again. They remove an earlier line first, so a second run leaves one line. Then
recreate the app so that the container reads the new environment:

```bash
$C up -d --no-deps --wait --wait-timeout 120 nextjs
```

Two optional storage-cap settings exist (NFR-REL-09): `MAKRAI_ORG_STORAGE_CAP_BYTES` (default
1073741824) and `MAKRAI_ACCOUNT_UPLOAD_BYTES_PER_DAY` (default 209715200). Leave them unset to keep
the defaults.

**Step 9.** Run the post-check, 8.4: the sign-in page answers 200, every service is up, the error
count is 0, and the image and version match (`SAME` twice). Estimate: about 10 minutes (rehearsed 6 Nov 2026 from
v0.5.0: under 1 minute; the second `SAME` needs the version label that `release.yml` adds, which a locally built image
lacks).

**Step 10.** Sign in as the platform administrator and accept the three texts (FR-ACC-04). Then,
on S-23 and S-24, record the agreement version for the existing organisations (FR-ORG-06). Estimate:
about 10 minutes.

**Step 11.** Synthetic monitor (FR-OPS-01, NFR-AVL-03). Estimate: about 25 minutes. Sign in as the
synthetic account, accept the three texts, create the synthetic project and its first decision, and
note the project id, the stage and the question id. Then put root's crontab back exactly as step 6
saved it, which is what Pre-check A of the synthetic install compares by hash (`ops/host/README.md`,
"Hourly synthetic journey (Task 20b)"). Run the restore and the install chain together, outside
the minutes :05 to :12: the restore brings the old 7-past line back, and until the new script is
installed that line would run the old journey against v0.6.0 and send `/fail`.

```bash
[ -s /root/makrai-stage/crontab.root.v060-pause ] && crontab /root/makrai-stage/crontab.root.v060-pause
```

Install the new journey script by the staged-hash procedure of that section, with the three new
keys `SYNTHETIC_PROJECT_ID`, `SYNTHETIC_STAGE` and `SYNTHETIC_QUESTION_ID` in the server `.env`
and `SYNTHETIC_ASSESSMENT_ID` removed, and run it once by hand. When the install chain has run and
the hand run has passed, remove the saved copy and resume the `makrai-synthetic` check in the
dashboard:

```bash
rm -f /root/makrai-stage/crontab.root.v060-pause
rm -f /root/makrai-stage/crontab.root.v060-paused
```

If the install or the hand run fails, pause the journey again with the lines of step 6 (the saved
copy is still there), leave the check paused, and write down that it is paused. Resuming it is a
step of the next attempt.

**Step 11a.** The owner steps of v0.5.1, which v0.6.0 carries. Estimate: about 15 minutes. Finish
the synthetic check's move to host cron: the four items under "The check" in `ops/host/README.md`,
"Hourly synthetic journey (Task 20b)" (delete the old `makrai-synthetic` check, delete the GitHub
secret `HC_SYNTHETIC_PING_URL`, rename `makrai-synthetic-host` to `makrai-synthetic` with Cron
`7 * * * *`, UTC, grace 30 minutes, and check that GitHub has stopped running the schedule). Then
install the secret-rotation script as "Installing it" in "Rotating the production secrets (Task 24)"
says.

**Step 12.** Install the reminder job's wrapper, `makrai-reminders.sh`, with its cron line and dead-man
ping, the updated restore test and, if FR-REV-07 is kept, the audit-ship filter, each by the
staged-hash procedure of `ops/host/README.md` ("Installing from the checkout" and the install map
rows). Then run the reminder job once by hand and read its exit status, which must be `0`. Estimate:
about 30 minutes.

```bash
sudo -u <operator> /usr/local/bin/makrai-reminders.sh; echo "exit=$?"
```

**Step 13.** Smoke test in the synthetic organisation: open a stage review, seal it, generate a
mitigation plan, download it on a phone on mobile data and check that S-18 shows the same SHA-256,
then withdraw the document and check that S-18 reads "withdrawn". Estimate: about 20 minutes.

**The next morning**

**Step 14.** In your own terminal, read the restore-test line from 01:00 UTC, and read the other
alerts (NFR-OBS-03). The line must be today's (the UTC date of the 01:00 run) and a pass:

```bash
tail -n 1 /srv/makrai/restore-test.log | grep -c "^\[$(date +%F)T.*Restore test PASSED"
```

It prints `1`. A pass counts as one that included the seal check only if step 12 installed the
updated restore test, because the earlier script wrote the same `Restore test PASSED` line; the
section of `ops/host/README.md` that installs the updated script names the line that shows the seal
check ran. `0` means no pass today: read the line itself, in your own terminal, before anything else.

Keep the previous images until the next release passes its post-check: no `docker image prune`
before then (section 9).

### 8.6 v0.6.1: the owner's steps

The release-candidate run (8.1) may be done by whoever prepares the release; the tag needs the
owner's approval (8.1 step 2). Every step on the host and every sign-in on production is the
owner's, in the owner's own session (12.1), in a terminal and a browser outside any AI session. No
output of the host is pasted into an AI session (NFR-SEC-17). Before 8.2, on the host, run the
"Set these once per session" block of section 8. 8.2 to 8.4 use its `cd` (for `../.env`), `$C`
and `set_env`. Step 5 of the list below also uses `$PGU`. Nothing here uses `unset_env`. Deploy v0.6.1 with
8.1 to 8.4 as written, plus the steps below, in this order. 8.5 was v0.6.0's list and is not
repeated. This release carries two database migrations
(`prisma/migrations/20261112000000_v061_organisation_legal_name` and
`prisma/migrations/20261112010000_content_5_1_0`), so 8.2's backup and 8.3 step 4 (the migrator)
apply to it. The second registers content 5.1.0: from the end of 8.3 step 4 until the swap in
8.3 step 5 the old app refuses saves, withdrawals and seals, as 8.3 says, and 9.6 says what that
means for a rollback.

1. **Before the tag (8.1).** Run the release-candidate unit cases as the paragraph "Before the v0.6.1 tag"
   in 8.1 says, and see it pass. The always-on cases check that the three accepted texts are at
   version 2 and the organisation agreement is retired at version 1
   (`__tests__/unit/legal-texts.test.ts:82-108`). The release-candidate cases add that no current
   text holds placeholder text, an unresolved field, or a claim of review by a lawyer (`:184-210`).
   What to do when any case fails is in the 8.1 paragraph.
2. **Before 8.3, and until the post-check has passed: create no organisation.** The window runs from
   the migrator (8.3 step 4) until the post-check (8.4) has passed. A create sent to the old image
   and sent again after the swap is refused, or creates a second organisation. What a person at the
   screen meets: a page loaded before the swap is refused with 422, because it sends no legal name
   (`lib/data/admin.ts:220,225`). A page reloaded and sent again gets a new request id
   (`lib/client/retrySafeWrite.ts:39`, `components/admin/CreateOrganisationForm.tsx:215`) and is
   refused as `slug_taken` against the organisation the old image made
   (`prisma/migrations/20261112000000_v061_organisation_legal_name/migration.sql:86`), or, for a name
   with no letter a to z and no digit 0 to 9 once accents are removed (é counts as e; a name written only
   in Amharic, Arabic, Cyrillic or Chinese, or only in letters such as ø that have no plain form,
   has none), `deriveSlug` returns an empty string (`lib/data/preauth.ts:194-201`), the route picks
   a random slug (`app/api/admin/organisations/route.ts:40`) and a second organisation is created.
   Read from the code, not rehearsed. If a create was sent in the window, check the organisation
   list (S-23) for the name before trying again. The old create-organisation function stays
   callable until the later contract migration (`migration.sql:3-7`).
3. **8.2, 8.3 and 8.4 as written.** When it worked, the post-check prints `200`, every service is up,
   `0` (or only the lines 8.4's second exception calls expected), and `SAME` twice.
4. **After the post-check, once: accept the three version-2 texts.** In the owner's own browser, sign
   in on production as the platform administrator and then as the synthetic account, and accept the
   three texts each time. The synthetic account's password comes from wherever the owner keeps it. No
   AI session types a production password. When it worked, the synthetic account lands on its
   organisation's dashboard after it accepts (`app/page.tsx:44-45` sends an account that has an
   organisation to `/orgs/<slug>/dashboard`), and the platform administrator lands on the list of
   organisations (S-23), which is the administrator's home (`app/page.tsx:32`). Neither is sent back
   to where it was (`components/legal/RecordAcceptances.tsx:38`). Until the synthetic account has accepted, the hourly
   synthetic journey is refused with 403 and shows red: its read of the decision fails on any status
   other than 200 (`scripts/synthetic-journey.mjs:228-230`), and the 403 is the acceptance gate
   (`lib/auth/identity.ts:324-328`, `lib/http/errors.ts:64-67`). Do it before the next hourly run, or
   expect one red run.
5. **Then tell every account holder what changed, once.** The terms (section 17) and the privacy
   notice (section 13) both say MAK-AI will tell people what changed when it asks them to accept a
   new version, and the acceptance screen shows no summary. So on the deploy day the owner emails
   the text of `docs/releases/v0.6.1-legal-changes.md` to every person who already has an account.
   Nothing in the platform sends this message. The owner sends it from the owner's own mailbox.
   Send each address its own message, or put all of them in Bcc. Never put them in To or Cc:
   account holders in different organisations must not see each other's addresses.
   To get the addresses, run this read-only statement on the host, with the session block's `$PGU`.
   It skips accounts that were deleted, which are the ones whose address was replaced by
   `deleted-<id>@invalid` (`lib/data/identity.ts:394`):

   ```bash
   $C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 <<'SQL'
   select email from users where email not like 'deleted-%@invalid' order by email;
   SQL
   ```

   It prints one address per line. The list stays in the owner's terminal and is not pasted into any
   AI session (NFR-SEC-17). The synthetic account's address and the platform administrator's own address are on the list and
   need no message. When
   it worked, one message has gone to each other address. The statement was run on a local database
   only.
6. **Then record legal names.** As the platform administrator, on S-23, find each organisation
   flagged "Legal name not recorded" (FR-ORG-06), open it (S-24) and use its legal-name form. When it
   worked, the flag is gone from that organisation's row.

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

A release that was tagged and never deployed (v0.6.1) is not a release to return to: PREV is the
release the host last ran, which 8.2 recorded.

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
5. After **any** restore, whichever backup it was, check the application role's DELETE on
   `memberships` before the application takes traffic (backup-restore.md 4.4a is the same check). A
   backup taken during an application rollback (9.5) carries the REVOKE, and restoring it brings
   that back:

   ```bash
   $C exec -T postgres psql -U "$PGU" -d makrai -c '\dp memberships'
   ```

   The access privileges must include `makrai_app=rwd/makrai`. If they do not, give it back:

   ```bash
   $C exec -T postgres psql -U "$PGU" -d makrai -Atc 'GRANT DELETE ON "memberships" TO makrai_app'
   ```

Migrations in this project are additive unless their pull request says otherwise, so
the previous release's code normally runs against the newer schema, and 9.2 alone is
the rollback. The releases v0.6.0 and v0.6.1 are the exceptions: 9.5 says why 9.2 alone is not a
full rollback for v0.6.0, and 9.5a and 9.6 say it for v0.6.1.

### 9.4 Verify

Run the post-check in 8.4. `SAME` now means the container runs the image PREV named.
After a rollback to `makrai-nextjs:rollback` the second line prints `DIFFERENT`, as 8.4
says it should.

After a rollback of v0.6.1 to v0.6.0, 8.4's third line may print more than `0`, and that alone
does not fail the verification. While content 5.1.0 stays registered, v0.6.0 keeps refusing
saves, withdrawals and seals, and fails the pages 9.6 lists. Each refused request writes an
error line, and a failing page writes several. Count the lines that are not one of the two
refusals 9.6 describes, not part of a failing page's lines, and not an audit warning (8.4). Run
the commands once 10 minutes have passed since the last `up` of 9.2 returned (for this release
9.2 also brings up postgres, then nginx, after the app), so that they read only v0.6.0's lines; an earlier run
also counts the lines of the release you rolled back from. The first line holds the pattern, the
second prints the count, and the third prints the lines that were counted:

```bash
X='^(    at |  [a-z]+: |}$)|^ ?⨯ [A-Za-z_$][A-Za-z0-9_$]*: (unknown_content_version|content_not_published)$|^[{]"event":"REQUEST_FAILED","reference":"[0-9a-f]+","status":(503,"code":"content_not_published"|500,"code":"unknown_content_version"),"at":"[^"]*"}$|^[{]"timestamp":"[^"]*","level":"warn","event":"[A-Z_]+",'
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since -10min -p err -o cat | grep -vcE "$X"
journalctl CONTAINER_TAG=makrai/docker-nextjs-1 --since -10min -p err -o cat | grep -vE "$X"
```

The second line prints the count (and exits 1 when the count is `0`, which is how `grep` reports
no match). The pattern leaves out, as whole lines only: a refused request,
`{"event":"REQUEST_FAILED","reference":"…","status":503,"code":"content_not_published","at":"…"}`,
and the same line with `500` and `unknown_content_version`; the first line of a failing page,
`⨯ b: unknown_content_version` (the name before the colon may differ), or the same with
`content_not_published`; a line indented four spaces that starts `at `, a line indented two
spaces that starts with a lower-case word and a colon, and a line that is only `}`, which are
the stack and fields under a failing page's first line; and an audit warning. Every other line
counts, including the first line of any other failing page, so an unexpected error shows at
least its first line. A line in another form, for example a `⨯` rendered differently by the
journal, is counted, not left out. What it could hide is an error whose own first line has one
of the stack or field shapes; none was seen. It also accepts a failing page with either code
whatever page it is: the first line names no page, so 9.6's list says which pages to expect, but
the count cannot check it.

The form of these lines was captured in the local rehearsal of 12 November 2026 (register
D-331), with `docker logs` on a workstation, not from a journal and not on the host. On the 25
lines of two failing pages and one refused save, this filter printed `0`, where the filter it
replaces printed `24`. With an unexpected error line, a failing page with another code, the
captured 500 of a missing column, or a plain-text error added, it printed `1` or more. The
`content_not_published` page line and the `unknown_content_version` request line were not
captured; v0.6.0 writes the request line for every refusal it answers with 500 or above
(`lib/http/toResponse.ts` at v0.6.0, `9932c51f`, lines 101 to 106). If the count is not `0`, read
the lines the third command prints. Each of them fails the verification, except the few sign-in
library lines 8.4 describes.

### 9.5 v0.6.0: when to roll back, and how

The rollback target of this release is v0.5.0, the last tag. The v0.5.0 application image runs
against the v0.6.0 schema, because v0.6.0 only adds to the database and drops or renames nothing
that v0.5.0 reads (NFR-REL-07, ADR-0020). Every step here is the owner's, as in 8.5. The rule
depends on one fact: whether a real team has made a record in v0.6.0 yet. A real v1 record is any
record in an organisation other than the synthetic one; the hourly journey and the step 13 smoke
test are in the synthetic organisation.

- **Before the first real v1 record.** Either an application rollback to v0.5.0 (9.2), or a
  database restore (9.3). The application rollback gives a v0.5.0 that signs in and reads but
  cannot create or save assessments, accept invitations or delete an account (NFR-REL-07).
  Accepting an invitation is refused because v0.6.0 removes the grants that v0.5.0's acceptance
  uses; the rehearsal records that refusal as expected. The database restore discards every write
  since BACKUP, the file 8.2 wrote down.
- **After the first real v1 record: fix forward with v0.6.x.** An application rollback only as an
  emergency stop, because v0.5.0 does not show v1 records. A database restore is not safe then
  (ADR-0020): it discards every write since the backup, and by then those include teams' records.

A migrator that stopped on the owner check is not a rollback: nothing of v0.6.0 was applied, and
8.5 step 7 says what to do.

**Rolling back the application.** First, while v0.6.0 still serves, take DELETE on `memberships`
from the application role, as the owner role:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'REVOKE DELETE ON "memberships" FROM makrai_app'
```

During the seconds from this line to the swap, and again from the swap back to the GRANT below,
0.6.0 refuses member removal and account deletion with 500 (42501), and removes nothing.

Why: v0.5.0's account deletion removes the person's memberships first, one organisation at a time, each in a transaction
of its own, and only then deletes their consent rows, which v0.6.0 no longer lets it do. Without this line, a person who
deletes their account while v0.5.0 serves loses every membership and keeps an active account (seen in the rehearsal of
6 Nov 2026: one membership to none, a 500, the account still active). With it, the first membership delete is refused,
so nothing is removed. While v0.5.0 serves, deleting an account, removing a member and leaving an organisation all fail
with a server error; the rule above already limits v0.5.0 to signing in and reading. Taking it before the swap means no
moment in which v0.5.0 serves with the privilege: every window fails loudly in 0.6.0, never silently in v0.5.0.

Then run 9.2 with the PREV lines written down in 8.2, then the
post-check of 9.4. The hourly synthetic journey must be paused while v0.5.0 serves, because the
journey installed in step 11 uses v0.6.0 routes that v0.5.0 does not have. If step 11 has not run,
step 6 still holds it paused. If step 11 has run, pause it again with the lines of 8.5 step 6 (they
save the current crontab, because step 11 removed the saved copy) and pause the `makrai-synthetic`
check, and write down that it is paused. If step 12 has run, also pause the reminder job's cron
line, by commenting it out in the crontab that step 12 installed it in (the install section of
`ops/host/README.md` names it), and the `makrai-reminders` check, while v0.5.0 serves: the job calls
an internal route that v0.5.0 does not have. Write down that these are paused too.

**Restoring the database (before the first real v1 record only).** Run the REVOKE above first,
then 9.2, then 9.3 with BACKUP, the file 8.2 wrote down; 9.3's last step checks the privilege on the
restored database and gives it back if it is missing. After a restore, v0.5.0 runs against the schema it was built for.
If 8.5 step 11 has not run, the journey still installed is the old one and works again: put the
crontab saved in 8.5 step 6 back with the restore block of step 7's undo (it restores, then removes
both files only after the restore has worked, and counts the pause lines, which must print `0`;
anything else is a stop before you resume the check), and resume the `makrai-synthetic` check. If
step 11 has run, pause the journey again with the lines of 8.5 step 6 (they save the current
crontab, because step 11 removed the saved copy) and pause the `makrai-synthetic` check, and write
down that it is paused. If step 12 has run, also pause the reminder cron line and the
`makrai-reminders` check as above, and expect the 01:00 restore test's seal step to fail against
the restored v0.5.0 schema until v0.6.x is back: an expected alert, not a new fault. It would
stop the return deploy at 8.2's first line of the migration block, so on that deploy a restore-test
result that failed only in its seal step, read in your own terminal, counts as 8.2's line passing for
this one deploy; any other failed field is a stop. 8.5 step 14's check runs the morning after the
return.

**Right after the swap back to v0.6.x.** The moment 8.3 step 5 of the return deploy has swapped the
container, give the application role its DELETE on `memberships` back, exactly as v0.6.0 had it, and
check it:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'GRANT DELETE ON "memberships" TO makrai_app'
$C exec -T postgres psql -U "$PGU" -d makrai -c '\dp memberships'
```

The access privileges of the second line must include `makrai_app=rwd/makrai`; if they do not, run the
GRANT again. Until it runs, v0.6.0's member removal and account deletion answer 500 (permission denied,
42501) and remove nothing. After a database restore the privilege is already back, and the two lines
only confirm it.

**After returning to v0.6.x.** v0.5.0's code writes the `ipAddress` column of consent rows, which
v0.6.0 clears and stops writing. Clear what v0.5.0 wrote during the rollback, as the owner role. No
other role can run this function, and a plain `UPDATE` of the column is refused by a trigger:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'select makrai_clear_consent_ip_addresses()'
```

It prints the number of rows cleared, and `0` when v0.5.0 wrote no consent row.

Whatever you paused and wrote down comes back now, or the hourly monitor and the reminder job stay
off and nothing says so: a paused healthchecks check never alerts. If 8.5 step 11 has not completed
(it never ran, or it ran and failed), do not use the next block: the return deploy is 8.5 again,
whose step 6 pauses the journey before the container swap and whose step 11 puts the crontab back
and installs the new journey. After a database restore step 7's undo has already resumed the old
journey, so run step 6's lines before the container swap. Otherwise put the saved crontab back, which
un-comments the journey's line, and count the pause lines:

```bash
[ -s /root/makrai-stage/crontab.root.v060-pause ] && crontab /root/makrai-stage/crontab.root.v060-pause && rm -f /root/makrai-stage/crontab.root.v060-pause /root/makrai-stage/crontab.root.v060-paused
crontab -l | grep -c '^#v060-pause '
```

The last line must print `0`; anything else is a stop before you resume anything. Then resume the
`makrai-synthetic` check. If you paused the reminder job, un-comment its cron line and resume the
`makrai-reminders` check too.

### 9.5a v0.6.1: rolling back past the legal texts

Whether to roll back v0.6.1 at all is decided by 9.6: its rule is to fix forward, because of
content 5.1.0. This section covers only the legal side of a rollback: what it does to accounts,
to the legal texts and to legal names.

Everything here is read from the code, except where it says what the rehearsal showed. The SQL
below was run on a local scratch database, and on 12 November 2026 the rollback, the revert and
the roll-forward were rehearsed on a workstation with a v0.6.0 image built locally from the
v0.6.0 release candidate (`makrai-web:v060-428c553`, not the published image) and the 0.6.1
candidate at `fd7a9da5`. Nothing in this section has been run on the host.

**Rolling back the application (9.2) keeps every stored row.** The legal-name migration only adds:
nothing is dropped or revoked, and the widened action CHECK still allows every old value
(`prisma/migrations/20261112000000_v061_organisation_legal_name/migration.sql:3-7`).

- Accounts that accepted the version-1 texts before the deploy still pass the old gate. It counts
  a row when its version and hash match a version it knows, and version 1 is the only one it
  knows (`lib/data/acceptances.ts` at v0.6.0, `9932c51f`, lines 59 to 69, and
  `data/legal/published.json` there).
- Accounts created after the deploy hold only version-2 rows. The old image does not count them,
  so it sends those accounts to accept the version-1 texts, including the one-line placeholder
  consent ("The text of this document is supplied by legal before the deploy day.", v0.6.0's
  `data/legal/cross-border-consent/1.md`). An account that accepted version 2 on top of version 1
  passes. In the rehearsal, an account holding only version-2 rows was sent to the acceptance
  page with the three version-1 texts.

After rolling forward again, or after an organisation was created by the old image during the
deploy, run the legal-name backfill again. It fills only empty values, so it is safe to repeat:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -v ON_ERROR_STOP=1 <<'SQL'
UPDATE "organizations" o SET "legalName" = a."controllerLegalName" FROM (SELECT DISTINCT ON ("orgId") "orgId", "controllerLegalName" FROM "organization_agreements" ORDER BY "orgId", "recordedAt" DESC, "id" DESC) a WHERE o."id" = a."orgId" AND o."legalName" IS NULL;
SQL
```

It prints `UPDATE N`, where N is the number of organisations that gained a name.

**Reverting the migration itself** is only for a case where the new column or functions must go.
It is not needed for an application rollback.

**Only after 9.2, with v0.6.0's image serving and 9.4 passed as 9.4 words it for this release.** Run while v0.6.1 still serves, the
SQL drops the create-organisation function v0.6.1 calls (`lib/data/definer.ts:96`) and the
`legalName` column it reads (`app/(authenticated)/admin/organisations/page.tsx:74`,
`lib/data/admin.ts:301`), so creating an organisation and the organisation screens fail.

**Warning: the SQL deletes the `legalName` column, and these names are lost with it. Names the
administrator recorded or corrected after the deploy. Names entered when an organisation was created on
v0.6.1: they have no agreement record to copy from, and cannot be recovered. Only names copied
from agreement records can be copied again from `organization_agreements`.** Before the revert,
the owner, outside any AI session, runs this read-only statement, which saves its output to
`/root/legal-names-kept.txt`, readable by root only:

```bash
( umask 077; set -C; $C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 > /root/legal-names-kept.txt <<'SQL'
select id, name, "legalName" from organizations where "legalName" is not null order by name;
SQL
)
```

The file holds one line per organisation with a legal name: `id|name|legal name`. It is empty
when none is set. `set -C` makes the shell refuse to write over a file that exists (`cannot
overwrite existing file`), so a second run cannot replace the kept names by mistake. The statement was run in the local rehearsal of 12 November 2026 and its output
kept; the form above, which saves it to a file under `/root`, was checked on a workstation with a
stand-in for the database command, not on the host.

Run the revert as the owner role, in this order, in one transaction (the statements are the ones
run on the scratch database, unchanged):

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
DROP FUNCTION public.admin_create_organisation(text, text, text, text, text, text, text, timestamptz, boolean, uuid, text);
DROP FUNCTION public.admin_correct_org_legal_name(text, text, text);
REVOKE UPDATE ("legalName") ON "organizations" FROM makrai_definer;
ALTER TABLE "organisation_events" DROP CONSTRAINT "organisation_events_action_check";
ALTER TABLE "organisation_events" ADD CONSTRAINT "organisation_events_action_check"
  CHECK ("action" IN ('organisation_created', 'agreement_recorded', 'owner_invitation_issued',
      'owner_invitation_resent', 'owner_invitation_revoked', 'organisation_name_corrected',
      'account_deactivated', 'account_reactivated',
      'member_invited', 'member_joined', 'member_role_changed', 'member_removed', 'member_left'));
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_legalName_chk";
ALTER TABLE "organizations" DROP COLUMN "legalName";
COMMIT;
SQL
```

Postgres re-checks existing rows when the constraint is added, so the script stops while an
`organisation_legal_name_corrected` row exists. The rehearsal had one, and psql printed
`ERROR:  check constraint "organisation_events_action_check" of relation "organisation_events" is violated by some row`;
the `legalName` column was still there. Those rows
are append-only history, so the CHECK stays widened: because the script is one transaction and stops on the first error,
nothing has changed, so run it again without the two `organisation_events_action_check`
statements. In the rehearsal that second run printed `COMMIT` and the column was gone.

**Rolling forward to v0.6.1 again after the revert (register D-325).** After the SQL runs, the
migration is still listed as applied, so a return deploy as 8.3 words it does not apply it again.
In the rehearsal the migrator printed `No pending migrations to apply.`, the new container came up
healthy, the login page answered 200, and the organisations screen (S-23) answered 500: Prisma's
P2022, the column `organizations.legalName` does not exist. (The two `SAME` lines of 8.4 and the
restart count, run later on the same container, printed `SAME` and 0. 8.4's third line was not run
then; it would have counted the lines of that 500.) So, as the owner role, first see that the
column is gone, then remove the migration's record, then run the migrator line of 8.3 step 4:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -Atc "select count(*) from information_schema.columns where table_name='organizations' and column_name='legalName'"
$C exec -T postgres psql -U "$PGU" -d makrai -v ON_ERROR_STOP=1 -Atc 'DELETE FROM "_prisma_migrations" WHERE migration_name = '\''20261112000000_v061_organisation_legal_name'\'''
```

The first must print `0`. If it prints `1` the revert did not commit (its first run stops with an
error, above): do not run the second line, because the migration applied again would then fail on
a column that exists. That case was not run. The second must print `DELETE 1`. In the rehearsal it
did; the migrator then printed
``Applying migration `20261112000000_v061_organisation_legal_name` `` and `All migrations have been
successfully applied.`, and S-23 answered 200. There it was run as a statement of its own, after
the revert had committed and after a return deploy without it had already swapped the container;
the migrator line was then run again. Running it before the return deploy's 8.3 step 4 was not
tried, and neither was running it inside the revert's transaction.

The migration applied again fills `legalName` only from each organisation's latest agreement record
(`prisma/migrations/20261112000000_v061_organisation_legal_name/migration.sql:23`), so the backfill
above then prints `UPDATE 0`, as it did in the rehearsal. Every other name is gone: the names an
administrator recorded or corrected, and the names entered when an organisation was created on
v0.6.1. In the rehearsal the name recorded in 8.6 step 6 was gone and S-23 flagged that
organisation "Legal name not recorded" again. Do 8.6 step 6 again. It finds only organisations
left without a name: an organisation whose name was corrected on v0.6.1 and that has an agreement
record now shows the agreement's name and is not flagged (read from the migration; the rehearsal
had no such organisation). So also run the read-only statement above again, saving to
`/root/legal-names-now.txt` in place of `/root/legal-names-kept.txt`, then run
`diff /root/legal-names-kept.txt /root/legal-names-now.txt`. Each line marked `<` is an
organisation whose kept name differs or is missing now. Open it (S-24) and record the kept name
with its legal-name form.

### 9.6 v0.6.1: content 5.1.0 and a rollback to v0.6.0

**What content 5.1.0 changes in the database.** Its migration, `20261112010000_content_5_1_0`,
marks the earlier content versions (3.0.0, 3.0.1, 4.0.0 and 5.0.0) as no longer published and
adds content 5.1.0 as the published one. It adds or drops no table or column; it updates and
inserts rows in `framework_versions`. The release's other migration,
`20261112000000_v061_organisation_legal_name`, adds a column with a check on it, the functions
that write it and a grant, and widens one other check; it takes away nothing the older image
uses, and 9.5a covers it. So 9.5's reasoning about a schema that an older image can read still
holds for both. What an older image cannot cope with is the content version, in two ways.
These effects are read from the code. Part of them was rehearsed on 12 November 2026 on a
workstation, not on the host, with a v0.6.0 image built locally from the v0.6.0 release candidate
(`makrai-web:v060-428c553`, not the published image) after the content migration had run. There,
saving a decision answered 503 `content_not_published`; a question's page and a stage page that
held a decision saved under 5.1.0 answered 500; a question saved under 5.0.0, a question's history,
a project page without a sealed review and the findings page answered 200; and an account holding
only version-2 acceptances was sent to accept version 1. Withdrawing, sealing, documents, and the
pages that read a sealed review were not exercised: no sealed review existed.

- **The v0.6.0 image refuses three actions once the content migration has run: saving a decision,
  withdrawing a decision and sealing a review.** It runs content 5.0.0, and each of these checks
  first that 5.0.0 is still the published version (`resolveRunningContentVersion` in
  `lib/data/framework.ts`). It no longer is, so the action is answered with 503
  `content_not_published`. The same check runs when a page reads a sealed review, so these pages
  also fail with a 503: the project page, the review page, the review's documents page and the
  seal page, for a project that has a sealed review, and a stage page, when that stage has one.
  The seal page also fails, for a person who can seal, in any project that is not archived; for
  anyone else it fails only when the project has a sealed review. A person who presses Save
  sees "Not saved: the server had a problem. Your answer is kept on this device. Retry." The
  answer stays as a draft on their device if the browser keeps drafts; if it does not, the
  answer is only in the open field, and the screen says so. They can save it once a v0.6.x that
  runs 5.1.0 is back. People can still sign in; an account created after the deploy is first
  asked to accept the version-1 legal texts (9.5a). A single question's page opens (unless its
  current decision was saved under 5.1.0, see the next point) and so does a question's history.
  The pages named here are the only ones that make this check: nothing else in the v0.6.0 code
  does.
- **The v0.6.0 image also fails on pages and requests that read something saved under 5.1.0.** It
  lists only content 5.0.0 (`data/content/index.json` at v0.6.0), so anything that must load the
  wording of 5.1.0 answers 500 `unknown_content_version`: a question's page when its current
  decision was saved under 5.1.0; a stage page when a current decision in it was; and the project's
  findings page and that finding's page when a shortfall finding was raised against such a decision.
  Documents cannot be made from a page opened under v0.6.0: making one needs a sealed review, and
  the review's documents page then fails as the first point says. Through the API, or from a
  documents page opened before the rollback to v0.6.0, making or previewing a document fails with
  the same 500 when the seal it is made from, or the latest seal of another stage of the project,
  holds a decision saved under 5.1.0; a mitigation plan made from a seal taken under 5.1.0 always
  fails. A document already issued can still be downloaded from a link the person already has; the
  review page and the documents page that list it fail as the first point says. A question's
  history page still opens and shows such an entry without its wording. Decisions saved under
  5.0.0 show as before. The hourly synthetic journey (7.4) saves a decision in the synthetic
  organisation once its account has accepted the version-2 legal texts (8.6 step 4; until then
  its run is refused), so from the first hourly run after that step a decision exists there
  under 5.1.0, and that question's page and its stage page fail from then. The document failures need a seal that holds such a decision or
  was taken under 5.1.0; the journey takes no seal.

The same refusals apply in the deploy itself: between 8.3 step 4 and step 5 the app still serving
is the old one, and it refuses the three actions and the pages of the first point for that short
interval (8.3 says so). The second point does not apply then, because nothing has yet been saved
under 5.1.0.

**The rule: fix forward with a later v0.6.x.** An application rollback to v0.6.0 (9.2) is an
emergency stop only. After it, people can sign in (an account created after the deploy must
first accept the version-1 legal texts, 9.5a) and read single questions (except one whose
current decision was saved under 5.1.0) and their history, but cannot save or withdraw a
decision or seal a review, the pages of the first point that read a sealed review fail, and the pages of the second point that read something saved under 5.1.0 fail.
If you must stop the release that way, say so to the teams, and expect those pages to fail until
the return deploy. The hourly journey's save is refused while v0.6.0 serves, so it reports a
failure to the `makrai-synthetic` check every hour. Pause the journey with the lines of 8.5 step 6
and pause the `makrai-synthetic` check, as 9.5 does, and write down that both are paused. After the
return deploy to v0.6.2 or later, put the crontab back and resume the check with the block at the
end of 9.5 that begins "Whatever you paused and wrote down comes back now"; 8.5 step 11 has
completed, so that block applies as 9.5 words it. A database restore (9.3) follows 9.5's rule about
real records: it is safe only before the first real v1 record, and after that it discards every
write since BACKUP, the file 8.2 wrote down. A restore to BACKUP also puts 5.0.0 back as the
published version, which is why v0.6.0 can save again after it.

This runbook gives no way to re-publish 5.0.0 by hand while the content migration stays applied.

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

### 12.2 The access baseline, and no agent windows

No agent connects to the production host, from v0.6.0 on (NFR-SEC-17). Up to v0.5.x the owner
could open a timed connection for an AI agent to ride, to read the host. That was tolerable while
production held two test-like accounts and no records. From v0.6.0 it holds real teams' records,
and root on the host reads the database and the backup passphrase in `.env`, so no AI session holds
a connection to the host, however short, and nothing the host prints is pasted into one (ruling
13, NFR-PRIV-05). Every step of sections 8, 9 and 12 is the owner's, in a session as in 12.1.

For the commands below the owner defines, in the session of 12.1:

```bash
SSH="ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server>"
```

What stays is the access baseline, a record of the effective access settings so that a change to
them is seen: the owner runs the access baseline below in their own session, records its output on
the owner's own machine after any change to sshd, PAM, sudoers or the authorized keys, and compares
a later run with that record there. The record holds host output (settings, hashes, key fingerprints
and group members), so it is kept outside any directory an AI session reads, never under `records/`
and never in a repository checkout. The baseline is sent as one script to `bash -s` on standard
input, byte for byte, with the locale fixed so that globs and `sort -u` order their output the same
way every time. The step that records the baseline and the later comparison use this same form:

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

The comparison catches a change to what it covers, not other persistence, such as a cron job or a
systemd unit (ADR-0010). A package upgrade can change the hash of `/etc/ssh/sshd_config` or a
`common-*` file; the owner finds the cause before recording a new baseline.

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
entry, succeeds. The check prints only counts; the owner runs it from a second terminal, with
`$SSH` of 12.2:

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

### 12.6 Erasing a file or a field on a controller's written instruction (v0.6.0)

Run only on the controller's written instruction, in the owner's own session (12.1), in a terminal
outside any AI session. The instruction's reference goes into the tombstone; keep the instruction
itself outside the repository (SRS 5.6). Here "controller" is the data controller that gave the
instruction, as in FR-EVD-05 and FR-REV-08, not the person who runs the build.

Three SQL functions do the work. Each is owned by a dedicated role that cannot log in, and is
executable by no application role, so only the owner role `$PGU` (the session block of section 8)
can call them. Each takes the organisation id, sets the organisation context from it, stops with an
error unless exactly one target row matches, and writes one `tombstones` row. Run the commands from
`/srv/makrai/app/docker`, with `$C` and `$PGU` set as in section 8.

**Before.** Take from the instruction, and write down: the organisation id; the ids of the target,
which are the evidence id; or the table, the row id and the field name (for example table
`decision_versions` and field `reason`; the function accepts only the pairs it lists, and refuses
any other); or the document id and the typed field id; and the erasure code and the instruction
reference that the instruction gives. Never the text to be erased: no procedure needs it, and
nothing in this section prints a record field, so nothing erased reaches the screen or a log.

Type the instruction reference and the erasure code once, at these prompts. `read -r` keeps every
character as typed, and psql receives them as variables, so a `$`, a quote or a backslash in them
cannot change the command. The functions accept any non-empty text for both, so read them against
the instruction before pressing Enter, in the order the prompts show. The ids are typed in place of
the `<...>` placeholders of the calls below; a placeholder left in makes the call find no row and
stop.

```bash
read -r -p 'Instruction reference: ' REF
read -r -p 'Erasure code: ' CODE
```

A procedure that matches no row or several rows stops with an error and changes nothing. Re-read the
instruction; do not retry with other ids. On success a call prints an empty line, because the
function returns nothing.

**An evidence file (FR-EVD-05).** Erases the file's bytes and every issued document that printed
it; the evidence row, its hash and the documents' SHA-256 stay. A file's name, label or link is a
text field, erased by the second call.

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 -v "ref=$REF" -v "code=$CODE" <<'SQL'
select erase_evidence_bytes('<org id>', '<evidence id>', :'code', :'ref');
SQL
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'vacuum evidence_blobs, issued_documents'
```

**A free-text field (FR-REV-08).** Erases one field's text and its salt, and every issued document
that printed it; the digest in every stored manifest stays.

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 -v "ref=$REF" -v "code=$CODE" <<'SQL'
select erase_text_field('<org id>', '<table>', '<row id>', '<field>', :'code', :'ref');
SQL
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'vacuum <table>, issued_documents'
```

**A typed field of an issued document (FR-REV-08, `erase_typed_field`).** Erases one typed field of
an issued document, its draft value when it is equal, and the document's bytes; the document row
and its SHA-256 stay.

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 -v "ref=$REF" -v "code=$CODE" <<'SQL'
select erase_typed_field('<org id>', '<document id>', '<field id>', :'code', :'ref');
SQL
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'vacuum issued_documents, document_draft_fields'
```

Each `VACUUM` follows its procedure and is not part of it, because `VACUUM` cannot run inside the
function's transaction (SRS 5.6). In the text-field pair, `<table>` in the `VACUUM` line is the
table of the call before it. The functions also replace the stored request digest on the other
record tables, and the old digest stays in their dead rows. After the last call, run one plain
`VACUUM` over the whole database, as the owner role:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -Atc 'vacuum'
```

A plain `VACUUM` leaves a row version that an older transaction can still see, such as the 00:00
backup while it runs or a connection held open; if one of those was running, run the `VACUUM`
lines again when it has finished.

**The check.** Count the tombstones written for that instruction; the line prints only a number,
which is the number of calls made under that instruction reference. Any other number means a
mistyped reference or a call that did not run: stop and find which:

```bash
$C exec -T postgres psql -U "$PGU" -d makrai -At -v ON_ERROR_STOP=1 -v "ref=$REF" <<'SQL'
select count(*) from tombstones where "instructionReference" = :'ref';
SQL
```

Then ask the organisation's owner, who is the controller that gave the instruction, to open "Check
this seal" on the stage review in the app; the platform owner holds no membership in the
organisation and cannot. It shows "valid; N erased", where N counts every erasure made on that stage
review: "valid; 1 field erased" after one field, "valid; 1 file erased" after one file (FR-REV-08,
FR-EVD-05).

The old value stays in the write-ahead log and in backups until they age out: about 31 days on the
server while nightly backups succeed, and about 41 to 42 days counting the off-site snapshots,
longer than the 30 days (NFR-PRIV-07) the requirement sets (register D-324). The privacy notice says
"about 43 days": 43 is the operating documents' safe upper bound, which `backup-restore.md`
explains. Nothing more is done for them.
