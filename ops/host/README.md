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
| `ops/host/makrai-email-scan.sh` | `/usr/local/sbin/makrai-email-scan.sh` | root:root | 0755 | `install -m 0755` |
| `ops/host/email-shape.regex` | `/usr/local/sbin/email-shape.regex` | root:root | 0644 | `install -m 0644` |
| `ops/host/crontab.operator` | the `<operator>` user's crontab | `<operator>` | set by cron | `crontab -u <operator> ops/host/crontab.operator` |
| `ops/host/daemon.json` | `/etc/docker/daemon.json` | root:root | 0644 | copy; **reference** until changed (below) |
| `ops/host/50unattended-upgrades.local` | `/etc/apt/apt.conf.d/50unattended-upgrades` | root:root | 0644 | **reference only** (below) |
| `ops/host/51makrai-docker-origin` | `/etc/apt/apt.conf.d/51makrai-docker-origin` | root:root | 0644 | `install -m 0644` |
| `ops/host/52makrai-reboot` | `/etc/apt/apt.conf.d/52makrai-reboot` | root:root | 0644 | `install -m 0644` |
| `ops/host/makrai-break-glass-session` | `/usr/local/sbin/makrai-break-glass-session` | root:root | 0755 | `install -m 0755` (ADR-0010) |
| `ops/host/pam.d-login` | `/etc/pam.d/login` | root:root | 0644 | `install -m 0644`, after checking the live file (ADR-0010) |
| `ops/host/pam.d-sshd` | `/etc/pam.d/sshd` | root:root | 0644 | `install -m 0644`, only after its sha256 matches the reviewed, merged commit's: the checkout is writable by `<operator>` (deployment.md 12.5; ADR-0010) |
| `ops/host/50-makrai-sshd.conf` | `/etc/ssh/sshd_config.d/50-makrai-sshd.conf` | root:root | 0644 | `install -m 0644`, only after the same sha256 check; no other drop-in may set its keywords, since sshd keeps the first value (deployment.md 12.5; ADR-0010) |
| `ops/host/break-glass-notice.txt` | read in place from the server checkout | | | not installed |
| `ops/host/integrity-hash.mjs` | read in place from the server checkout | | | not installed |

Owner and mode are what the command in the last column produces. They are not read
back from the host.

**Installing from the checkout.** `/srv/makrai/app` is owned by, and writable by, `<operator>`.
So every install from it into a root-owned path stages the file first, and installs only the
staged copy:

1. Copy the file into a directory only root can write: `install -d -m 0700 /root/makrai-stage`,
   then `install -m 0600 <checkout file> /root/makrai-stage/<name>`.
2. Compare the staged copy with the reviewed, merged commit's sha256, computed on the
   workstation with `git show <commit>:<path> | sha256sum`. Chain the install to the compare
   with `&&`, so that a hash that differs, or a malformed one, installs nothing:

   ```bash
   printf '%s  %s\n' '<sha256 from the workstation>' /root/makrai-stage/<name> | sha256sum -c --strict && install -m <mode> /root/makrai-stage/<name> <destination>
   ```

   `--strict` is required: without it, sha256sum skips a malformed line, such as a hash typed
   one character short, with a warning, and exits 0.
3. The install takes the staged copy, never the checkout file, with the mode in the table.

This covers every row above that installs from the checkout, `pam.d-login` and the root-run
scripts included, not only the sshd files. The commands below and in the runbooks give the names
and modes; run each through these three steps. Section 12.5 of
[`docs/runbooks/deployment.md`](../../docs/runbooks/deployment.md) shows them as one `&&` chain.

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

`makrai-email-scan.sh` is installed apart, in `/usr/local/sbin`, and its expression file goes
beside it. The script reads `email-shape.regex` from its own directory at run time, so the two
must be installed together; it sources `makrai-lib.sh` from `/usr/local/bin` as the others do.
It is not scheduled yet (Task 22 does that).

```bash
cd /srv/makrai/app
install -m 0755 ops/host/makrai-email-scan.sh /usr/local/sbin/
install -m 0644 ops/host/email-shape.regex /usr/local/sbin/
```

`crontab -u` replaces the user's whole crontab, so diff it first. The runbook,
[`docs/runbooks/backup-restore.md`](../../docs/runbooks/backup-restore.md), has the
full procedure, the schedule and what each job reports.

- **`daemon.json`** is a copy of the live file. Its `"live-restore": true` keeps
  containers running while the Docker daemon restarts, but only across a patch
  release of the engine (the last number in `YY.MM.x`). It does not cover a minor
  or major release. The `51makrai-docker-origin` drop-in lets unattended upgrades
  install the engine, so a minor release will restart the containers briefly.
  They come back by themselves, because the long-running services have
  `restart: unless-stopped`, and the uptime monitor sees the outage. After any
  engine upgrade, check that `docker ps` shows every service up, and if it does
  not, redeploy as in [`docs/runbooks/deployment.md`](../../docs/runbooks/deployment.md)
  section 8.

  The log options take effect when the daemon starts and reach only containers
  created after that. `live-restore` alone is applied with
  `systemctl reload docker`, which does not restart the daemon. Either way, a
  change to this file is a deploy decision, not an `install`.
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
  unattended upgrades reboot the host at 03:30 host time (the host runs UTC) when
  an upgrade needs one, such as a new kernel. `live-restore` does not cover a
  reboot, which stops every container.

## What the scripts need on the host

`bash`, `curl`, `python3` (to build the alert payload), `gpg`, `rsync`,
`openssh-client`, GNU coreutils (and, for the email scan, GNU `grep` and `gzip`), and for the
operator user access to the Docker socket. The email scan reads the system journal and runs
`docker exec`, so it needs an account that can do both (root, or a member of `systemd-journal`
and `docker`). `journalctl` does not fail for an account that cannot read the whole journal:
it shows less, and the scan can refuse only a window with nothing in it. In `/srv/makrai/app/.env`: `POSTGRES_USER`, `POSTGRES_DB`,
`BACKUP_PASSPHRASE`, `OFFSITE_TARGET`, `ADMIN_EMAIL`, `RESEND_API_KEY`,
`EMAIL_FROM_ADDRESS`, and one ping URL per job (`HEALTHCHECK_PING_URL`,
`HC_OFFSITE_PING_URL`, `HC_RESTORE_PING_URL`, and `HC_EMAILSCAN_PING_URL` for the email scan's
`--ping`). In the operator's home: the key
`.ssh/makrai_offsite`, and the Storage Box's host key in `.ssh/known_hosts`.

`OFFSITE_TARGET` is `user@host:` (an empty path: the sub-account's home) or
`user@host:dir/`. The scripts accept both and never add a slash after a bare `:`.

`$HOME` must resolve to the operator's home under both cron and `sudo -u
<operator>`. The off-site key path depends on it.

## Rules

Checked by `__tests__/lint/ops-host-scripts.test.ts`,
`__tests__/lint/dead-man-switches.test.ts`,
`__tests__/lint/backup-glob-agreement.test.ts`, `__tests__/lint/email-scan.test.ts`
and, for the config files, `__tests__/lint/host-config-mirror.test.ts`:

- Every script starts with `set -Eeuo pipefail`, except the console break-glass hook
  `makrai-break-glass-session`, which must never fail a login: it runs every step under
  `timeout`, logs what failed and always exits 0 (ADR-0010).
- A secret reaches a script only through the server `.env`, which the newer
  scripts read with `load_env` from `makrai-lib.sh` (the break-glass hook reads it
  itself, as text, so the console path depends on no other file). It never reaches argv: no
  `Authorization` header on a command line, and `gpg --passphrase-fd`, never
  `--passphrase`.
- No personal identifier: use `$HOME` in scripts and `<operator>` in documents.
- Every SSH login needs the operator key, then a TOTP code. The sshd drop-in requires
  `publickey,keyboard-interactive:pam`, keeps `PermitRootLogin yes` so root can reach the code
  stage, and reads only `.ssh/authorized_keys`. In the sshd PAM stack the code is the only auth
  rule, without `nullok`, and nothing else differs from the live file. No passwordless sudo
  rule is tracked anywhere; that is a guard, and the host itself is checked live.
- Every script the crontab runs reports to a dead-man check of its own, and no two
  share one. The one exemption is the backup watchdog, which checks the backup.
- `makrai-restore-test.sh` only reads the live database, with `SELECT`, never
  prints a row, and removes everything it creates.
- The scripts that touch backup files agree on the filename pattern the backup
  writes.
- The config files keep the setting something else depends on: the Docker origin
  is allowed for unattended upgrades, automatic reboot is on at 03:30, and
  `daemon.json` is valid JSON with `live-restore` on and the log size cap kept.
  The two apt files hold only those settings. A `#clear` or `#include` directive,
  a nested block or any other syntax makes the test fail, because apt would act on
  it and the test cannot follow it.
- `makrai-email-scan.sh` prints only counts. It never shows an address, a log line or what
  psql said, and it refuses to scan (exit 2, `EMPTY-PATTERNS` or `EMPTY-LOG`) rather than
  report a zero it cannot stand behind. Exit 1 means it found something and nothing else; a
  failure of any kind exits 3. It reads the journal of `docker.service` (every container,
  whatever its tag), `sshd`, `sshd-session` and `sudo`, and keeps its working files in
  `/dev/shm`, so the list of account addresses never reaches the disk. The email-shape expression exists once, in
  `email-shape.regex`, and `lib/redact.ts` holds the same text; a test keeps the two equal.

These checks read the files as text. They stop a property being edited away
and cannot show that a restore works; the restore run on the server is the proof.
