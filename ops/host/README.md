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
script. `SYNTHETIC_PASSWORD` is letters and digits only, and at least 8 of them (see Rules).

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

**The check.** The job pings one healthchecks check, `makrai-synthetic` (Cron `7 * * * *`, UTC,
grace 30 minutes), whose UUID ping URL is `HC_SYNTHETIC_PING_URL` in the server `.env`. The host is
its only sender: the workflow `synthetic.yml` is manual-only and never pings. It stays as an
off-host smoke test, `gh workflow run synthetic.yml`, for one question during an incident: is it
the host or the world? A failing journey sends `/fail` at once; a host, cron or Docker that is dead
is reported when a :07 slot goes 30 minutes without its ping.

The check was made as `makrai-synthetic-host` so that it could run beside the old
`makrai-synthetic` check, which the workflow pinged, without any check having two senders. Right
after the change that made `synthetic.yml` manual-only has merged, the owner finishes the move, in
this order:

1. delete the old `makrai-synthetic` check in the healthchecks dashboard;
2. delete the GitHub secret `HC_SYNTHETIC_PING_URL`, with
   `gh secret delete HC_SYNTHETIC_PING_URL -R <owner>/<repo>`, in a terminal outside the Claude app;
3. rename `makrai-synthetic-host` to `makrai-synthetic` (its URL does not change) and switch it to
   Cron `7 * * * *`, UTC, grace 30 minutes;
4. check that GitHub has stopped running the schedule:
   `gh run list -R <owner>/<repo> --workflow synthetic.yml --event schedule -L 1` shows no run
   created after the merge.

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
URL of the host's check, `makrai-synthetic` (until the owner's rename, `makrai-synthetic-host`; the
URL does not change):

```bash
for k in SYNTHETIC_EMAIL SYNTHETIC_PASSWORD SYNTHETIC_ORG_SLUG SYNTHETIC_ASSESSMENT_ID HC_SYNTHETIC_PING_URL; do setenv_secret "$k"; done
```

Pre-check B, counts and status only:

```bash
grep -cE '^(SYNTHETIC_EMAIL|SYNTHETIC_PASSWORD|SYNTHETIC_ORG_SLUG|SYNTHETIC_ASSESSMENT_ID|HC_SYNTHETIC_PING_URL)=.' /srv/makrai/app/.env
grep -cE '^SYNTHETIC_PASSWORD=[A-Za-z0-9]{8,}$' /srv/makrai/app/.env
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
and `0` (no container left behind). After the next :07, the host's check shows a
ping. Report only the `rc`, the `step=` and `status=` lines and the counts. This one run also
settles what a test cannot: how Cloudflare treats the host's address, IPv4 from the default
bridge, the journey's output under `--log-driver none`, and a read-only root. If Cloudflare
challenges the host, the run fails every hour; the answer is the rollback below, never a WAF allow
rule or a rate-limit bypass for the synthetic account.

**The alert drill.** It proves the alarm against the host, the only sender: set
`SYNTHETIC_ASSESSMENT_ID` to an id of the same shape that does not exist, with
`V=<that id> setenv_put SYNTHETIC_ASSESSMENT_ID`; the next :07 must give `result=fail`, the check
must go down and an email must arrive. Restore the real id with
`setenv_secret SYNTHETIC_ASSESSMENT_ID`; the next :07 must bring the check back up.

**Rollback**, in a window. The host job goes first, so the host stops pinging before anything else
changes:

```bash
crontab /root/makrai-stage/crontab.root.prev
rm -f /usr/local/sbin/makrai-synthetic.sh /usr/local/lib/makrai/synthetic-journey.mjs
crontab -l | grep -c makrai-synthetic
```

Expect `0`: no line of root's crontab names the script any more. Right after
`crontab /root/makrai-stage/crontab.root.prev` has run, pause the host's check in the healthchecks
dashboard (`makrai-synthetic`, or `makrai-synthetic-host` until the rename), so that it does not
alert on pings it no longer gets.

The five keys may stay in `.env`, where nothing reads them. To remove them, keep the file's owner:

```bash
f=/srv/makrai/app/.env; ( umask 077; grep -vE '^(SYNTHETIC_(EMAIL|PASSWORD|ORG_SLUG|ASSESSMENT_ID)|HC_SYNTHETIC_PING_URL)=' "$f" > "$f.new" ) && cat "$f.new" > "$f" && shred -u "$f.new"
```

Never `sed -i` as root: it replaces the file and makes root its owner, which breaks the
operator's jobs.

Then the schedule goes back to GitHub, because `synthetic.yml` is manual-only and the host job is
gone. Do this whether or not the owner's steps under **The check** are done, and in this order, all
before the pull request below merges:

1. create the check `makrai-synthetic-gh` (Simple, period 1 day, grace 36 h, email on) and save its
   ping URL in the password manager: GitHub's schedule is hours late or does not fire, so it cannot
   meet an hourly check, and 36 h is the tolerance of the daily GitHub checks, `makrai-ci-audit` and
   `makrai-image-scan`;
2. set the GitHub secret `HC_SYNTHETIC_PING_URL` to that URL, with
   `gh secret set HC_SYNTHETIC_PING_URL -R <owner>/<repo>`, at its masked prompt, in a terminal
   outside the Claude app;
3. merge the pull request that gives the schedule back.

Never give the secret the URL of the host's check (`makrai-synthetic`, or `makrai-synthetic-host`
until the rename), which keeps its own URL and its Cron `7 * * * *`, grace 30 minutes setting for
the host job.

That pull request reverts commit c18fb6c (`ci: make the synthetic workflow manual-only`), which
brings back the `schedule:` trigger and the ping step of `synthetic.yml`, and in the same pull
request rewrites the wording of this README and of deployment.md 7.4 that says `synthetic.yml` is
manual-only, with its pins in `__tests__/lint/ops-host-scripts.test.ts`, to say that it is
scheduled again. Revert that commit, not the whole of the pull request that carried it: the pull
request also lowered the password floor of Pre-check B to `{8,}`, which the live password needs,
and reverting it whole would undo that.

Removing the host job from the repository is a separate, hand-written pull request, not a
`git revert` of #57, the pull request that added it: it deletes the crontab line in
`ops/host/crontab.root`, `ops/host/makrai-synthetic.sh`, the README and deployment.md text about the
job, and their pins in `__tests__/lint/dead-man-switches.test.ts`,
`__tests__/lint/ops-host-scripts.test.ts` and `__tests__/lint/service-parameters.test.ts`.

**Drift.** Root runs its own copy of the journey. Any change to `scripts/synthetic-journey.mjs`
ships with a staged reinstall of it, by the chain above. A stale copy is loud in the dangerous
direction (an API change it does not know turns into `/fail`), but a new check added to the
repository's journey does not reach the host until it is reinstalled. The script is coupled to
the container name `docker-nextjs-1`, which comes from the Compose project name `docker`; a
rename turns every run into `/fail`.

## Rules

Checked by `__tests__/lint/ops-host-scripts.test.ts`,
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
