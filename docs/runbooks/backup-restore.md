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
| Off-site copy      | Daily at 00:30 UTC, to a Hetzner Storage Box (§5) |
| Restore test       | Daily at 01:00 UTC, from the off-site copy (§6)   |
| Scripts            | Tracked in `ops/host/` (§1.2)                 |
| Domain             | `makrai.org`                                  |

---

## 1. Automated Daily Backup (Cron)

### 1.1 Create the backup directory

```bash
mkdir -p /srv/makrai/backups
chown <operator>:<operator> /srv/makrai/backups
touch /srv/makrai/backup.log
chown <operator>:<operator> /srv/makrai/backup.log
```

The log deliberately does **not** live in `/var/log`. That directory is
`root:syslog`, §1.3 installs a *user* crontab, and nothing here ever chowned a
file there — so every run would have died on its first log write, having
recorded nothing. The whole point of the script's error handling is defeated if
it cannot write its own log.

### 1.2 Install the host scripts

The scripts that run on the host are tracked in the repository, in
[`ops/host/`](../../ops/host/), and the file there is the source of truth. This
runbook no longer carries a copy: the one it carried had already drifted from the
file the host was running, and nothing could say which was right.
[`ops/host/README.md`](../../ops/host/README.md) maps each file to its place on the
host, with its owner and mode.

| Script | What it does |
| --- | --- |
| `makrai-backup.sh` | Nightly `pg_dump`, encrypted, verified by decrypting it again, pruned after 30 days. |
| `makrai-backup-check.sh` | Dead-man's switch for the backup (§1.6). |
| `makrai-offsite-copy.sh` | Mirrors the encrypted backups to the Storage Box (§5). |
| `makrai-restore-test.sh` | Restores the newest off-site backup and compares it with live (§6). |
| `makrai-lib.sh` | Helpers the last two source: `load_env`, `ping_ok`, `ping_fail`, `alert`. |

Install them from the checkout on the server (the git step in
[`deployment.md`](./deployment.md) §8 brings the checkout up to date first). On the server, do
not paste the block below as written: it installs straight from the checkout, which the operator
can write. Install each file with the staged-install rule in
[`ops/host/README.md`](../../ops/host/README.md) ("Installing from the checkout"); the block
gives the files and the mode.

```bash
cd /srv/makrai/app
install -m 0755 ops/host/makrai-{lib.sh,offsite-copy.sh,restore-test.sh,backup.sh,backup-check.sh} /usr/local/bin/
```

The two new jobs keep logs in `/srv/makrai`. Create them before the first run,
owned by the operator and readable by no one else. Each is created only if it does
not exist, so a log that is already there is not truncated:

```bash
for log in /srv/makrai/offsite-copy.log /srv/makrai/restore-test.log; do
  [ -e "$log" ] || install -m 600 -o <operator> -g <operator> /dev/null "$log"
done
```

A deploy that adds a migration or a policy must not land between 00:00 and 01:10
UTC, or the restore test reports a false mismatch (§6, "Deploy window").

Do not edit the installed copies. A change goes through the repository and is
installed again, and `sha256sum /usr/local/bin/makrai-*.sh` against the same
command run in `ops/host/` says whether the host has drifted.

Each guard in `makrai-backup.sh` carries a comment naming the failure it closes.
Do not remove one without reproducing that failure first.

**Keep the passphrase somewhere other than this server.** The backups are
encrypted with `BACKUP_PASSPHRASE`, which lives in `/srv/makrai/app/.env` on the
machine the backups exist to survive. Lose the machine without a copy of the
passphrase and every backup, off-site ones included, is a file nobody can open.

The owner puts the value in the password manager when it is first set, at a hidden
prompt. No command in this runbook displays it: the server's `.env` is the one
place a command reads it from, and it goes from there to gpg on a file descriptor
(`--passphrase-fd`), never to the terminal. Two checks, both in a terminal outside
any AI session. First, that the server's value opens the newest backup:

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a
gpg --batch --quiet --decrypt --passphrase-fd 3 "$(ls -t /srv/makrai/backups/makrai-*.sql.gz.gpg | head -n 1)" 3<<<"$BACKUP_PASSPHRASE" \
  | gunzip -c | tail -20 | grep -c 'PostgreSQL database dump complete'
```

Second, that the copy in the password manager is the same value. Paste it at the
hidden prompt (nothing is shown):

```bash
read -rs -p 'Passphrase from the password manager: ' pp; echo
gpg --batch --quiet --decrypt --passphrase-fd 3 "$(ls -t /srv/makrai/backups/makrai-*.sql.gz.gpg | head -n 1)" 3<<<"$pp" \
  | gunzip -c | tail -20 | grep -c 'PostgreSQL database dump complete'
unset pp
```

Each prints `1` when the value opens the backup, and `0` when it does not.

**On the trap, and why the previous shape could not work.** `set -e` and a
trailing `if [ $? -eq 0 ]` are mutually exclusive: the first makes the second
unreachable on failure, and on success `$?` is always `0`, so the `else` branch
was dead code in both directions. Every backup either worked, or stopped
writing to the log with no explanation. If you edit `makrai-backup.sh`, keep the
trap and do not reintroduce a post-hoc `$?` check.

### 1.3 Install the crontab

The operator user's crontab is tracked as `ops/host/crontab.operator`. Install it
for that user (it replaces the user's whole crontab, so compare first):

```bash
cd /srv/makrai/app
diff <(crontab -l -u <operator>) ops/host/crontab.operator
crontab -u <operator> ops/host/crontab.operator
```

The schedule, all in UTC:

| UTC | EAT | Script | Reports to |
| --- | --- | --- | --- |
| 00:00 | 03:00 | `makrai-backup.sh` | `HEALTHCHECK_PING_URL` |
| 00:30 | 03:30 | `makrai-offsite-copy.sh` | `HC_OFFSITE_PING_URL` |
| 01:00 | 04:00 | `makrai-restore-test.sh` | `HC_RESTORE_PING_URL` |
| 06:00 | 09:00 | `makrai-backup-check.sh` | none: it checks the backup, whose own check alerts on absence |

Each job has a check of its own, because two jobs sharing one would cover for each
other. `__tests__/lint/dead-man-switches.test.ts` fails if a cron-run script has
none, or shares one.

**These are UTC**, because the server is (`timedatectl` reports `Etc/UTC`). So
the backup runs 03:00 EAT and the check 09:00 EAT, six hours later — far enough
apart that a slow backup is never mistaken for a missing one. If you ever move
the box to local time, both numbers change; the six-hour gap is the thing to
preserve.

`MAILTO` is deliberately **empty**. cron would otherwise try to mail every line
of output to a local mailbox on a machine with no MTA, which goes nowhere and
tells you nothing. Alerting does not depend on it — the scripts send through
Resend, which was verified end to end on 2026-08-29 (HTTP 200 from the real
script, not a hand-written request).

> **Note:** The Hetzner VPS system clock should be set to EAT (`Africa/Kampala`)
> or UTC. If the server is UTC, use `0 0 * * *` instead to match 03:00 EAT.

### 1.6 Alerting

Every guard in §1.2 makes a failure visible **in a log**. On its own that is not
monitoring: the signal for "the backup failed" would be the absence of a line in
a file nobody opens. Two mechanisms close that, and they cover different
failures — you need both.

**A. The script alerts when it fails.** Built into the `cleanup` trap in
`makrai-backup.sh`. It posts to the Resend API using the platform's own verified
sending domain and send-only key, already in `.env` — no new dependency, no new
account. Alerting failure is the one non-zero exit this script deliberately
swallows: if the email cannot go out, that is logged and the original error still
propagates, because an alerting problem must never mask the problem being alerted
about.

**B. A separate check notices when the script did not run at all.** This is the
failure A structurally cannot report — a hung `docker exec`, a broken crontab, a
full disk, a script deleted or made non-executable. In all of those the backup
script produces nothing, including no alert. That is `makrai-backup-check.sh`
(installed in §1.2, scheduled in §1.3), run several hours after the backup so a
slow run is not mistaken for a missing one. The filenames it looks for must be the
ones the backup writes, or it reports NO BACKUPS while backups are fine;
`__tests__/lint/backup-glob-agreement.test.ts` fails if they drift.

**What neither mechanism catches: the machine being down.** Both run *on* the
server, so if it is off or unreachable, both are silent — and silence is what
"healthy" looks like. The dead-man pings in §1.3 close that: each job pings a
check hosted outside the box when it succeeds, and the *absence* of a ping raises
the alarm. That holds only while the check itself is configured, so a job whose
`*_PING_URL` is unset logs a warning that nothing is watching it.

### 1.4 Verify the cron is registered

```bash
crontab -l -u <operator> | grep makrai
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

Compose runs from `/srv/makrai/app/docker` with `--env-file ../.env`, the form
`deployment.md` section 8 uses: the compose file has no `build:` and takes
`WEB_IMAGE` and `MIGRATOR_IMAGE` from `.env`, so without `--env-file` it stops with
"required variable WEB_IMAGE is missing a value", and from any other directory it
addresses a second, empty stack. After a rollback (`deployment.md` section 9.3) these
two lines of `.env` have to name the rolled-back release before 4.4.

### 4.1 Stop the application

```bash
cd /srv/makrai/app/docker

# Stop the Next.js and Nginx containers (keep Postgres running)
docker compose --env-file ../.env -f docker-compose.prod.yml stop nextjs nginx
```

### 4.2 Drop and recreate the database

```bash
cd /srv/makrai/app
source .env

# Drop the existing database
docker exec docker-postgres-1 dropdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"

# Recreate it
docker exec docker-postgres-1 createdb -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

### 4.2a On a FRESH cluster only — create the application roles first

**Skip this when restoring onto the existing server; it is mandatory on a new
one.** This is the disaster-recovery case: new VPS, new Postgres, backup in hand.

`pg_dump` dumps a DATABASE, and the application's database roles are CLUSTER-level
objects. The dump contains the `GRANT ... TO <role>` statements and no
`CREATE ROLE`, so on a cluster where a role does not exist the restore hits
`ERROR: role "<role>" does not exist`.

Demonstrated 2026-08-29 against a throwaway `postgres:16-alpine` cluster, for the
first role the migrations create, `makrai_app` (**11 `GRANT ... TO makrai_app`
statements and zero `CREATE ROLE`** in the dump), both directions:

| | Result |
|---|---|
| Fresh cluster, no role | `exit 3`, `ERROR: role "makrai_app" does not exist` |
| Role created first | `exit 0`, 0 errors, 13 tables, 9 RLS policies |

**The dangerous part is what a hurried operator sees.** Thirteen tables *were*
created before it stopped, so the database looks restored. Every `GRANT` after
the failure was skipped, so the application — which connects as these roles —
can read nothing. And this only surfaces at all because of the
`-v ON_ERROR_STOP=1` in 4.3: without it psql continues past the error and exits
**0**, producing a restore that reports success and has no grants.

The roles are not listed here. They are whatever the migrations create, read from
`prisma/migrations` when you run this, with the same command the nightly restore
test uses (§6), so a role that a later migration adds is created too:

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a
for role in $(grep -hoE 'CREATE ROLE [a-z_]+' prisma/migrations/*/migration.sql | awk '{print $3}' | sort -u); do
  docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN
       CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
     END IF; END \$\$;"
done
```

The attributes are the ones the first migration gives its role
(`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`; `NOBYPASSRLS` above all, since
a role that can bypass row-level security would silently defeat every tenant
boundary in the restored data). A dump does not carry a role's attributes, so
check each against the migration that creates it, and use that migration's
attributes if they differ:

```bash
grep -n -A1 'CREATE ROLE' prisma/migrations/*/migration.sql
```

No password here: **step 4.5a sets them**, after the restore, from `.env`.

---

### 4.3 Restore from the backup file

Backups are encrypted (§1.2), so the restore decrypts first. The passphrase
comes from `.env` and is passed on a file descriptor, never as an argument:

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a

# Replace the filename with the backup you want to restore
gpg --batch --quiet --decrypt --passphrase-fd 3 \
    /srv/makrai/backups/makrai-20260830-000001.sql.gz.gpg 3<<<"$BACKUP_PASSPHRASE" \
  | gunzip -c \
  | docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" "${POSTGRES_DB}"
```

**If you are restoring onto a NEW machine**, `.env` is gone with the old one and
`BACKUP_PASSPHRASE` must come from wherever you stored it offline — see the
warning in §1.2. An encrypted backup and no passphrase is not a backup.

To check a backup without restoring it, decrypt and look for the marker
`pg_dump` writes last:

```bash
gpg --batch --quiet --decrypt --passphrase-fd 3 <file>.gpg 3<<<"$BACKUP_PASSPHRASE" \
  | gunzip -c | tail -20 | grep 'PostgreSQL database dump complete'
```

### 4.4 Run database migrations

This ensures the schema is up to date in case the backup predates recent
migrations. It runs the image `MIGRATOR_IMAGE` in `.env` names: after a rollback that
must be the previous release's migrator (`deployment.md` section 9.3), or it applies the
newer release's migrations to the restored database again.

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml --profile tools run --rm --no-deps migrator
```

### 4.5a On a fresh cluster — give each role its password

The roles created in 4.2a can log in and have no password, so the application
still cannot authenticate. This is the same step as `deployment.md` §6.4, done for
every role in the same derived list rather than for one named role. Each value comes
from the connection URL in `.env` whose user is that role, so it cannot drift from
what the app presents, and goes to psql on stdin, never as an argument (the quoting
is the one `scripts/provision-app-db-role.sh` uses):

```bash
cd /srv/makrai/app
set -a; . ./.env; set +a
for role in $(grep -hoE 'CREATE ROLE [a-z_]+' prisma/migrations/*/migration.sql | awk '{print $3}' | sort -u); do
  pw=$(env | sed -n "s#^[A-Z_]*_DATABASE_URL=[a-z]*://${role}:\([^@]*\)@.*#\1#p" | head -n 1)
  if [ -z "$pw" ]; then echo "no connection URL for ${role} in .env: set its password by hand"; continue; fi
  esc=${pw//\\/\\\\}; esc=${esc//\'/\\\'}
  printf '%s\n%s\n' "\\set pw '${esc}'" "ALTER ROLE ${role} WITH PASSWORD :'pw';" \
    | docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER}" -d "${POSTGRES_DB}"
  unset pw esc
done
```

A role it names with no connection URL has no password until you set one.

---

### 4.5 Restart the application

```bash
cd /srv/makrai/app/docker
docker compose --env-file ../.env -f docker-compose.prod.yml up -d
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

## 5. Off-site copy

A backup on the machine that holds the database is lost with it.
`makrai-offsite-copy.sh` mirrors the encrypted backups to a Hetzner Storage Box
every night at 00:30 UTC, half an hour after the backup.

**What is copied.** Only `makrai-*.sql.gz.gpg`, over `rsync` on SSH port 23, with
`--delete`, so the box holds what the host holds: 30 days.

- The files are already encrypted (§1.2) and the passphrase is not copied. **An
  off-site copy opens only if the passphrase is kept somewhere other than this
  server.**
- `--delete` removes from the box what the backup script's own prune removed here.
  Immediately before `rsync`, and after any wait, the script checks that its list
  holds at least one nightly backup (the exact name
  `makrai-YYYYMMDD-HHMMSS.sql.gz.gpg`, as the restore test judges it) that is not
  one of the files it leaves out as too fresh (below). With none it fails (`/fail`
  and a mail) and does not run `rsync`, so a directory that is empty or unmounted
  (even if it became so during the wait), one holding only a hand-named file, or
  one holding only tonight's still-fresh nightly cannot wipe the box.
- The mirror runs with `--max-delete=3`, so one run removes at most three files
  from the box. A normal night removes one (the backup's own prune). The limit
  trips in three cases: a source that has shrunk without being empty; three or
  more nights without a copy, which leaves four or more pending removals for the
  first run back; and a box that already holds stale leftovers. Then `rsync` stops
  deleting and exits 25, and the run fails (`/fail` and a mail whose subject reads
  `off-site deletions exceeded limit`). A deliberate larger prune is run by hand,
  as the operator user, with `--max-delete` raised for that one run: copy the
  `rsync` command from the script, change the number, run it once, and leave the
  script at 3.
- It waits for a running `makrai-backup.sh`, checking each minute for at most 30
  minutes (a backup writes its file in place and can run for an hour). Still
  running after that is a failure, with `/fail` and a mail. After a wait it sleeps
  a further 125 seconds, so that the file it waited for has aged past the next
  rule.
- It leaves out any backup file modified in the last 2 minutes, and names each in
  the log (`Skipped <file>: ...`). `Off-site copy complete: <n> backup file(s)
  mirrored.` counts only what was mirrored. If the file skipped is the newest
  nightly backup (judged by the exact name `makrai-YYYYMMDD-HHMMSS.sql.gz.gpg`, as
  the restore test does, so a hand-named file never counts as the newest), the run
  fails (`newest backup not copied: still being written`, with
  `/fail` and a mail) and does not ping success. That happens when a backup
  finishes in the two minutes before 00:30 and the copy did not have to wait.
- `rsync` must be installed on the host.

**What it needs.** Names only; the values are in the server `.env` and the owner's
password manager.

| Name | Where | Purpose |
| --- | --- | --- |
| `OFFSITE_TARGET` | `.env` | rsync destination: `<user>@<host>:` (empty path: the sub-account's home, which the Storage Box maps to its base directory) or `<user>@<host>:<directory>/`. Both work; the scripts never add a slash after a bare `:`. |
| `HC_OFFSITE_PING_URL` | `.env` | This job's dead-man check. |
| `~/.ssh/makrai_offsite` | the operator's home | Private key, mode 600, authorised on the Storage Box sub-account. |
| the box's host key | the operator's `~/.ssh/known_hosts` | The copy uses `StrictHostKeyChecking=yes`, so an unknown host key fails the copy instead of being trusted. |

**What it reports.** A ping to `HC_OFFSITE_PING_URL` as its last statement on
success; `/fail` plus a content-free mail on any failure; and, if it never runs,
silence, which the check turns into an alarm. A `.env` that cannot be loaded stops
either job before its failure handler exists, so nothing is pinged and the
dead-man check alerts on the absence. It logs to `/srv/makrai/offsite-copy.log`
(mode 600).

Run it by hand as the operator user. Run the backup and the copy as separate
commands, never chained in one command line: the copy's wait looks for any process
whose command line names `makrai-backup.sh`, which would include its own parent, and
it would wait the full 30 minutes and then fail.

```bash
sudo -u <operator> /usr/local/bin/makrai-offsite-copy.sh; echo rc=$?
tail -n 3 /srv/makrai/offsite-copy.log
```

Expect `rc=0` and `Off-site copy complete` in the log.

**Getting a backup back from the box** (a new machine, with no `.env`): take the
destination (the `OFFSITE_TARGET` value, which ends in `:` or `/`) and the key
from the password manager, then

```bash
rsync -e "ssh -p 23 -i ~/.ssh/makrai_offsite" "<destination>makrai-20261008-000001.sql.gz.gpg" .
```

and continue at §4.3 with the passphrase from the password manager.

---

## 6. Restore test

A backup nobody has restored is a hope. `makrai-restore-test.sh` runs every night
at 01:00 UTC, half an hour after the copy, and restores the newest file **from the
Storage Box**, so the copy that would be used in a disaster is the copy tested.

**What it does, in order:**

1. Lists the box, fetches the newest `makrai-*.sql.gz.gpg` into a mode-700
   temporary directory, and refuses it if it is older than 26 hours
   (`RESTORE_MAX_AGE_MIN=1560`). A stale newest file means the copy has stopped.
2. Starts a throwaway Postgres from the image the live database runs, named
   `makrai-restore-test-<pid>`: no network, data on tmpfs, superuser the
   backup's owner (the dump carries `ALTER ... OWNER TO`), a random password.
3. Creates, `NOLOGIN`, every role a migration creates. A dump holds the `GRANT`s
   but not the `CREATE ROLE` (§4.2a), and the list is read from
   `prisma/migrations` at run time so a new role needs no edit here.
4. Decrypts with the passphrase on file descriptor 3, and loads with
   `ON_ERROR_STOP=1`.
5. Compares with live, using counts only: the number of `public` rows in
   `pg_policies` and the `_prisma_migrations` count must be equal, and `users` and
   `organizations` must each be above 0 in the restored copy (a schema-only dump
   passes the first two).
6. Pings `HC_RESTORE_PING_URL`, or sends `/fail` and a content-free mail. Only a
   run that reached its last statement can pass: a signal (SIGTERM at a host
   shutdown, SIGHUP when an SSH session drops, SIGINT) or an early exit ends as
   `RESTORE MISMATCH interrupted`, with the `/fail` ping and the mail.
7. However it exits, removes the container with `docker rm -fv` and shreds the
   temporary file.

The live database is only read, with a `SELECT` that returns one count.

**What it prints and writes:**

| | |
| --- | --- |
| stdout | Exactly one line: `RESTORE MATCH` or `RESTORE MISMATCH <field>`. Never a row. |
| `/srv/makrai/restore-test.log` | Mode 600. Everything else, including every error, because psql's errors can quote the row that failed to load. A failed comparison also logs the two counts, `live=<n> restored=<n>` (`restored=<n>` alone for `users` and `organizations`). |
| the evidence line | `fetched=<name> age_min=<n>`, logged before the last line. This is what shows that the fresh off-site file was the one tested. |
| the last log line | `Restore test PASSED` or `Restore test FAILED: <field>`. |

`<field>` is `policies`, `migrations`, `users`, `organizations` or `age` for a
failed check, `interrupted` for a run that was stopped, and otherwise the step that
failed: `setup`, `fetch`, `cluster`, `roles`, `restore` or `compare`.

`Ctrl-C` does not reach the steps wrapped in `timeout`, which runs its command in a
process group of its own. A run stopped by hand therefore finishes the step it is
in (up to 15 minutes for the load) before it reports `interrupted`.

Run it by hand as the operator user:

```bash
sudo -u <operator> /usr/local/bin/makrai-restore-test.sh
tail -n 1 /srv/makrai/restore-test.log
docker ps -aq --filter name=makrai-restore-test | wc -l
```

Expect `RESTORE MATCH`, `Restore test PASSED` and `0`.

**Deploy window.** The test compares the restored backup with the live database,
so a change to live after the 00:00 backup shows up as a mismatch at 01:00.

- Do not deploy a migration between 00:00 and 01:10 UTC; a migration added after
  the 00:00 backup makes the 01:00 restore test report MISMATCH migrations.
- Do not deploy a policy change between 00:00 and 01:10 UTC; a policy added or
  removed after the 00:00 backup makes the 01:00 restore test report
  MISMATCH policies.

A mismatch caused this way is cleared by the next night's backup; nothing is wrong
with the backup. Re-run the test by hand after the next 00:00 backup to confirm.

**What it does not show.**

- It compares counts, not contents. A restore with the right counts and wrong
  values would pass.
- The tmpfs holds the whole restored database in memory. Revisit it when the
  database approaches a meaningful share of the host's RAM.
- `__tests__/lint/ops-host-scripts.test.ts` asserts that the script contains the
  strings it should (`--network none`, `SELECT`-only reads of the live container,
  the stale-age limit, and so on). That stops them being edited away; it does not
  show the restore works. The restore run on the server is the proof.

---

## 7. Quick Reference

| Task                  | Command                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Manual backup         | `docker exec docker-postgres-1 pg_dump -U $POSTGRES_USER $POSTGRES_DB \| gzip > /srv/makrai/backups/makrai-$(date +%Y%m%d-%H%M%S).sql.gz` |
| Verify backup         | `gunzip -t /srv/makrai/backups/makrai-YYYYMMDD-HHMMSS.sql.gz`                                                                    |
| List backups          | `ls -lhtr /srv/makrai/backups/makrai-*.sql.gz`                                                                                    |
| Restore               | `gunzip -c /srv/makrai/backups/FILE.sql.gz \| docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER $POSTGRES_DB`                       |
| Check cron            | `crontab -l -u <operator>`                                                                                             |
| View backup log       | `tail -20 /var/log/makrai-backup.log`                                                                                  |
| Prune old backups     | `find /srv/makrai/backups -name "makrai-*.sql.gz" -mtime +30 -delete`                                                             |
| Off-site copy         | `sudo -u <operator> /usr/local/bin/makrai-offsite-copy.sh; echo rc=$?`                                                  |
| Restore test          | `sudo -u <operator> /usr/local/bin/makrai-restore-test.sh` then `tail -n 1 /srv/makrai/restore-test.log`                |
