# Host scripts and configuration

Files that run on, or configure, the production host. They are tracked here so
that the repository can say what the host is running, and so the properties that
matter about them are checked in CI rather than remembered.

`<operator>` is the unprivileged user that owns the cron jobs. No file here names
a real user, a home directory or an address: scripts use `$HOME`, and anything
secret or host-specific is read from the server `.env` (see "Rules").

## Install map

| Repository path | Host path | Owner | Mode | How |
| --- | --- | --- | --- | --- |
| `ops/host/makrai-lib.sh` | `/usr/local/bin/makrai-lib.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/makrai-backup.sh` | `/usr/local/bin/makrai-backup.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/makrai-backup-check.sh` | `/usr/local/bin/makrai-backup-check.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/makrai-offsite-copy.sh` | `/usr/local/bin/makrai-offsite-copy.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/makrai-restore-test.sh` | `/usr/local/bin/makrai-restore-test.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/crontab.operator` | the `<operator>` user's crontab | `<operator>` | set by cron | `crontab -u <operator> ops/host/crontab.operator` |
| `ops/host/daemon.json` | `/etc/docker/daemon.json` | root:root | 0644 | copy; **reference** until changed (below) |
| `ops/host/50unattended-upgrades.local` | `/etc/apt/apt.conf.d/50unattended-upgrades` | root:root | 0644 | **reference only** (below) |
| `ops/host/51makrai-docker-origin` | `/etc/apt/apt.conf.d/51makrai-docker-origin` | root:root | 0644 | `install -m 0644` |
| `ops/host/52makrai-reboot` | `/etc/apt/apt.conf.d/52makrai-reboot` | root:root | 0644 | `install -m 0644` |

Owner and mode are what the command in the last column produces. They are not read
back from the host.

Install the scripts from the server checkout, as root. The two new jobs keep logs
in `/srv/makrai`; create them first, owned by the operator and readable by no one
else, and only if they do not exist, so a log that is already there is not
truncated:

```bash
cd /srv/makrai/app
for log in /srv/makrai/offsite-copy.log /srv/makrai/restore-test.log; do
  [ -e "$log" ] || install -m 600 -o <operator> -g <operator> /dev/null "$log"
done
install -m 0755 ops/host/makrai-{lib.sh,offsite-copy.sh,restore-test.sh,backup.sh,backup-check.sh} /usr/local/bin/
crontab -u <operator> ops/host/crontab.operator
```

`crontab -u` replaces the user's whole crontab, so diff it first. The runbook,
[`docs/runbooks/backup-restore.md`](../../docs/runbooks/backup-restore.md), has the
full procedure, the schedule and what each job reports.

- **`daemon.json`** is a copy of the live file. It carries `"live-restore": true`,
  so containers keep running while the Docker daemon restarts, for example when
  the engine package is upgraded. The file takes effect when the daemon starts,
  and the log options reach only containers created after that, so a change to
  it is a deploy decision, not an `install`.
- **`50unattended-upgrades.local`** holds only the active lines of the live file,
  with comments and blank lines removed. It records the settings in force. Do not
  install it over the real file, which also carries the commented defaults.
- **`51makrai-docker-origin`** is a whole drop-in file, installed as it stands. It
  adds `Docker:noble` to the `Allowed-Origins` list that `50unattended-upgrades`
  sets; a list in a later file appends to the earlier one, so the Ubuntu origins
  stay allowed. Without it, unattended upgrades skip the Docker packages.
  `Docker:noble` is the origin and suite of the Docker apt repository for
  Ubuntu 24.04.
- **`52makrai-reboot`** is a whole drop-in file, installed as it stands. It lets
  unattended upgrades reboot the host at 03:30 UTC when an upgrade needs one, such
  as a new kernel. `live-restore` does not cover a reboot, which stops every
  container.

## What the scripts need on the host

`bash`, `curl`, `python3` (to build the alert payload), `gpg`, `rsync`,
`openssh-client`, GNU coreutils, and for the operator user access to the Docker
socket. In `/srv/makrai/app/.env`: `POSTGRES_USER`, `POSTGRES_DB`,
`BACKUP_PASSPHRASE`, `OFFSITE_TARGET`, `ADMIN_EMAIL`, `RESEND_API_KEY`,
`EMAIL_FROM_ADDRESS`, and one ping URL per job (`HEALTHCHECK_PING_URL`,
`HC_OFFSITE_PING_URL`, `HC_RESTORE_PING_URL`). In the operator's home: the key
`.ssh/makrai_offsite`, and the Storage Box's host key in `.ssh/known_hosts`.

`OFFSITE_TARGET` is `user@host:` (an empty path: the sub-account's home) or
`user@host:dir/`. The scripts accept both and never add a slash after a bare `:`.

`$HOME` must resolve to the operator's home under both cron and `sudo -u
<operator>`. The off-site key path depends on it.

## Rules

Checked by `__tests__/lint/ops-host-scripts.test.ts`,
`__tests__/lint/dead-man-switches.test.ts`,
`__tests__/lint/backup-glob-agreement.test.ts` and, for the config files,
`__tests__/lint/host-config-mirror.test.ts`:

- Every script starts with `set -Eeuo pipefail`.
- A secret reaches a script only through the server `.env`, which the newer
  scripts read with `load_env` from `makrai-lib.sh`. It never reaches argv: no
  `Authorization` header on a command line, and `gpg --passphrase-fd`, never
  `--passphrase`.
- No personal identifier: use `$HOME` in scripts and `<operator>` in documents.
- Every script the crontab runs reports to a dead-man check of its own, and no two
  share one. The one exemption is the backup watchdog, which checks the backup.
- `makrai-restore-test.sh` only reads the live database, with `SELECT`, never
  prints a row, and removes everything it creates.
- The scripts that touch backup files agree on the filename pattern the backup
  writes.
- The config files keep the setting something else depends on: the Docker origin
  is allowed for unattended upgrades, automatic reboot is on at 03:30, and
  `daemon.json` is valid JSON with `live-restore` on and the log size cap kept.

These checks read the scripts as text. They stop a property being edited away
and cannot show that a restore works; the restore run on the server is the proof.
