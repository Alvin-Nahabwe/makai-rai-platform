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
| `ops/host/integrity-hash.mjs` | `/usr/local/lib/makrai/integrity-hash.mjs`, beside `auditlog.mjs`, which imports it | root:root | 0644 | `install -m 0644`, from the stage (Task 22) |
| `ops/host/makrai-auditlog-ship.sh` | `/usr/local/sbin/makrai-auditlog-ship.sh` | root:root | 0755 | `install -m 0755` (Task 22) |
| `ops/host/makrai-auditlog-reconcile.sh` | `/usr/local/sbin/makrai-auditlog-reconcile.sh` | root:root | 0755 | `install -m 0755` (Task 22) |
| `ops/host/makrai-prefix-export.sh` | `/usr/local/sbin/makrai-prefix-export.sh` | root:root | 0755 | `install -m 0755` (Task 22) |
| `ops/host/crontab.root` | root's crontab | root | set by cron | `crontab /root/makrai-stage/crontab.root`, as root, from the staged copy (Task 22) |
| `ops/host/auditlog.mjs` | `/usr/local/lib/makrai/auditlog.mjs`, mounted read-only into the web image | root:root | 0644 | `install -m 0644`, from the stage (Task 22; T22-3) |
| `ops/host/makrai-synthetic.sh` | `/usr/local/sbin/makrai-synthetic.sh` | root:root | 0755 | `install -m 0755`, from the stage (Task 20b) |
| `scripts/synthetic-journey.mjs` | `/usr/local/lib/makrai/synthetic-journey.mjs`, mounted read-only into a throwaway container of the web image | root:root | 0644 | `install -m 0644`, from the stage (Task 20b) |
| `ops/host/makrai-rotate-secrets.sh` | `/usr/local/sbin/makrai-rotate-secrets.sh` | root:root | 0755 | `install -m 0755`, from the stage, only after `sha256sum -c --strict` (Task 24; section below) |

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
   one character short, with a warning, and exits 0 if any other line in the same input
   matches, as in the two-file chain in deployment.md 12.5. With it, every malformed value
   fails the compare.
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
Root's crontab runs it every night at 02:30 UTC (`crontab.root`, below).

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

## Audit log: ship, reconcile, daily email scan (Task 22)

Root runs four jobs from `crontab.root`, each by absolute path (cron's `PATH` has no
`/usr/local/sbin`), each appending both output streams to its own mode-600 log in
`/var/log/makrai/`, because root's cron mail is not read. The fourth, the hourly synthetic
journey (Task 20b), is not an audit-log job; it has its own section, below:

| When (UTC) | Job | Log | Dead-man check |
| --- | --- | --- | --- |
| 5 past every hour | `makrai-auditlog-ship.sh` | `auditlog-ship.log` | `HC_AUDITSHIP_PING_URL` |
| 7 past every hour | `makrai-synthetic.sh --ping` | `synthetic.log` | `HC_SYNTHETIC_PING_URL` |
| 02:00 | `makrai-auditlog-reconcile.sh` | `auditlog-reconcile.log` | `HC_RECONCILE_PING_URL` |
| 02:30 | `makrai-email-scan.sh --since -26h --ping` | `email-scan.log` | `HC_EMAILSCAN_PING_URL` |

All four run as root and read the server `.env` only as text, key by key (`read_env` in
`makrai-lib.sh`): nothing in that file, which the operator account can write, ever runs as root.
`auditlog.mjs` runs from root's own copy in `/usr/local/lib/makrai`, never from the checkout.

- **The ship** exports, with a journal cursor, the entries of `sshd`, `sshd-session`, `sudo`,
  `sudoedit`, `su`, the executables `/usr/bin/sudo`, `/usr/bin/su` and `/usr/bin/pkexec` under any
  name they were run by, polkit's agent helper `/usr/lib/polkit-1/polkit-agent-helper-1` (it logs
  every polkit authentication failure), `login`, `passwd`, `chpasswd` and the break-glass hook,
  and, by content, every line logged at the authpriv facility (`SYSLOG_FACILITY=10`), whatever
  process journald credits it to (a process that execs right after logging, as pkexec does, is
  credited with the program it ran). That last term ships more: every PAM session and
  authentication line, cron's two lines per job run among them, and polkitd's; a few hundred
  short lines a day on this host. It exports since its last run (26 hours on the first), and
  copies them to the `auditlog` sub-account (`OFFSITE_AUDIT_TARGET`) as
  `auditlog-<UTC time>.journal.gz`. Names never go backwards: the time in a name is the later of
  now and the last name shipped plus one second (kept in `/var/lib/makrai/auditlog-last-name`,
  mode 600, written after each successful upload; without it, the newest name in the spool or on
  the box). A clock that stepped back therefore names its file just after the previous one, and
  retention, which goes by name, does not take it early. The reconcile fetches that file, but its
  lines carry the wrong clock and are NOT checked against the window; the hold makes the owner
  review them (part C). After a forward jump, names stay after the jumped ones until the real
  time passes them. A failed copy keeps the file in `/var/lib/makrai/auditlog-spool`
  for the next run. It then deletes from the box what is more than 90 days old by its name
  (`expiredNames()` in `auditlog.mjs`, run in the web image), the oldest first and at most 60 a
  run, so a backlog drains over a few hours. It deletes nothing, and fails, on evidence that the
  clock is wrong: a file on the box dated after today ("the clock is behind"), or an expired file
  dated within 3 days of the newest one shipped before this run ("the clock jumped forward"). A
  clock-forward refusal also writes `/var/lib/makrai/auditlog-delete-hold` (mode 600, the reason
  and the UTC time): while it exists the ship still uploads every hour, but deletes nothing,
  pings `/fail`, and mails once a day. Only the owner removes it (part C). The hold file keeps
  every reason, one line each with its UTC time (a reason already in it is not written again).
  Three more checks write the same hold, so that no file shipped after a clock jump can pass for
  evidence of the clock: a run more than 3 days after the last fully successful one (kept in
  `/var/lib/makrai/auditlog-last-run`), or more than an hour before it, checked before anything
  is uploaded; a gap of more than 3 days between consecutive `auditlog-` names on the box
  (those not dated after now) whose later name is dated in the last 93 days, measured against the
  name before it however old, so a jump of more than 93 days is still a gap; and a name moved
  ahead of the clock by more than an hour (the last name shipped is that far ahead of it), which
  needs no last-run time, and adds its reason, "the clock jumped back: this run's name was moved
  ahead of the clock by <n> s", to a hold that already stands. That one also fires after a
  forward jump has been corrected: a clock fault always gets the owner's review. So a legitimate
  outage of more than 3 days also needs the owner to clear the hold; a gap that ends at or before
  the owner's last clearing (`/var/lib/makrai/auditlog-hold-cleared`, written by the clear
  command in part C) no longer holds, and a new one after it does. Its log line is
  `shipped=<n> deleted=<n> pending=<n>`, or `shipped=<n> deleted=0 held=1` under a hold.
- **The reconcile** works over a window kept in `/var/lib/makrai/auditlog-state` (mode 600,
  written only after a run that passed): `checked_until=<time> seq=<n> hash=<hex>`, the instant up
  to which it flagged and the last integrity row it verified. Each night it starts at the earlier
  of `checked_until` minus 5 minutes and 26 hours ago, so a night that failed or did not run is
  caught up by the next one that passes; it ends at the newest shipped file's time, which must be
  within the last 26 hours whatever the start, or the run fails ("the ship has stopped"). It
  fetches the shipped files of that span (and the newest one before it), reads the
  `integrity_log` rows as one contiguous seq range, from the row after the stored seq or from the
  first row dated in the span, whichever is lower, to the last,
  `/etc/makrai/allowed-keys.fp`, `ssh-two-factor-since` and `ssh-verbose-since`, and runs
  `auditlog.mjs` in the web image (`WEB_IMAGE`, offline). It pairs console logins with
  break-glass entries across everything fetched, but flags only what is at least 5 minutes
  before the newest file's time; that tail is checked again the next night. The chain is checked
  continuously from the stored row, over neighbouring rows only, however a clock step has ordered
  their times: the first row read must link to the row before it, the row at the stored seq must
  still carry the stored hash, and `max(seq)` may never go down: each failure counts in
  `chainBreaks`. A row at or below the stored seq that is outside the window counts for nothing
  but the chain. `operatorSessions` and `rootPasswordChanges` count only what
  is after the stored `checked_until`, so two nights never report the same event.
  `sudoToRoot` is elevation to root, or an attempt at it, by a non-root user, via sudo,
  sudoedit, su, pkexec or polkit: a sudo or sudoedit command line naming `USER=root`; a `sudo`, `sudo-i`,
  `su`, `su-l` or `polkit-1` PAM session opened for root (`polkit-1` is pkexec's own, logged even
  when its command line is too large to send); a failed `su` (its `pam_unix(su:auth)` failure or
  `FAILED SU (to root)`); a pkexec line naming `[USER=root]`; or any polkit authentication
  failure (`pam_unix(polkit-1:auth)`, from the agent helper), whoever it names: nothing on this
  headless server should ever authenticate through polkit; or polkitd's `successfully
  authenticated as unix-user:root` for a subject that is not root (or whose owner the line does
  not give). The caller is non-root by its uid where the line gives one. The PAM lines, `FAILED SU`
  and polkitd's are read by their content from every shipped line, whatever process journald
  credits them to; sudo's command lines by sudo's executable, name or syslog identity; so a
  renamed link, or a program run straight after the line was logged, hides nothing. cron's,
  systemd's and sshd's own root sessions are not elevations and do not count. A row read because its seq is above the
  stored one is held to the login and shipped-line checks whatever its time, and one dated before
  the window counts in `backdatedRows`, which fails, and one dated after now (a clock that ran
  ahead wrote it) in `futureRows`, which fails too. A shipped file named after now + 5 minutes
  is left out of the window and the freshness check, and counted in `futureNamedFiles`. A start more than
  8 days back fails ("state too old; run with --since"); see part C for the catch-up. Its log
  ends with one counts line:

  ```text
  records=<n> rows=<n> matched=<n> consoleLoginsWithoutEntry=<n> entriesWithoutLogin=<n> unknownKeyLogins=<n> singleFactorLogins=<n> chainBreaks=<n> hashMismatches=<n> noticeFailures=<n> sudoToRoot=<n> operatorSessions=<n> rootPasswordChanges=<n> rowsWithoutShipped=<n> preVerboseLogins=<n> backdatedRows=<n> futureRows=<n> futureNamedFiles=<n>
  ```

  Every field except `records`, `rows`, `matched`, `operatorSessions`, `rootPasswordChanges`,
  `preVerboseLogins` and `futureNamedFiles` must be 0. It exits 1, with `/fail` and the mail's subject reading `FAILED`,
  when a failure field is not 0, and 3, with `/fail` and no counts, when it could not reconcile
  at all: `WEB_IMAGE` empty or not pinned by digest, the state unreadable or too old, no shipped
  file in the window, the box, psql or a file unreadable.
- **Logins and keys.** After Task 23's switch a login must show the operator key (a `Partial
  publickey` line with an allowed fingerprint) and then the code. Before `LogLevel VERBOSE` went
  in (`/etc/makrai/ssh-verbose-since`, written by part A), sshd logged such a login as one
  `Accepted keyboard-interactive/pam` line with no key: those count in `preVerboseLogins`,
  reported and never failing. From the marker on, the same line is a login that skipped the key:
  `singleFactorLogins`, and its missing key `unknownKeyLogins`. An `Accepted publickey` login
  after the switch is always single-factor.
- **Key rotation.** `/etc/makrai/allowed-keys.fp` holds one `SHA256:<fp> <label>` per line, and a
  line may end with `until=<YYYY-MM-DDTHH:MM:SSZ>`: the key is allowed for the logins before that
  time, and for good when the line has none. When an SSH key is replaced, keep the retired key's
  line and add `until=<the UTC time it was removed from authorized_keys>` to it (take the time
  with `date -u +%FT%TZ` when the key comes out). Without the line, each login the old key made
  before the removal counts in `unknownKeyLogins`, and so does any login at or after the `until`
  time. Delete the line only when both hold: at least 26 hours have passed since its `until`
  time, and a reconcile has passed since the removal, meaning `checked_until` in
  `/var/lib/makrai/auditlog-state` is more than 5 minutes after the `until` time. The first alone
  is not enough: a night that failed or did not run stores no state, so the next window still
  starts before the removal, the old key's earlier logins are in it, and without the line they
  fail every night until it is put back. Keeping the line longer costs nothing: a login at or
  after the `until` time is flagged whether the line is there or not. An `until=` that is not
  exactly a real UTC second (a date alone, a zone offset, fractional seconds) makes its line
  invalid: the key is not allowed, so its logins fail as unknown keys, and the reconcile still
  runs. Any other line that is not the format stops the reconcile (exit 3). The window-close
  access baseline (deployment.md 12.2) hashes `allowed-keys.fp`, so each of the two edits, the
  `until=` and the deletion, is an expected baseline change, re-recorded by the owner's decision.
- **The email scan's** log ends with `patterns=<n> account_hits=<n> shape_hits=<n> shape_hits_nginx=<n> shape_hits_sshd=<n>`.
  Address-shaped strings in the nginx container's lines (any client can put one in a request path)
  count in `shape_hits_nginx` and never fail the run; so do those in sshd's and sshd-session's lines
  (any client can send an address-shaped username, and sshd logs it), in `shape_hits_sshd`. An account
  address anywhere, and an address shape anywhere else, do fail it. A line is nginx's only with both
  its container name and the trusted `_SYSTEMD_UNIT=docker.service`, and sshd's only when its record's
  trusted `_COMM` is `sshd` or `sshd-session`; the other sources are counted directly, never as
  everything minus one of them. systemd unit names (`user@<uid>.service`, `getty@<tty>.service`: an `@`
  token whose domain ends in `.service`, `.socket`, `.timer`, `.target`, `.mount`, `.slice`, `.scope`,
  `.path`, `.device` or `.swap`, as a whole token) are not addresses: they are removed from each line
  before any shape count, never before `account_hits`. A line holding a unit name and a real address
  shape still counts. The new field is appended, so a reader of the first four still works.

**Off-host integrity.** What makes the shipped files trustworthy is the Storage Box's own
snapshots (daily, 10 kept; Task 5), which the owner controls from the Hetzner account and the
host cannot change. The host's audit-log key can write and delete files on the `auditlog`
sub-account: a root compromise could delete or rewrite what was shipped there since the last
snapshot. That residual risk is recorded for Task 25 (S1).

### Installing it (step 3 and 4 of Task 22)

The owner runs every command here, as root, inside an approval window, in a terminal outside
the Claude app. Each file goes through the staged install above: copied into `/root/makrai-stage`,
compared with the reviewed commit's sha256 computed on the workstation, and installed from the
stage. `<commit>` is that reviewed commit; the agent supplies the hashes:

```bash
for f in 50-makrai-sshd.conf makrai-lib.sh makrai-email-scan.sh email-shape.regex makrai-backup.sh makrai-backup-check.sh makrai-auditlog-ship.sh makrai-auditlog-reconcile.sh makrai-prefix-export.sh crontab.root auditlog.mjs integrity-hash.mjs; do printf '%s ' "$f"; git show "<commit>:ops/host/$f" | sha256sum; done
```

**A. `LogLevel VERBOSE`, first and on its own.** It needs nothing else, and goes in before part
C. The chain, in the form of deployment.md 12.5 with this one file, ends by recording when the
reload happened in `/etc/makrai/ssh-verbose-since`, as Task 23 recorded the switch: logins
before that time, the window that installs it included, are reported as `preVerboseLogins`.

```bash
test -f /srv/makrai/app/ops/host/50-makrai-sshd.conf \
  && install -d -m 0700 /root/makrai-stage \
  && install -m 0600 /srv/makrai/app/ops/host/50-makrai-sshd.conf /root/makrai-stage/50-makrai-sshd.conf \
  && printf '%s  %s\n' '<50-makrai-sshd.conf sha256>' /root/makrai-stage/50-makrai-sshd.conf | sha256sum -c --strict \
  && install -m 0644 /root/makrai-stage/50-makrai-sshd.conf /etc/ssh/sshd_config.d/50-makrai-sshd.conf \
  && sshd -t && systemctl reload ssh && date -u +%FT%TZ > /etc/makrai/ssh-verbose-since
```

- Post-check: `sshd -T | grep '^loglevel '` prints `loglevel VERBOSE`, and
  `cat /etc/makrai/ssh-verbose-since` prints the reload's time. Then, after a NEW login, record
  the shape of its two lines, with the address (of either family), port and fingerprint masked:

  ```bash
  journalctl _COMM=sshd --since -15min -o short | grep -E ': (Partial|Accepted) ' | sed -E 's/ from [^ ]+ port [0-9]+/ from <ip> port <port>/; s/SHA256:[A-Za-z0-9+\/]+/SHA256:<fp>/'
  ```

  Expect, on one `sshd[<pid>]`, `Partial publickey for root from <ip> port <port> ssh2: ED25519 SHA256:<fp>`,
  then `Accepted keyboard-interactive/pam for root from <ip> port <port> ssh2`. If the real lines
  differ, the fixtures in `__tests__/unit/auditlog.test.ts` are corrected before merge (R22-1). The
  lines recorded for the first login on 2026-10-14 are pinned there (`VERBOSE_LOGIN`): on the sshd
  pid, `Accepted key ED25519 SHA256:<fp> found at /root/.ssh/authorized_keys:1` twice, then the
  partial line and the final accepted line; on another pid, `Accepted google_authenticator for root`
  (syslog identity `sshd(pam_google_authenticator)`). The extra lines are not logins.
- The access baseline (deployment.md 12.2) hashes `/etc/ssh/sshd_config.d/*.conf`, so its
  recorded value changes here and is re-recorded in this window, by the owner's decision.
- Rollback: the previous drop-in is this one's first nine lines.
  `head -n 9 /etc/ssh/sshd_config.d/50-makrai-sshd.conf > /root/makrai-stage/50-makrai-sshd.conf.prev`,
  check it against the previous commit's sha256 with `sha256sum -c --strict` as above, install it
  with `install -m 0644`, then `sshd -t && systemctl reload ssh && rm -f /etc/makrai/ssh-verbose-since`.

**B. The audit-log key and the sub-account's host key (step 3).** The key is root's own and
reaches only the `auditlog` sub-account. Pin the host key before anything connects with it
(R22-4): scan it, and add it to `known_hosts` only if its fingerprint is the one Hetzner
publishes for Storage Boxes (Hetzner Docs, Storage Box, SSH host keys). The append is chained to
the comparison, so a key that differs is never trusted, and the password prompt that follows is
never answered over an unchecked connection. Put the published `SHA256:` value in place of the
placeholder:

```bash
install -d -m 0700 /root/makrai-stage
ssh-keygen -t ed25519 -N '' -C makrai-auditlog -f /root/.ssh/makrai_auditlog
ssh-keyscan -p 23 -t ed25519 <auditlog-host> > /root/makrai-stage/auditlog-hostkey
ssh-keygen -lf /root/makrai-stage/auditlog-hostkey | grep -qF '<published SHA256>' && cat /root/makrai-stage/auditlog-hostkey >> /root/.ssh/known_hosts
```

Then, only if `ssh-keygen -F '[<auditlog-host>]:23'` now finds the key:

```bash
ssh -p 23 -o StrictHostKeyChecking=yes <auditlog-user>@<auditlog-host> install-ssh-key < /root/.ssh/makrai_auditlog.pub
ssh -p 23 -i /root/.ssh/makrai_auditlog -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/.ssh/known_hosts <auditlog-user>@<auditlog-host> ls
```

`install-ssh-key` asks for the sub-account's password from the password manager, at its prompt.
The last command must list the directory without any prompt. This key can write and delete on
the sub-account; the Storage Box snapshots, not the key, are what the host cannot undo (above).

**C. The scripts, root's copy of `auditlog.mjs`, and root's crontab (step 4).** It cannot run
before Task 18's first deploy writes `WEB_IMAGE`. The owner first adds `HC_AUDITSHIP_PING_URL` (an
hourly check) and `HC_RECONCILE_PING_URL` (a daily one) to the server `.env` with SETENV;
`HC_EMAILSCAN_PING_URL` is there from Task 12, its check set to daily.

Pre-check, which prints counts and status only:

```bash
crontab -l 2>&1 | head -1
journalctl --disk-usage
grep -c '^WEB_IMAGE=.*@sha256:[0-9a-f]\{64\}"\{0,1\}$' /srv/makrai/app/.env
grep -cE '^(OFFSITE_AUDIT_TARGET|HC_AUDITSHIP_PING_URL|HC_RECONCILE_PING_URL|HC_EMAILSCAN_PING_URL)=.' /srv/makrai/app/.env
test -r /root/.ssh/makrai_auditlog && echo key-present
test -s /etc/makrai/ssh-verbose-since && echo verbose-marker
```

Expect `no crontab for root` (anything else: stop and show the diff), then `1` and `4`,
`key-present` and `verbose-marker`. Then one chain. It also reinstalls every live script this
branch changed (R-2): `makrai-lib.sh` (the live copy predates Task 12's alert fix and echoes
Resend's reply, and the new jobs need its `AUDITLOG_SSH`, `read_env` and `report`: R22-5),
`makrai-email-scan.sh` (the nginx count, R22-3, the text reader, and the sshd count and unit-name rule, T22c-1), and `makrai-backup.sh` and
`makrai-backup-check.sh` (`python3 -I`). The sshd drop-in, the other changed file, went in at
part A. `auditlog.mjs` and the `integrity-hash.mjs` it imports go
to `/usr/local/lib/makrai`, root's, from which the jobs mount them (T22-3).

A host that already ran this part gets T22c-1's script, and only that script (`email-shape.regex` is
unchanged), by the staged install in **Installing from the checkout**, above: copy it into
`/root/makrai-stage`, `sha256sum -c --strict` it against the reviewed commit's hash computed on the
workstation, and install the staged copy to `/usr/local/sbin`, mode 0755.

```bash
test -f /srv/makrai/app/ops/host/crontab.root \
  && install -d -m 0700 /root/makrai-stage \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-lib.sh /root/makrai-stage/makrai-lib.sh \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-email-scan.sh /root/makrai-stage/makrai-email-scan.sh \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-backup.sh /root/makrai-stage/makrai-backup.sh \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-backup-check.sh /root/makrai-stage/makrai-backup-check.sh \
  && install -m 0600 /srv/makrai/app/ops/host/email-shape.regex /root/makrai-stage/email-shape.regex \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-auditlog-ship.sh /root/makrai-stage/makrai-auditlog-ship.sh \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-auditlog-reconcile.sh /root/makrai-stage/makrai-auditlog-reconcile.sh \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-prefix-export.sh /root/makrai-stage/makrai-prefix-export.sh \
  && install -m 0600 /srv/makrai/app/ops/host/crontab.root /root/makrai-stage/crontab.root \
  && install -m 0600 /srv/makrai/app/ops/host/auditlog.mjs /root/makrai-stage/auditlog.mjs \
  && install -m 0600 /srv/makrai/app/ops/host/integrity-hash.mjs /root/makrai-stage/integrity-hash.mjs \
  && printf '%s  %s\n' '<makrai-lib.sh sha256>' /root/makrai-stage/makrai-lib.sh '<makrai-email-scan.sh sha256>' /root/makrai-stage/makrai-email-scan.sh '<makrai-backup.sh sha256>' /root/makrai-stage/makrai-backup.sh '<makrai-backup-check.sh sha256>' /root/makrai-stage/makrai-backup-check.sh '<email-shape.regex sha256>' /root/makrai-stage/email-shape.regex '<makrai-auditlog-ship.sh sha256>' /root/makrai-stage/makrai-auditlog-ship.sh '<makrai-auditlog-reconcile.sh sha256>' /root/makrai-stage/makrai-auditlog-reconcile.sh '<makrai-prefix-export.sh sha256>' /root/makrai-stage/makrai-prefix-export.sh '<crontab.root sha256>' /root/makrai-stage/crontab.root '<auditlog.mjs sha256>' /root/makrai-stage/auditlog.mjs '<integrity-hash.mjs sha256>' /root/makrai-stage/integrity-hash.mjs | sha256sum -c --strict \
  && install -m 0755 /root/makrai-stage/makrai-lib.sh /usr/local/bin/makrai-lib.sh \
  && install -m 0755 /root/makrai-stage/makrai-email-scan.sh /usr/local/sbin/makrai-email-scan.sh \
  && install -m 0755 /root/makrai-stage/makrai-backup.sh /usr/local/bin/makrai-backup.sh \
  && install -m 0755 /root/makrai-stage/makrai-backup-check.sh /usr/local/bin/makrai-backup-check.sh \
  && install -m 0644 /root/makrai-stage/email-shape.regex /usr/local/sbin/email-shape.regex \
  && install -m 0755 /root/makrai-stage/makrai-auditlog-ship.sh /usr/local/sbin/makrai-auditlog-ship.sh \
  && install -m 0755 /root/makrai-stage/makrai-auditlog-reconcile.sh /usr/local/sbin/makrai-auditlog-reconcile.sh \
  && install -m 0755 /root/makrai-stage/makrai-prefix-export.sh /usr/local/sbin/makrai-prefix-export.sh \
  && install -d -m 0755 /usr/local/lib/makrai \
  && install -m 0644 /root/makrai-stage/auditlog.mjs /usr/local/lib/makrai/auditlog.mjs \
  && install -m 0644 /root/makrai-stage/integrity-hash.mjs /usr/local/lib/makrai/integrity-hash.mjs \
  && install -d -m 0700 /var/lib/makrai /var/log/makrai \
  && { [ -e /var/log/makrai/auditlog-ship.log ] || install -m 0600 /dev/null /var/log/makrai/auditlog-ship.log; } \
  && { [ -e /var/log/makrai/auditlog-reconcile.log ] || install -m 0600 /dev/null /var/log/makrai/auditlog-reconcile.log; } \
  && { [ -e /var/log/makrai/email-scan.log ] || install -m 0600 /dev/null /var/log/makrai/email-scan.log; } \
  && crontab /root/makrai-stage/crontab.root
```

Post-check: one run of each job, exactly as the crontab runs it, then the box and the logs.

```bash
/usr/local/sbin/makrai-auditlog-ship.sh >> /var/log/makrai/auditlog-ship.log 2>&1; echo rc=$?
bash -c '. /usr/local/bin/makrai-lib.sh && read_env OFFSITE_AUDIT_TARGET && re="^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:([A-Za-z0-9._-]+/)*$" && [[ $OFFSITE_AUDIT_TARGET =~ $re ]] && rsync --list-only -e "$AUDITLOG_SSH" -- "$OFFSITE_AUDIT_TARGET"' | grep -c 'auditlog-.*\.journal\.gz$'
/usr/local/sbin/makrai-auditlog-reconcile.sh >> /var/log/makrai/auditlog-reconcile.log 2>&1; echo rc=$?
/usr/local/sbin/makrai-email-scan.sh --since -26h --ping >> /var/log/makrai/email-scan.log 2>&1; echo rc=$?
tail -n1 /var/log/makrai/auditlog-ship.log /var/log/makrai/auditlog-reconcile.log /var/log/makrai/email-scan.log
stat -c '%a %n' /var/log/makrai/*.log /var/lib/makrai/auditlog-state
```

Expect `rc=0` three times; at least one shipped file on the box; the reconcile's counts line with
every failure field `0` and `matched` equal to the `break_glass.open` entries of the window
(logins from before part A appear in `preVerboseLogins`, which does not fail); `account_hits=0
shape_hits=0` from the scan; `600` on each log and on the state file; and the three checks up.
From now on the reconcile's report mail arrives **every night**, passing or not, its subject
carrying `operatorSessions=<n>` and `rootPasswordChanges=<n>` for the owner to read. A root
password reset through Hetzner's guest agent is believed, but not verified, to run `chpasswd`
and so to appear in `rootPasswordChanges`; the Hetzner account's 2FA is the control either way
(F-30).

**Clearing a delete hold.** When the ship has written `/var/lib/makrai/auditlog-delete-hold`,
it deletes nothing until the owner, having checked the clock, clears it. The file holds the
reasons, one line each: the clock jumped forward or back, a run more than 3 days after the last
good one, a gap between shipped files, or a name moved ahead of the clock. The first alert of a gap or clock-forward hold carries the reason
itself; after that, and from the start for a hold written before the upload (a run too long
after, or before, the last good one, or a name moved ahead of the clock), while the hold stands, each daily alert says only that
remote deletes are held and names the file. First read the reason and check the clock:

```bash
cat /var/lib/makrai/auditlog-delete-hold
timedatectl show -p NTPSynchronized -p TimeUSec
date -u
```

Then clear it. The command removes the hold; removes the alert mark and the last-run time, which
no held run ever moves (left in place, the last-run time would set the hold again at the next
run), with `rm -f` because either may be absent; and records the time of the clearing in
`/var/lib/makrai/auditlog-hold-cleared` (mode 600, written whole), so that a gap between shipped
files that ends at or before it no longer holds:

```bash
rm /var/lib/makrai/auditlog-delete-hold \
  && rm -f /var/lib/makrai/auditlog-delete-hold.alerted /var/lib/makrai/auditlog-last-run \
  && install -m 0600 /dev/null /var/lib/makrai/auditlog-hold-cleared.next \
  && date -u +%FT%TZ > /var/lib/makrai/auditlog-hold-cleared.next \
  && mv -f /var/lib/makrai/auditlog-hold-cleared.next /var/lib/makrai/auditlog-hold-cleared
```

Use it only once `date -u` is right and NTP is synchronised, and, after a clock jump, only once
no shipped file is dated after today (below) and no shipped file is named more than an hour after
`date -u`. Otherwise the next run sets the hold again; after a corrected forward jump that lasts
until real time is within an hour of the newest name. The review applies to EVERY hold whose
reasons include "the clock jumped back" or "a gap of", and to any "the clock is behind" alert
(which writes no hold: review the file shipped by the run that sent the alert, and every file
shipped after it while the clock was wrong, which are the newest names on the box). After a "the clock jumped back" hold, as after
the others, the owner first reviews the files shipped while the hold stood: their journal lines
carry the wrong clock, so the reconcile, which reads each line by its own time, does not check
them. Before clearing, review the files shipped while the hold stood, which the hold file and name
order give: names never go backwards, so they are the newest files on the box, as many as the
`shipped=<n>` counts of the `held=1` lines in `/var/log/makrai/auditlog-ship.log` since the hold
was written. Each is `journalctl -o export` text, gzipped. A real outage of more than 3 days, once cleared,
stops blocking deletes; a new gap that ends after the clearing (a new outage, or a new jump) sets
the hold again. Without a hold to remove, the first `rm` fails and nothing is recorded.

**Retention after a forward clock jump (R-1).** Files shipped while the clock ran ahead keep the
dates it gave them. Until the real date passes those names, the ship refuses every delete ("a
file on the box is dated after today"), so retention pauses and evidence is kept longer than 90
days. That is deliberate. Shipped files are never deleted by hand: they are the evidence, and
the pause ends by itself.

**Catching up by hand.** When the reconcile fails with `state too old; run with --since` (no
passing run for over 8 days), or when the owner wants more checked again, run it once with an
explicit start, then let cron continue from the state it stores. The start may be earlier than
the stored `checked_until`, never later: a later one is refused, since it would leave the time
between unchecked.

```bash
/usr/local/sbin/makrai-auditlog-reconcile.sh --since <YYYY-MM-DDTHH:MM:SSZ> >> /var/log/makrai/auditlog-reconcile.log 2>&1; echo rc=$?
```

The start must be no older than the shipped files kept on the box (90 days).

**After `futureRows` (an integrity row dated after now).** A row written while the clock ran
ahead fails every night (`futureRows=1`) until the real date passes the row's time, and the
state it would have stored stays where it was, so after 8 nights the run also says `state too
old; run with --since`. Once the real date has passed the row, run the reconcile once with
`--since <the stored checked_until, or earlier>` (the time in `/var/lib/makrai/auditlog-state`).
A `--since` later than the stored `checked_until` is refused by design. The row is then in the
band, and the files fetched from that start hold its login and shipped line.

**pkexec and polkit: advice, not a step.** pkexec is not installed on the server (checked 2026-10-14):
`dpkg -s pkexec` reports it absent, and `/usr/bin/pkexec` does not exist. `polkitd` is installed,
as a dependency, with `libpolkit-agent-1-0`, and its agent helper is setuid; the reconcile counts
polkit's authentications (above). If nothing on the host uses polkit (`apt-cache rdepends
--installed polkitd` lists what depends on it), the owner may choose to remove it: one less way
to act with root's authority. That is the owner's decision, in its own approval window; nothing
in this install depends on it either way.

Rollback: `crontab -r` (root's), then remove the three new scripts from `/usr/local/sbin` and the
two files from `/usr/local/lib/makrai`, and reinstall the previous commit's `makrai-lib.sh`,
`makrai-email-scan.sh`, `makrai-backup.sh` and `makrai-backup-check.sh` through the same staged
chain.

### The journal from before the fix (step 5)

`makrai-prefix-export.sh <R>`, as root, once, with Task 12's cut-over time. It writes one
`pre-fix-<YYYY-MM-DD>.json.gz` per day from the oldest entry to R, with every line removed that
holds an account address, an address shape, or a field journalctl could only print as bytes, and
invitation tokens replaced by `[token]`; then `makrai-email-scan.sh --file` must find nothing in
each file, or nothing is shipped. It ships them to the box, removes the local copies, and prints
counts only: `patterns=<n>`, one `pre-fix-<day> lines=<n> kept=<n> removed=<n>` per day, then
`days=<n> shipped=<n>`. The ship's prune deletes each day's file once its date is more than 90
days old.

## What the scripts need on the host

`bash`, `curl`, `python3` (to build the alert payload, and for the email scan to tell the nginx
container's and sshd's lines apart), `gpg`, `rsync`,
`openssh-client`, GNU coreutils (and, for the email scan, GNU `grep` and `gzip`), and for the
operator user access to the Docker socket. The audit-log jobs also use `flock` (util-linux),
`awk`, `base64`, `journalctl` and `docker`, as root, and the email scan `systemd-analyze` (to
resolve `--since` once). The email scan reads the system journal and runs
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

The audit-log jobs also need, in the server `.env`: `OFFSITE_AUDIT_TARGET` (the `auditlog`
sub-account, in the same two shapes as `OFFSITE_TARGET`), `WEB_IMAGE` (the deployed web image,
pinned by digest; Task 18), `HC_AUDITSHIP_PING_URL` and `HC_RECONCILE_PING_URL`; in `/root/.ssh`:
the key `makrai_auditlog`, and the sub-account's host key in `known_hosts`; and in `/etc/makrai`:
`allowed-keys.fp`, and from Task 23's switch on, `ssh-two-factor-since`.

The hourly synthetic journey (Task 20b) also needs `docker`, `flock` and `timeout`, as root; in the
server `.env`: `SYNTHETIC_EMAIL`, `SYNTHETIC_PASSWORD`, `SYNTHETIC_ORG_SLUG`,
`SYNTHETIC_ASSESSMENT_ID` and `HC_SYNTHETIC_PING_URL`; and in `/usr/local/lib/makrai`,
`synthetic-journey.mjs`, installed from the stage. `BASE_URL` is not a key: it is a literal in the
script. `SYNTHETIC_PASSWORD` is letters and digits only, and at least 24 of them (see Rules).

The secret rotation (Task 24) runs as root and also needs `openssl`, `gpg`, `gunzip`, `sudo`, `flock`,
`shred`, `journalctl`, `rsync` (only to list the Storage Box) and `git` (run as `<operator>`), the
checkout at a release whose `scripts/provision-app-db-role.sh` it pins, and `/root/makrai-stage`.

## Hourly synthetic journey (Task 20b)

GitHub's `schedule` runs this repository's workflows hours late or not at all, and the project
publishes `"syntheticJourneyInterval": "PT1H"` (`public/service-parameters.json`). So root's
crontab runs the journey, at 7 past every hour: `makrai-synthetic.sh --ping`, appending both
streams to `/var/log/makrai/synthetic.log`. The journey signs in to `https://makrai.org` as the
synthetic account, saves that account's in-progress assessment and reads it back
(`scripts/synthetic-journey.mjs`, root's copy in `/usr/local/lib/makrai`), in a throwaway
container built from the image the live web container `docker-nextjs-1` is running. The request
leaves the host and comes back through public DNS, Cloudflare, nginx, Next.js and Postgres, like
any user's. The log has one `step=<name> status=<code>` line per step (a failed step adds
`reason=<code>`) for each attempt, because a failed first attempt is tried once more after 60
seconds, and it ends with `result=pass|fail at=<UTC time>`. Run without `--ping`, the script does
the same and sends nothing: a hand run says nothing about whether the schedule is alive. Do not
hand-run it between :05 and :12, so that a hand run does not hold the lock when the cron run
arrives. A run that finds the lock taken prints `waiting for the lock` and waits for up to 500
seconds, which is longer than the longest run, so a collision delays the ping and raises no false
alarm; stopping a run that is waiting (Ctrl-C) is safe, because only a run that holds the lock
removes the container. Every docker call the script makes is bounded, so a wedged Docker daemon is
a `/fail` within minutes and not silence.

**The check.** During the soak the job pings the healthchecks check `makrai-synthetic-host`
(Simple, period 1 hour, grace 1 hour), whose UUID ping URL is `HC_SYNTHETIC_PING_URL` in the server
`.env`; the workflow `synthetic.yml` keeps pinging the old `makrai-synthetic` check, so no check
has two senders. After the workflow is made manual-only (Task 20b's second PR), the old
`makrai-synthetic` check is deleted, `makrai-synthetic-host` is renamed `makrai-synthetic` (its URL
does not change) and switched to Cron `7 * * * *`, UTC, grace 30 minutes.

**The daily checks.** The two checks that GitHub workflows ping, `makrai-ci-audit` (`ci.yml`) and
`makrai-image-scan` (`image-scan.yml`), are not host jobs and stay on GitHub. GitHub's schedule is
best-effort and its delay has no bound, so each is Simple, period 1 day, grace 36 h, not a cron
time: a late run, or one dropped day, is absorbed; silence is reported about 60 h after the last
ping; `/fail` is immediate. The workflows say so beside their ping steps.

**Installing it.** The change reaches the host in a D2 release (deployment.md 8.1 to 8.4), then in
the owner's own session (deployment.md 12.1): root over ssh with the key and the TOTP code, in a
terminal outside the Claude app, with SETENV pasted. (Not the agent's `-N` window of 12.2, which
has no shell to paste into.) Before the session, the agent hands over four values, computed on the
workstation with `git show <commit>:<path> | sha256sum`: the hash of the previous release's
`ops/host/crontab.root` (`<commit>` is `<previous release tag>`), which Pre-check A compares, and the
hashes of the merged `ops/host/makrai-synthetic.sh`, `scripts/synthetic-journey.mjs` and
`ops/host/crontab.root`, which the install chain compares. None is secret. The job needs `makrai-lib.sh` with `read_env` and `ping_ok`/`ping_fail` (installed
in part C, above, and unchanged here), and `/usr/local/lib/makrai` and `/root/makrai-stage` exist
from part C.

Pre-check A, which prints counts and status only:

```bash
install -d -m 0700 /root/makrai-stage
sudo -u <operator> git -C /srv/makrai/app describe --tags --exact-match
crontab -l | sha256sum
[ -e /root/makrai-stage/crontab.root.prev ] || { [ "$(crontab -l | sha256sum | cut -d' ' -f1)" = '<previous release crontab.root sha256>' ] && crontab -l > /root/makrai-stage/crontab.root.prev; }
sha256sum < /root/makrai-stage/crontab.root.prev
docker inspect --format '{{.Image}}' docker-nextjs-1 | grep -cE '^sha256:[0-9a-f]{64}$'
stat -c '%U %a' /srv/makrai/app/.env
```

Expect the tag of the release that carries this change; the hash of root's crontab before it, the
one the agent handed over from `<previous release tag>`, twice (the third line for the live
crontab, the fifth for the saved copy); `1`; and `<operator> 600`. If either hash differs, or
anything else prints, stop and show the diff. The copy saved on the fourth line is the rollback, so
it is written only if absent, and only if the live crontab is the previous release's (paste the
handed-over hash in place of the placeholder): a drifted crontab is never saved, and running this
pre-check again, after the chain, cannot replace the copy with the new crontab. The fifth line is
why that is safe: a copy left behind by an earlier window that was abandoned would otherwise be
kept, and the rollback would restore that older crontab. If the fifth line differs, or fails
because nothing was saved, and the chain has not run, `rm -f /root/makrai-stage/crontab.root.prev`,
fix the cause and run Pre-check A again. After the chain has run, never remove it: it is the
rollback. The chain has run, in this window or an earlier one, if `crontab -l | grep -c makrai-synthetic`
prints `1`.

Then the secrets, from the password manager at a hidden prompt. `HC_SYNTHETIC_PING_URL` is the
**new** check's URL (`makrai-synthetic-host`), never the old check's:

```bash
for k in SYNTHETIC_EMAIL SYNTHETIC_PASSWORD SYNTHETIC_ORG_SLUG SYNTHETIC_ASSESSMENT_ID HC_SYNTHETIC_PING_URL; do setenv_secret "$k"; done
```

Pre-check B, counts and status only:

```bash
grep -cE '^(SYNTHETIC_EMAIL|SYNTHETIC_PASSWORD|SYNTHETIC_ORG_SLUG|SYNTHETIC_ASSESSMENT_ID|HC_SYNTHETIC_PING_URL)=.' /srv/makrai/app/.env
grep -cE '^SYNTHETIC_PASSWORD=[A-Za-z0-9]{24,}$' /srv/makrai/app/.env
grep -cE '^HC_SYNTHETIC_PING_URL=https://hc-ping\.com/[0-9a-f-]{36}$' /srv/makrai/app/.env
sudo -u <operator> bash -c '. /usr/local/bin/makrai-lib.sh; load_env; echo ok'
```

Expect `5`, `1`, `1` and `ok`. The second line enforces the password format; the third accepts the
UUID form of the ping URL, which a rename of the check does not change; the last proves that the
new lines cannot break the operator's backup jobs, which source the file under `set -u`. Anything
else: stop. Correct the value with `setenv_secret <KEY>` and run Pre-check B again, or abandon the
install: remove the five keys with the strip command under Rollback, then
`rm -f /root/makrai-stage/crontab.root.prev`, before leaving the window. Do not run the chain.

Then one chain, by the rule in **Installing from the checkout**: stage, compare strictly, install
the staged copies, then the crontab.

```bash
cd /srv/makrai/app \
  && install -d -m 0700 /root/makrai-stage \
  && install -m 0600 ops/host/makrai-synthetic.sh /root/makrai-stage/makrai-synthetic.sh \
  && install -m 0600 scripts/synthetic-journey.mjs /root/makrai-stage/synthetic-journey.mjs \
  && install -m 0600 ops/host/crontab.root /root/makrai-stage/crontab.root \
  && printf '%s  %s\n' '<makrai-synthetic.sh sha256>' /root/makrai-stage/makrai-synthetic.sh '<synthetic-journey.mjs sha256>' /root/makrai-stage/synthetic-journey.mjs '<crontab.root sha256>' /root/makrai-stage/crontab.root | sha256sum -c --strict \
  && install -m 0755 /root/makrai-stage/makrai-synthetic.sh /usr/local/sbin/makrai-synthetic.sh \
  && install -m 0644 /root/makrai-stage/synthetic-journey.mjs /usr/local/lib/makrai/synthetic-journey.mjs \
  && { [ -e /var/log/makrai/synthetic.log ] || install -m 0600 /dev/null /var/log/makrai/synthetic.log; } \
  && crontab /root/makrai-stage/crontab.root
```

Post-check: one run exactly as the crontab runs it, but without `--ping`, then what it left.

```bash
/usr/local/sbin/makrai-synthetic.sh >> /var/log/makrai/synthetic.log 2>&1; echo rc=$?
tail -n 8 /var/log/makrai/synthetic.log
stat -c '%a %U:%G %n' /usr/local/sbin/makrai-synthetic.sh /usr/local/lib/makrai/synthetic-journey.mjs /var/log/makrai/synthetic.log
crontab -l | grep -c 'makrai-synthetic.sh --ping'
docker ps -a --filter name=makrai-synthetic -q | wc -l
```

Expect `rc=0`; in the tail `step=csrf status=200`, `step=signin status=302`, then `read`, `save` and
`readback` at `200`, and `result=pass`; `755 root:root`, `644 root:root` and `600 root:root`; `1`;
and `0` (no container left behind). After the next :07, the check `makrai-synthetic-host` shows a
ping. Report only the `rc`, the `step=` and `status=` lines and the counts. This one run also
settles what a test cannot: how Cloudflare treats the host's address, IPv4 from the default
bridge, the journey's output under `--log-driver none`, and a read-only root. If Cloudflare
challenges the host, the run fails every hour; the answer is the rollback below, never a WAF allow
rule or a rate-limit bypass for the synthetic account.

**The soak and the alert drill.** The gates are events, not dates. First, 24 consecutive on-time :07
pings in the check's event log. Then the drill: set `SYNTHETIC_ASSESSMENT_ID` to an id of the same
shape that does not exist, with `V=<that id> setenv_put SYNTHETIC_ASSESSMENT_ID`; the next :07 must
give `result=fail`, the check must go down and an email must arrive. Restore the real id with
`setenv_secret SYNTHETIC_ASSESSMENT_ID`; the next :07 must bring the check back up.

**Rollback**, at any point before the workflow is made manual-only (GitHub's schedule was never
removed), in a window:

```bash
crontab /root/makrai-stage/crontab.root.prev
rm -f /usr/local/sbin/makrai-synthetic.sh /usr/local/lib/makrai/synthetic-journey.mjs
crontab -l | grep -c makrai-synthetic
```

Expect `0`: no line of root's crontab names the script any more.

The five keys may stay in `.env`, where nothing reads them. To remove them, keep the file's owner:

```bash
f=/srv/makrai/app/.env; ( umask 077; grep -vE '^(SYNTHETIC_(EMAIL|PASSWORD|ORG_SLUG|ASSESSMENT_ID)|HC_SYNTHETIC_PING_URL)=' "$f" > "$f.new" ) && cat "$f.new" > "$f" && shred -u "$f.new"
```

Never `sed -i` as root: it replaces the file and makes root its owner, which breaks the
operator's jobs. Then revert the change in the repository and pause the new check.

**Drift.** Root runs its own copy of the journey. Any change to `scripts/synthetic-journey.mjs`
ships with a staged reinstall of it, by the chain above. A stale copy is loud in the dangerous
direction (an API change it does not know turns into `/fail`), but a new check added to the
repository's journey does not reach the host until it is reinstalled. The script is coupled to
the container name `docker-nextjs-1`, which comes from the Compose project name `docker`; a
rename turns every run into `/fail`.

## Rotating the production secrets (Task 24)

`makrai-rotate-secrets.sh` rotates the production values that an AI-run process once held, stage by
stage, in place of a runbook pasted into a root session. It rotates:

- `NEXTAUTH_SECRET`. Every session is signed out once.
- `POSTGRES_PASSWORD`, the owner role `makrai`. It is also the password in the migrator's
  `DATABASE_URL`, and in the legacy `.env` line `DATABASE_URL`, which is removed only if nothing reads
  it and it names the owner role with `POSTGRES_PASSWORD`; otherwise the script stops.
- The `makrai_app` password inside `APP_DATABASE_URL`.
- `BACKUP_PASSPHRASE`, generated on the server (`openssl rand -hex 32`).
- Optionally `ADMIN_PASSWORD`, as a separate step with its own rollback.

It does not rotate `makrai_identity`: that password was generated on the server (Task 11 step 7) and
never displayed, so no AI-run process held it.

The script takes no argument that is a value, prints no value, logs none and puts none in a command
line. A value is never in argv, logs or display. It is in shell variables, in root-owned temp files in
`/root`, and, for the length of one command, in the environment of short-lived processes run as root
(awk, the provisioning script and its docker CLI, psql in the postgres container) or as `.env`'s owner
(the operator's jobs, through `load_env`). It reads `.env` as text and never sources it as root; it writes
it with `cat tmp > .env`, as the file's owner, after proving the temp file complete, so the owner and mode
survive and a failed write cannot leave a truncated file with nothing to restore from. It refuses to write
a `.env` that is not mode 600. It needs neither SETENV nor a pasted block. Everything it prints is a
marker, a count, a key name, a status, a file name or the first twelve characters of a file's sha256. The
last line of every subcommand is `<NAME> OK`, or `<NAME> STOP: <reason>` with a non-zero exit status.

### Installing it

The reviewed script is staged and compared before it is installed, by the rule in **Installing from
the checkout**, above. It is run as root, so the hash is computed on the workstation from the merged
commit, never from the server:

```bash
git show <merged commit>:ops/host/makrai-rotate-secrets.sh | sha256sum
```

```bash
install -d -m 0700 /root/makrai-stage \
  && install -m 0600 /srv/makrai/app/ops/host/makrai-rotate-secrets.sh /root/makrai-stage/makrai-rotate-secrets.sh \
  && printf '%s  %s\n' '<sha256 from the workstation>' /root/makrai-stage/makrai-rotate-secrets.sh | sha256sum -c --strict \
  && install -m 0755 /root/makrai-stage/makrai-rotate-secrets.sh /usr/local/sbin/makrai-rotate-secrets.sh
```

Expect `/root/makrai-stage/makrai-rotate-secrets.sh: OK` and nothing else. Anything else: remove the
staged file and stop. The script pins the sha256 of `scripts/provision-app-db-role.sh` (the reviewed
v0.5.0 blob) and runs root's own staged copy of it after checking that hash, so a checkout whose
provisioning script differs makes `precheck` and `stage-a` stop. A lint test keeps the pin equal to
the file in the repository.

### Before the day

- **Not before the Task 20b soak gate completes.** Not in an hour that holds the Task 20b alert drill,
  a D2 deploy or any other window task.
- **Announce it the day before** to every human account holder: "At `<time>` UTC every session is signed
  out once, and the site is unavailable for up to about a minute while the app restarts. Save your
  work first." Invitation links keep working: their tokens are random and stored as unkeyed sha256, not
  signed with the secret. The synthetic account signs in fresh every run. UptimeRobot may record one
  short outage at the restart; leave it running.
- **Default plan** (UTC):

  | Time | Step |
  | --- | --- |
  | 11:45 to 12:00 | W1: the agent runs `precheck` |
  | 12:20 | Stage A: `save-prev-a`, `stage-a` |
  | 12:25 to 12:45 | W2: the agent runs `check-a` |
  | 13:20 | Stage B |
  | 13:35 to 13:55 | W3: the agent runs `check-b` |
  | next day, after 01:15 | W4: the agent runs `check-next`, then the owner runs `shred-prev` |

- **The gate.** Every subcommand that writes `.env` starts only between hh:15 and hh:50 UTC, never in the
  hours 06, 22, 23, 00, 01, 02 or 03 UTC, and never while a scheduled job or an unattended package
  upgrade is running. A `.env` write must not overlap a job that reads `.env` (hh:05 audit-log ship,
  hh:07 synthetic journey, whose retry runs until about hh:15, 00:00 backup, 00:30 off-site copy, 01:00
  restore test, 02:00 reconcile, 02:30 email scan, 03:30 automatic reboot, 06:00 backup check), or a
  package upgrade (06:00 to 07:00) that can replace `dockerd` in the middle of the restart. Run
  `makrai-rotate-secrets.sh gate` to see it alone. A closed gate changes nothing: run the command again
  when it opens. `rollback-b` and `admin-password rollback` keep the gate like the stages. Rolling Stage A
  back is the exception: an outage is ended, not scheduled. `recover-deploy-new` lifts the hour and minute
  window too, for the same reason, but still refuses while a scheduled job or a package upgrade runs.
- **Start Stage B no later than 20:50 UTC** (`stage-b` refuses later). A new passphrase between the 00:00
  backup and the 01:00 restore test would make the test decrypt an old-passphrase file with the new value
  and report FAILED, which blocks migration deploys (vision section 8.2). The real limit is the rollback:
  `rollback-b` is gated like a stage, so it can start only by 21:50 UTC, and the gate refuses every minute
  of the hours 22 and 23. A failed escrow proof or copy is therefore decided by about 21:30 UTC, which a
  Stage B started by 20:50 leaves room for. Changing the database passwords and `NEXTAUTH_SECRET` does not
  touch the restore comparison.
- **The chain after its start.** `backup-chain` checks the whole gate once, at its start. It writes no
  `.env`, so after the new escrow is proven and again after the 130-second wait it checks only that it has
  not reached the nightly hours (23:40 UTC to 03:59, and the hour 06; nothing runs before the 00:00 backup,
  so a prompt answered after 22:00 is fine) and that no backup, copy or restore job is running; otherwise it
  stops with `nothing left the server` and is run again when the night is over.
- **One command at a time.** The commands that change anything take a lock in `/root`, so a second paste
  stops with `another makrai-rotate-secrets.sh command is running`.

### The subcommands

| Subcommand | Step | Changes anything? | Who |
| --- | --- | --- | --- |
| `gate` | the timing gate | no | either |
| `precheck [--post-rollback]` | W1: every expected value, `ok` or `FAIL` | no | agent, in a window |
| `save-prev-a` | A0: root's copy of `.env` (`/root/env.prev-a`), and `PG_STARTED` | root's copy | owner |
| `stage-a` | A1 to A5, then A6: `NEXTAUTH_SECRET`, the owner role, the legacy `DATABASE_URL` line, `makrai_app`, then one restart of `nextjs`. Starts, or resumes after a STOP | yes | owner |
| `verify-a` | A6 alone: health, the operator's `load_env`, `prisma migrate status` | state only (records A_DONE when A6 passes after a stop in A6; takes the lock) | owner |
| `fix-owner` | the forward fix: set the owner role's password to what `.env` holds | the database | owner |
| `check-a` | W2: the post-check of Stage A | no | agent, in a window |
| `rollback-a <key>` | `NEXTAUTH_SECRET`, `POSTGRES_PASSWORD`, `APP_DATABASE_URL`, `DATABASE_URL`, `app` (RA-app: both app lines, `makrai_app`, one restart) or `all` | yes | owner |
| `recover-deploy-new` | finishes a deploy's `set_env` write that failed (deployment.md 8): checks `/srv/makrai/app/.env.new` on its own descriptor (a regular file, root's, mode 600, one link, not empty, and `.env` its start), writes it into `.env` as `.env`'s owner, and removes it | yes (takes the lock; refuses while a job or an upgrade is running, not for the hour) | owner |
| `save-prev-b` | B0: `/root/env.prev-b`, and `LASTOLD`, the newest backup before the rotation | root's copy | owner |
| `escrow-check pre\|new\|<file>` | a value typed at the script's own hidden prompt must open the backup; prints `escrow_decrypt=1` or `0`. `pre` is B1. `new` works only after B4: it proves B5 for the recorded hand backup, so `backup-chain` then skips its own prompt (before B4, `backup-chain` asks at its prompt). `<file>` is a named backup (after 00:00) | state only (takes the lock; records `ESCROW_PRE` or `ESCROW_NEW`) | owner |
| `stage-b` | B2: `BACKUP_PASSPHRASE`, 64 hex from openssl | yes | owner |
| `backup-chain [--fresh\|--release-hold]` | B4 to B8: hand backup; the new escrow proven; wait 130 s; off-site copy; restore test; `fetched=` is the new file | the backups | owner |
| `check-b` | W3: the post-check of Stage B | no | agent, in a window |
| `rollback-b line\|local` | RB-line, RB-local | yes | owner |
| `admin-password [rollback]` | optional A7: `ADMIN_PASSWORD`, with its own `/root/env.prev-admin`. Only if the line exists, only once Stage A is complete (`STAGE-A OK`, or `VERIFY-A OK` after a stop in A6) and before Stage B. Both forms keep the gate | yes | owner |
| `check-next` | W4: the next night's chain | no | agent, in a window |
| `shred-prev` | shreds the env.prev copies and the staged provisioning script, once `check-next` passes, and archives the state file | root's copies and state | owner |

### The owner's sequence

Run each command as root, in your own key-and-code session, in a terminal outside the Claude app, and
read its last line before the next. The agent has no window open while you apply. Each section says
what to expect and what to do otherwise.

**W1. The agent's pre-check.** The agent runs `precheck` (below) and hands over: whether a legacy
`DATABASE_URL` line exists, the count of `ADMIN_PASSWORD` lines, and "go". Any `FAIL` line, or a last
line other than `PRECHECK OK`, is a stop: report it and do not start Stage A. Two lines are `info` because
the right value depends on the release; the agent compares them with these and treats any other as a stop:
`checkout_tag=v0.5.1` (the tag that carries this script and that production runs) and
`lib_sha256_prefix=27fedba505bf` (the reviewed `makrai-lib.sh`, which the operator's jobs and the box listing
source). The other lines it reads against fixed values: `env_stat=600 regular file`,
`env_owner_is_the_checkouts_owner=yes`, `synthetic_last_result=result=pass` with `synthetic_last_age_min`
at most 70, `tz=UTC`, and `pg_settings` with `logging_collector=off` among the logging settings.

**Stage A.**

```bash
/usr/local/sbin/makrai-rotate-secrets.sh save-prev-a
/usr/local/sbin/makrai-rotate-secrets.sh stage-a
```

`save-prev-a` ends in `A0 OK` and `SAVE-PREV-A OK`. If `/root/env.prev-a` is already there, it says
`PREV-CURRENT` (it equals `.env`: it is kept) or `PREV-STALE` (it does not: it may hold the only copy
of the old values and is never overwritten; stop and ask).

`stage-a` takes about a minute. The site is down only from the end of A4 until A5 reports healthy.
Expect, in this order:

1. `ok` and `info` lines (the pre-start checks of `.env` and the legacy line), then
   `provision script staged, sha256 aa8aea6818dc`, then
   `now hh:mmZ, scheduled jobs running: 0, package upgrades running: 0`, `gate: open`, and `T0=<UTC time>`
2. `A1 OK` (`NEXTAUTH_SECRET`)
3. `OWNER-ALTER OK`, `A2 OK` (the owner role)
4. `A3 OK` (the legacy `DATABASE_URL` line, or `DATABASE_URL: no line, nothing to do`)
5. `APP-PROVISION OK`, `A4 OK` (`makrai_app`)
6. Compose's own `Container docker-nextjs-1 ...` lines, `A5 OK` (the one restart). If Compose fails, its
   failure lines that carry no free text are shown too (`Container ... Error`, `container ... is
   unhealthy`); anything else is counted (`compose: N other line(s) not shown`), followed by `see: docker ps
   -a --filter name=docker-nextjs-1; docker logs --tail 50 docker-nextjs-1`, which are docker's own
   read-only commands
7. `A6 health=ok`, `OPERATOR-LOAD-ENV OK`, `A6 migrate-status rc=0`
8. `STAGE-A OK`

Stage A counts as complete only when A6 has passed. Then sign in at https://makrai.org: the old session
is gone. Report T0 and every marker to the agent.

**A7 (only if W1 reported `key_ADMIN_PASSWORD_lines=1`).** The owner approved rotating `ADMIN_PASSWORD` in
this run if the line exists. Once Stage A is complete (`STAGE-A OK`, or `VERIFY-A OK` after a stop in A6),
at the next open gate, and before W2 and Stage B:

```bash
/usr/local/sbin/makrai-rotate-secrets.sh admin-password
```

Expect `A7 OK` and `ADMIN-PASSWORD OK`; report it. It has its own root copy, `/root/env.prev-admin`, so its
rollback (`admin-password rollback`, ending in `RA-admin OK`) does not depend on either stage; the rollback
keeps the gate, as `rollback-b` does. Nothing reads the value except a seed run. The script refuses it with no
`ADMIN_PASSWORD` line (`no ADMIN_PASSWORD line: nothing to rotate`: it never adds a key), before Stage A is
complete (it would make `stage-a` stop), and once Stage B has started or `shred-prev` has run (nothing would
shred its root copy; after `shred-prev` it says `the rotation is closed (<archive>)`). A second rotation stops
at `PREV-STALE`. Without the line, skip this step. `stage-a` prints the reminder for this step after
`STAGE-A OK`, and `verify-a` prints it when its `VERIFY-A OK` completes Stage A: both say `at an open gate`,
because a `stage-a` that resumed on the outage path can end outside the gate's minutes.

Before it changes anything, `stage-a` refuses (and writes nothing) if `.env` differs from
`/root/env.prev-a`, if `.env` is not mode 600, if `NEXTAUTH_SECRET`, `POSTGRES_PASSWORD` or
`APP_DATABASE_URL` is not on exactly one line, if `APP_DATABASE_URL` is anything but
`postgresql://makrai_app:<password>@postgres:5432/<POSTGRES_DB>` (quoted or percent-encoded is fine; a query
string, another host or another database is not, because the new line is rebuilt from known parts and would
drop it), if the legacy `DATABASE_URL` line does not meet the removal rules, or if the staged provisioning
script's hash is not the reviewed one. Before each later write it requires every line of `.env` outside the
rotated keys to be `env.prev-a`'s, byte for byte, so a `.env` truncated by a failed write is never written
over.

**If `STAGE-A STOP` appears,** the lines above it say where it stopped and what state that leaves. A
re-run of `stage-a` carries on from the last finished step and never repeats a finished one, so the
forward fix is always the same command. Going back is `rollback-a`, below. After a gate refusal nothing
has changed: run `stage-a` again when the gate opens. A re-run from the `makrai_app` provisioning on (an
outage may be in progress) does not wait for the hour or minute window, but it still stops while a scheduled
job or a package upgrade runs, and then says that `rollback-a app` ends the outage at once. If the session
drops or the command is interrupted, it says so: from A4 on that an outage may be in progress (`stage-a`
again, or `rollback-a app`), before that that `makrai_app` was not touched and `stage-a` carries on.

| Stopped at | State | Forward | Back |
| --- | --- | --- | --- |
| a gate refusal, or `PREV-STALE` | nothing changed | wait for the gate, or ask | nothing to undo |
| A1, A2 (no value generated) | `.env` unchanged, or only `NEXTAUTH_SECRET` new | fix the cause, `stage-a` | `rollback-a all` |
| `WRITE FAILED ... kept in <tmp>` | `.env` may be partial; `<tmp>` holds the intended file | free disk space and run the command it prints, then `stage-a` (it carries on at that step). For the first write (A1), run the command it prints, then `rollback-a all`, then `stage-a` | `rollback-a all` |
| `.env is not whole` | lines outside the rotated keys differ from `env.prev-a`; nothing was written | | `rollback-a all` |
| `OWNER-ALTER FAILED` (A2) | `.env` has the new owner password; the database has the old one, or an unknown one; the service is up | `stage-a` | `rollback-a POSTGRES_PASSWORD`, then `rollback-a NEXTAUTH_SECRET` (or `rollback-a all`) |
| A3 (the legacy line) | the owner role is rotated | `stage-a` | `rollback-a DATABASE_URL` |
| `APP-URL STOP`, `APP-PROVISION FAILED` (A4) | `.env` has the new `makrai_app` URL, maybe; the database and the running container still have the old password | `stage-a` | `rollback-a APP_DATABASE_URL` (the running container already has the restored value, so there is no restart), then `rollback-a NEXTAUTH_SECRET` and `rollback-a POSTGRES_PASSWORD`; or `rollback-a all` |
| A5 failed | **outage**: `makrai_app` has the new password and the running container cannot connect | `stage-a` (retries the restart) | `rollback-a app` (RA-app): both app lines back, `makrai_app` back, one restart. Now |
| `A6 health=bad` (health not ok) | the restart happened; the site does not answer | fix the cause, then `verify-a`: its `VERIFY-A OK` completes Stage A (then A7, if it applies) | `rollback-a app`, or `rollback-a all` |
| `OPERATOR-LOAD-ENV FAILED` | the operator's jobs cannot source `.env` | | `rollback-a all` |
| `A6 migrate-status rc` not 0 | the owner role and `.env` disagree; users are unaffected | `fix-owner`, then `verify-a` | |

`rollback-a all` (RA-full) restores the whole `.env` from `/root/env.prev-a`, sets the owner role and
`makrai_app` back, restarts `nextjs` if its running value differs, and removes `/root/env.prev-admin`; it is
valid only during Stage A, while nothing else has written `.env` since A0. The script refuses it once
`/root/env.prev-b` exists, and when `.env` has a key CHANGED or ADDED since `env.prev-a` other than the rotated
ones (a deploy's `WEB_IMAGE`, say); it names those keys, and you roll back key by key. A key that is missing
is fine: that is the partial write this restore exists for. So is a `.env` that ends part-way through a line
(a disk that filled in the middle of a line): it reads as one changed key, the cut line. So is an empty
`.env` (a disk that was full before the first byte). The restore excuses a cut only when `.env` is, byte for
byte, the start of `env.prev-a`, or the start of an intended file that a failed write kept (`/root/.t24-env.*`,
or the deploy's `/srv/makrai/app/.env.new`) and that holds no change by someone else. A deploy's `set_env`
(deployment.md 8) leaves `.env.new` when its own write into `.env` fails. A deploy's change can lie
after the cut point, where `.env` no longer shows it: the kept file does, and then the restore refuses,
naming the key, and says to run the recovery command the WRITE FAILED line printed, then roll back key by
key. For `.env.new` it says to finish the deploy's write first with `makrai-rotate-secrets.sh recover-deploy-new`,
then roll back key by key. The checkout is the operator's, so `.env.new` is opened, then checked against the
path (dev:ino) before anything is read, and the script judges what it opened, not the path: it must be the file set_env makes (a regular file, owner root, mode 600, one link, not
empty), and `.env` must be its start. A symlink, a hard link to some other file, another owner or mode, an
empty file, or a `.env.new` that `.env` is not the start of (a stale one), is refused with the reason, and
nothing changes. It copies the bytes into a root-only file in `/root` and writes `.env` from it as `.env`'s
owner, as every other write here does; then it removes `.env.new` and prints `RD .env written from .env.new`,
`RD .env.new removed` and `RECOVER-DEPLOY-NEW OK`. Root is never told to read or write a checkout path itself.
If the restore's own write is cut short, even to nothing, it prints the command that finishes it
(`test -s /root/env.prev-a && sudo -u <operator> sh -c 'cat > "$1"' sh <.env> < /root/env.prev-a`) and can be
run again. A per-key rollback (and `rollback-b`, and `admin-password rollback`) refuses, writing nothing, a `.env`
that has lost lines outside the rotated keys or ends part-way through a line (an empty `.env` has lost them
all): it would print OK over a broken file. The
recovery command the WRITE FAILED line printed comes first, because it makes `.env` the intended file;
`rollback-a all` comes second, only if nothing else changed `.env`, and it is refused once Stage B has
started, when the lost lines are put back from `env.prev-a` by hand (their names are printed). A deploy's
changed or added keys do not trigger this refusal. Every rollback reads the old line from the root
copy as text and puts it back exactly, quotes and escapes included. The per-key rollbacks restart `nextjs`
only if its running container's value differs from the restored line, and say `no restart` otherwise;
`rollback-a app` always runs `up`, once, which recreates the container only if its configuration differs.
Each records the partial state as soon as `.env` changes, so `stage-a` will not resume over it. If the copy
is missing, unreadable, a symlink, empty or not an `.env`, it stops with `.env` untouched: after the copies
are shredded there is no rollback, and the only way is forward. The restored values are the exposed ones:
schedule a new attempt.

`rollback-a all` prints `RA env restored`, `OWNER-ALTER OK`, `APP-PROVISION OK`, `RA-full OK` and
`ROLLBACK-A OK`. `rollback-a app` prints `APP-PROVISION OK`, `RA-app OK` and `ROLLBACK-A OK`. A key rollback
prints `RA-nextauth OK`, `RA-owner OK`, `RA-app-line OK` or `RA-dburl OK` before `ROLLBACK-A OK`.
`rollback-b line` prints `RB-line OK`; `rollback-b local` prints `newest_backup=<LASTOLD>` and `RB-local OK`,
and then you delete the new entry in the password manager and give the old one back its label
`makrai backup passphrase (current, server)`.

A `FAIL leftovers` in `precheck` or a check means a temp file in `/root` (`.t24-env.*`) survived a run that
was killed or a write that failed, or that a deploy's `set_env` left `/srv/makrai/app/.env.new` because its
write into `.env` failed. Each holds a copy of `.env`. For `.env.new`, run `recover-deploy-new`, which checks
it and finishes the write, or remove it with `sudo -u <operator> rm -f /srv/makrai/app/.env.new`. For a
`/root/.t24-env.*` file, compare it with `.env` and finish the write it was for, or remove it with `shred -u`;
do not diff checkout files as root.

After a rollback, run `precheck` again. After `rollback-a all`, or after `rollback-a POSTGRES_PASSWORD`
followed by `rollback-a NEXTAUTH_SECRET`, it must read as before Stage A. After `rollback-a app` (or
`rollback-a NEXTAUTH_SECRET` and `rollback-a APP_DATABASE_URL`) alone, the owner role stays rotated and
`postgres_vs_env` reads DIFFERENT, so run `precheck --post-rollback`.

**W2. The agent's post-check A** (`check-a`, below). Stage B waits until it passes. It must read: the
nextjs container equal to `.env` for `NEXTAUTH_SECRET` and `APP_DATABASE_URL` and different from the root
copy; `nextjs_started_after_T0=yes`; `postgres_start_unchanged=SAME`; the new owner and `makrai_app`
passwords `ACCEPTED` over TCP and the old ones `REFUSED`; and every leak count 0. The `keydiff` lines are
`CHANGED NEXTAUTH_SECRET`, `CHANGED POSTGRES_PASSWORD`, `CHANGED APP_DATABASE_URL`, `REMOVED DATABASE_URL` if
the line existed, and `CHANGED ADMIN_PASSWORD` if A7 ran: nothing else (the verdict line `keydiff_names`
says the same). The `keydiff SAME-count N` line after them is a count of the keys that did not change, not a
key line, and `check-b` prints one too. `postgres_container_POSTGRES_PASSWORD_vs_env=DIFFERENT`, an `info`
line, is expected and harmless: the postgres container is not recreated (F-26), its entrypoint ignores the
variable on an existing data directory, and the next recreate converges it. Never ALTER to the container's value.
`journal_nextjs_jwt_session_errors` above 0 is expected after re-sign-ins: Auth.js logs every refused old
cookie.

**If `check-a` or `check-b` fails,** the agent stops and reports the `FAIL` lines; nothing is retried inside
the script.

| A `FAIL` on | Means | Do |
| --- | --- | --- |
| `tcp_owner_env=REFUSED` | the owner role does not hold the password in `.env` | `fix-owner`, then `check-a` again |
| an old value `ACCEPTED` (`tcp_owner_prev_a`, `tcp_makrai_app_prev_a`) | the check proved nothing, or the old value survived | stop and report; do not start Stage B |
| a leak count above 0 (`leak_journal`, `leak_logs`, `leak_history`, `psql_history_hits`) | a new value reached a journal, a log or a shell history | stop and report. That value is rotated again once the cause is found: a fresh, reviewed run, never an in-script retry |
| an unexpected `keydiff` line | `.env` changed in a way Stage A does not account for: a `CHANGED`, `ADDED` or `REMOVED` line not listed above, and `keydiff_names` then fails (`keydiff SAME-count` is a count, never unexpected) | stop and report |
| anything else | | stop and report |

A re-rotation after that is a new run from `save-prev-a`. The script allows it only from a clean slate: the
copies shredded and the state archived (`shred-prev` renames `/root/.makrai-rotate-state` to
`.makrai-rotate-state.done-<UTC>`; it holds names and times only), or, before Stage B, `rollback-a all`.
Until then `save-prev-a` says `PREV-STALE` and `stage-a` says `Stage A is already complete`.

**Stage B.** A new session is not needed. Take the cut-over name and the root copy:

```bash
/usr/local/sbin/makrai-rotate-secrets.sh save-prev-b
```

Expect `LASTOLD=makrai-YYYYMMDD-HHMMSS.sql.gz.gpg`, `B0 OK`, `SAVE-PREV-B OK`. `LASTOLD` is the newest
file made under the old passphrase: every file named after it will use the new one.

**B1. Prove the current escrow before anything is rotated.** In Google Password Manager copy the
password of "makrai backup passphrase (current, server)", then:

```bash
/usr/local/sbin/makrai-rotate-secrets.sh escrow-check pre
```

Paste at the script's own hidden prompt and press Enter; the script reads one line. Expect
`escrow_decrypt=1` and `ESCROW-CHECK OK`, then clear the clipboard. `escrow_decrypt=0` means the escrow does
not match what encrypts today's backups: do not rotate. Re-escrow the current server value into that
entry with the pipe in B3, and repeat B1 until it prints 1. `stage-b` refuses until this passed against
the current `LASTOLD`.

**B2. The new passphrase.**

```bash
/usr/local/sbin/makrai-rotate-secrets.sh stage-b
```

Expect `gate: open`, `TB=<UTC time>`, `B2 shape=1`, `OPERATOR-LOAD-ENV OK`, `B2 OK`, the reminder
`Now relabel the old entry (README B2), escrow the new value (B3), then run backup-chain.`, and `STAGE-B OK`. `stage-b`
refuses after 20:50 UTC. Only then,
in Google Password Manager, relabel the old entry
`makrai backup passphrase (pre-rotation; opens backups up to and including <LASTOLD>)`. If `stage-b` stopped,
leave the label as it was. A `stage-b` that stopped after writing (`OPERATOR-LOAD-ENV FAILED`) is rolled
back with `rollback-b line`. A `stage-b` that writes a passphrase, and `rollback-b line`, forget the earlier
attempt's `NEWBACKUP` and escrow proof (its hand backups stay remembered, so that `save-prev-b` never takes
one as the cut-over): the retry after a rollback, from the next nightly on, takes a new hand backup under
the new value and asks for its escrow at B5.

A write into `.env` can fail in the middle of a line (a full disk) in B2 and in A7, as in Stage A. The script
keeps the intended file and prints the command that finishes the write; the rollback of that step then
refuses a `.env` that is still cut, writing nothing, and says to run that command first:

| Last line | State | Do |
| --- | --- | --- |
| `STAGE-B STOP: .env may be partial: run the command printed above, then rollback-b line, then stage-b again. BACKUP_PASSPHRASE was not written` | `.env` may end in the middle of a line; the intended file with the new passphrase is kept in `/root` | run the command it printed, then `rollback-b line`, then `stage-b` again. `rollback-b` (either mode) refuses a gutted `.env` and says so |
| `ADMIN-PASSWORD STOP: .env may be partial: run the command printed above, then admin-password rollback. ADMIN_PASSWORD was not written` (A7) | the same, for `ADMIN_PASSWORD` | run the command it printed, then `admin-password rollback`. It refuses a gutted `.env` the same way |

**B3. Escrow the new value.** This is Task 5's method, run from your workstation in a terminal outside
the Claude app. The value travels from the server's stdout to the local clipboard and is never shown. The
read runs as the operator, who owns `.env`: root never reads a checkout path with a command that follows a
symlink. Use the clipboard command Task 5 used, `wl-copy` (Wayland) or `xclip -selection clipboard`:

```bash
ssh -i ~/.ssh/makrai_operator -o IdentitiesOnly=yes -o IdentityAgent=none root@<server> \
  "sudo -u <operator> sed -n 's/^BACKUP_PASSPHRASE=//p' /srv/makrai/app/.env | tail -n 1 | tr -d '\n'" | wl-copy
```

1. In Google Password Manager add a **new** entry, labelled
   `makrai backup passphrase (current; rotated <date>; opens backups named after <LASTOLD>)`. Its
   username must differ from both existing entries, the pre-rotation one and any entry labelled
   "STALE: does not match server"; otherwise Google Password Manager replaces that entry.
2. Paste the value and save.
3. Clear the clipboard (`wl-copy --clear`).
4. Confirm that both entries exist.

**B4 to B8. The chain.** Run:

```bash
/usr/local/sbin/makrai-rotate-secrets.sh backup-chain
```

Copy the new entry's password only when the hidden prompt is shown, and paste nothing before it. The
terminal does not echo while the chain runs, and anything typed ahead of a prompt that never comes is
dropped when the chain stops, not run by the shell.

It runs the hand backup as its own command (never chained with the copy), asks for the new passphrase at
its hidden prompt and proves that it opens the new file **before anything leaves the server**, waits 130
seconds so the file is past the off-site copy's 2-minute rule, runs the copy and checks the copy's log and the box's
listing for the new file, then runs the restore test and requires that its `fetched=` is the new file.
Expect, in this order: `B4 OK`,
`NEWBACKUP=makrai-<today>-<time>.sql.gz.gpg`, `B5 escrow_decrypt=1` (then clear the clipboard), `B6 OK`,
`B7 rc=0`, `B7 box_has_new=yes` (the box's own listing names the new file), `B7 OK`, `B8 result=RESTORE MATCH rc=0`, `B8 FETCHED-NEW`, `B8 OK`, `BACKUP-CHAIN OK`. A hand
backup whose only fault is the watchdog ping prints `B4 OK (the backup is fine, only its watchdog ping
failed: tell the agent)`; carry on and tell the agent (`check-b` then reports `backup_ping=failed`, with a
note, and still passes). An off-site copy whose only fault is the watchdog ping prints
`B7 OK (the copy is fine, only its watchdog ping failed: tell the agent)` the same way, and `check-b` then reports
`offsite_ping=failed`, with a note. Report TB, LASTOLD and NEWBACKUP.

Re-running `backup-chain` resumes: it does not take a second hand backup and does not ask for the
escrow again once that is proven. **If it stops,** read the last line and take the row:

| Last line | State | Do |
| --- | --- | --- |
| `B4 failed` | `.env` has the new value. No new file, or a file the backup script verified before it failed: the chain records that one as `NEWBACKUP` and says so | the agent reads the cause in a window; `backup-chain` again (it resumes from a recorded file), or `rollback-b line` |
| `B5 escrow not proven` | one local file under the new value; nothing on the box | repeat B3 into the same new entry and run `backup-chain` again (it resumes at the prompt). Still 0: `rollback-b local`, which must start by 21:50 UTC on the day of Stage B (the gate closes at 22:00), then delete the new entry and give the old one back its label |
| `B6: ... still under 2 minutes old` | nothing left the server | run `backup-chain` again |
| `B7 failed` | `NEWBACKUP` is local, and maybe on the box; the restore test did not run | wait 2 minutes and run `backup-chain` once more. If the box stays unreachable and cannot be fixed by about 21:30 UTC (`rollback-b` must start by 21:50), the agent lists the box. `NEWBACKUP` not there: `rollback-b local`, so the 01:00 test still finds a newest file the live value opens. It is there: roll forward and fix the copy |
| `B8 failed`, `B8 FETCHED-OTHER` or the field `fetch` | the box's newest file is not `NEWBACKUP` | wait 2 minutes, then `backup-chain` again (B7, then B8). If a nightly made after `NEWBACKUP` exists (the night passed under the new value), the box's newest file will never be `NEWBACKUP`: say so in the report and run `backup-chain --fresh` (B4 to B8 again) |
| `B8 failed (restore)`, `(cluster)` or `(roles)`, with `FETCHED-NEW` | `NEWBACKUP` was fetched and did not restore. The chain is held: no retry | the agent reads the tail of `restore-test.log` in a window first; a decrypt failure there points to an `.env` or escrow mismatch (the `B5` and `rollback-b` rows). Then `backup-chain --release-hold` |
| `B8 failed (policies)`, `(migrations)`, `(users)` or `(organizations)` | the live database changed after the backup, unrelated to the passphrase | `backup-chain --fresh` (B4 to B8 again; it refuses while a hold is set); report |
| `NEWBACKUP` is on the box | | **roll forward only.** If a rollback is forced anyway, `rollback-b line` and keep the new escrow entry, relabelled "opens only the backups named after `<LASTOLD>` and before `<the first file after the rollback>`"; keep it until those files are off the box and out of every snapshot (at least 43 days); `rollback-b line` prints this reminder, and `save-prev-b` will not take such a file as the cut-over. That night's 00:00 backup, under the old value, becomes the newest, so the 01:00 test passes |

A failure of the off-site copy or the restore test is never a reason to roll back the database
passwords. A `FAILED` last line in `restore-test.log` blocks migration deploys until a later `PASSED`, so
never leave one. `rollback-b` is gated like a stage (so it starts by 21:50 UTC, not later), and refuses once
a backup named after the newest file this chain made exists: if 00:00 has passed with the new value in `.env`,
prove or fix the new escrow against that night's file (`escrow-check <that file name>`, after the escrow
pipe) and roll forward. `rollback-b local` does every check before it writes: it lists every nightly-form file
named after `LASTOLD`, requires them all to be hand backups this chain made (it records every one, kept or
not), requires that none is on the box and that the box can be listed, and that the newest file would then be
`LASTOLD`. Any other file, or one on the box, and it stops with `.env` untouched. If `rollback-b` cannot
start because `/root/env.prev-b` is missing, there is no rollback. `backup-chain` refuses when
`BACKUP_PASSPHRASE` in `.env` is the one `env.prev-b` has (Stage B rolled back).

**W3. The agent's post-check B** (`check-b`, below). `offsite_failed_since_TB` and `restore_failed_since_TB`
are reported and not judged: a legitimate retry leaves a `FAILED` line. `backup_ping=failed` is reported and
not judged either (the accepted B4 case), but the run must have ended in `Backup complete.`
(`backup_complete_last=1`). So is
`offsite_ping=failed` (the accepted B7 case), with `offsite_last_complete=1`. Any other `FAIL`, and any leak
count above 0, is a stop and a report, as under W2. The last off-site copy complete, the last restore
test `PASSED` with `fetched=` the new file, the last synthetic run a pass that began after T0 (the next :07 after Stage A),
and the leak counts at 0, decide.

**W4. The next morning, after 01:15 UTC.** The agent runs `check-next`. Only when the 00:00, 00:30 and 01:00
jobs have all run under the new passphrase does it print `CHECK-NEXT OK`. A nightly backup or copy whose only
fault is its watchdog ping still passes: `check-next` requires the run to have finished
(`backup_complete_last=1`, `offsite_last_complete=1`) and reports `backup_ping=failed` or `offsite_ping=failed`, with a note, so a failed
ping does not keep the old values in `/root` for another night. Then, in your own session:

```bash
/usr/local/sbin/makrai-rotate-secrets.sh shred-prev
```

`shred-prev` runs the same checks first and shreds nothing unless they pass. Expect `env_prev_files=0` and
`SHRED-PREV OK`. It removes `/root/env.prev-a`, `/root/env.prev-b`, `/root/env.prev-admin` and the staged
provisioning script, and renames `/root/.makrai-rotate-state` to `.makrai-rotate-state.done-<UTC>` so that a
later rotation starts clean. From then on no rollback exists; roll forward only. It cannot be run twice: the
second says `the rotation is closed (<archive>); nothing to shred`. Every other command that needs the
rotation's state (`check-a`, `check-b`, `save-prev-b`, `escrow-check pre` and `new`, `stage-b`, `backup-chain`,
`admin-password`) stops the same way, with `the rotation is closed (<archive>)`; a new rotation starts at
`save-prev-a`. The agent's closing read is `check-next` again: with no state and an archive it
prints `rotation_closed=<archive>` and `env_prev_files=0` (the three copies and the staged script), checks
that no `/root/.t24-env.*` is left, and ends in `CHECK-NEXT OK`; it writes nothing.

### The agent's read-only commands

The owner opens a window (deployment.md 12.2: `timeout --foreground 30m ssh ... -N root@<server>`) and keeps it
closed while applying. The agent checks `ssh -S $HOME/.ssh/makrai-window.sock -O check root@<server>` prints
`Master running`, then sends only these commands, each through a redaction filter on the server, so a
value that some bug printed would never leave it. `pipefail` keeps the script's exit status:

```bash
SSH="ssh -S $HOME/.ssh/makrai-window.sock -o ControlMaster=no -o BatchMode=yes -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=no -o PasswordAuthentication=no -o GSSAPIAuthentication=no -o HostbasedAuthentication=no -o ConnectTimeout=10 root@<server>"
RED='| sed -E "s|[A-Za-z0-9+/=]{32,}|<redacted>|g"'
$SSH "set -o pipefail; /usr/local/sbin/makrai-rotate-secrets.sh precheck 2>&1 $RED"
$SSH "set -o pipefail; /usr/local/sbin/makrai-rotate-secrets.sh precheck --post-rollback 2>&1 $RED"
$SSH "set -o pipefail; /usr/local/sbin/makrai-rotate-secrets.sh check-a 2>&1 $RED"
$SSH "set -o pipefail; /usr/local/sbin/makrai-rotate-secrets.sh check-b 2>&1 $RED"
$SSH "set -o pipefail; /usr/local/sbin/makrai-rotate-secrets.sh check-next 2>&1 $RED"
```

Each prints one `ok`, `info` or `FAIL` line per fact and ends in `<NAME> OK` or `<NAME> STOP: <n> check(s)
failed`; a `FAIL` is a non-zero status. Close each window with the access baseline (deployment.md 12.2):
`records/ops/ssh-access-baseline.txt` must diff as `BASELINE-SAME`. The agent reports names, counts and
statuses, never a value. `precheck --post-rollback` is the read after `rollback-a app` (or
`rollback-a NEXTAUTH_SECRET` and `rollback-a APP_DATABASE_URL`) alone, which leaves the owner role rotated: it reports
`postgres_vs_env_POSTGRES_PASSWORD` as `info`, not as a check. None of these writes anything: the checks
take no lock, create no file, run no restart and no database change, and `precheck` runs
`git --no-optional-locks status`, so that even the checkout's index is not refreshed. A test takes a snapshot of
every file in the sandbox before and after each, `precheck --post-rollback` included.

After the owner applies, and in later windows, the escrow event is closed by two counts: files made under the
pre-rotation passphrase, locally and on the box. Both must be 0, and the owner must read in the Hetzner
Console that the oldest Storage Box snapshot is dated after the night the last such file left the box
(about `<LASTOLD date> + 43 days`). With `CUT` set to the `LASTOLD` name:

```bash
CUT='<LASTOLD>'
echo "local_pre_rotation=$(ls /srv/makrai/backups/ | grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | awk -v c="$CUT" '$0 <= c' | wc -l)"
echo "box_pre_rotation=$(sudo -u <operator> bash -c '. /usr/local/bin/makrai-lib.sh; load_env; T=$OFFSITE_TARGET; [[ $T == *: || $T == */ ]] || T+=/; timeout 300 rsync --list-only --include="makrai-*.sql.gz.gpg" --exclude="*" -e "$OFFSITE_SSH" "$T"' 2>/dev/null | awk '{print $NF}' | grep -E '^makrai-[0-9]{8}-[0-9]{6}\.sql\.gz\.gpg$' | awk -v c="$CUT" '$0 <= c' | wc -l)"
```

### What it does not do

The checks run against the real server, not this repository's tests, which run the script against a
sandbox whose Postgres is a set of files. `precheck`, `check-a` and `check-b` are what show, on the
server, that scram over TCP refuses an old password, that Compose recreated the container and that
`prisma migrate status` exits 0. The script cannot reach the password manager: the escrow steps are
yours, and it only proves, at its own prompt, that what you typed opens a backup. It does not record
the rotation: the rotation record, the key inventory, the open ledger row for the pre-rotation escrow
and the execution log are written by the agent from the markers you reported.

`MAKRAI_ROTATE_ROOT` is a test hook: it re-roots every path the script uses. The installed copy
(`/usr/local/sbin/makrai-rotate-secrets.sh`) refuses it and exits 2. Any other copy that honours it prints
`WARNING rotate_root=<dir> (test tree)` as its first line, and fails the verdict of every check unless a
second, test-only variable is also set, so a check run against a tree that is not production cannot pass.

## Rules

Checked by `__tests__/lint/ops-host-scripts.test.ts`,
`__tests__/lint/rotate-secrets-script.test.ts`,
`__tests__/lint/dead-man-switches.test.ts`,
`__tests__/lint/backup-glob-agreement.test.ts`, `__tests__/lint/email-scan.test.ts`,
`__tests__/lint/auditlog-scripts.test.ts`, `__tests__/unit/auditlog.test.ts`
and, for the config files, `__tests__/lint/host-config-mirror.test.ts`:

- Every script starts with `set -Eeuo pipefail`, except the console break-glass hook
  `makrai-break-glass-session`, which must never fail a login: it runs every step under
  `timeout`, logs what failed and always exits 0 (ADR-0010).
- A secret reaches a script only through the server `.env`. The operator's own jobs read it
  with `load_env` from `makrai-lib.sh`; every job that runs as root (the email scan, the
  audit-log ship and reconcile, the pre-fix export) reads only the keys it names, as text, with
  `read_env`, and never sources the file, which the operator account can write (T22-3). The
  break-glass hook reads it itself, as text, so the console path depends on no other file. It never reaches argv: no
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
- Every crontab calls its scripts by absolute path. Root's jobs append both output streams to
  their own log in `/var/log/makrai`, and the reconcile and the email scan print their counts
  line last, after anything the ping or the mail printed.
- sshd logs at `LogLevel VERBOSE`, set in the one drop-in, so the reconcile sees the key each
  login used.
- The audit-log jobs reach the box only through `AUDITLOG_SSH`: root's own key and a host key
  pinned in root's `known_hosts` (`StrictHostKeyChecking=yes`). The ship deletes there only names
  `expiredNames()` chose and the box listed, the oldest 60 at most per run, and none on evidence
  that the clock is wrong.
- The reconcile prints counts only, and fails loudly when `WEB_IMAGE` is empty or not pinned by
  digest, when its state is unreadable or too old, or when nothing was shipped in the window. It
  runs `auditlog.mjs` from `/usr/local/lib/makrai`, root's installed copy, with `--pull never`;
  `auditlog.mjs` uses built-ins only.
- The hourly synthetic journey signs in to `https://makrai.org`, a literal in `makrai-synthetic.sh`
  that is never a `.env` key, so the password goes to that origin whatever a line in the
  operator-writable `.env` says. It runs `synthetic-journey.mjs` from root's copy in
  `/usr/local/lib/makrai`, with `--pull never`, in the image of the running web container
  (`docker inspect` of `docker-nextjs-1`, accepted only as a `sha256:` image ID), in a throwaway
  container with a read-only root, no capabilities, the default bridge and no log driver. It passes
  the values by name (`-e NAME`), never in argv, and sends one ping, from its exit handler, and
  only with `--ping`. `SYNTHETIC_PASSWORD` is letters and digits only: a `$` would break `load_env`
  under `set -u`, and with it the operator's backup jobs.
- `makrai-rotate-secrets.sh` never prints a value, logs one or puts one in argv; a value is in the
  environment only of short-lived processes run as root or as `.env`'s owner. It reads `.env` as text and
  writes it only as the file's owner, from a temp file in `/root` proven complete, and refuses a
  symlinked `.env` or one that is not mode 600. Compose runs only from `/srv/makrai/app/docker` with `env -i`, restarting `nextjs` once
  with `--wait`. The provisioning script runs from root's own copy, checked against a pinned sha256. It
  waits for every job the crontabs run and starts only between hh:15 and hh:50, outside the hours 06 and
  22 to 03 UTC. Every rollback refuses, with `.env` untouched, when its root copy is missing or unusable.
  Checked by `__tests__/lint/rotate-secrets-script.test.ts`, which runs it in a sandbox.
- Every script in `ops/host` is committed executable (mode 100755).
- Every `python3` call runs isolated (`python3 -I`), so a `json.py` in the working directory is
  never imported; each call is checked, not each line. Part C reinstalls the two backup scripts
  with it.
- The audit-log jobs, and part C's post-check, accept a target only when its user and host start
  with a letter or a digit, read it as text with `read_env`, and end rsync's options with `--`, so
  no value can reach rsync as an option.
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
  whatever its tag), `sshd`, `sshd-session` and `sudo`, counts address shapes from the nginx
  container apart (`shape_hits_nginx`, never failing) and sshd's apart (`shape_hits_sshd`, never
  failing), ignores systemd unit names when it matches the address shape, and keeps its working files in
  `/dev/shm`, so the list of account addresses never reaches the disk. The email-shape expression exists once, in
  `email-shape.regex`, and `lib/redact.ts` holds the same text; a test keeps the two equal.

These checks read the files as text. They stop a property being edited away
and cannot show that a restore works; the restore run on the server is the proof.
