# ADR-0010 — Console break-glass, and the integrity log that records it

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** owner + engineering
**Related:** ADR-0009 (the application roles, which this log is closed to)
**Register:** M0-11; vision components C17 (Integrity Log), C21 (Operations), C22 (Notifier);
Gate 2 decision G2-15 as amended by open decision OD I.5 (B)

## Context

The platform runs on one server. Everything on it, the database included, is reachable by
root, and root can change any software control on the host. The vision accepts that: the
guarantee against root is tamper *evidence*, not prevention.

G2-15, as amended by OD I.5, gives the operator two ways in and no others. Day to day:
SSH with the operator key and, from Task 23, a TOTP code. When SSH is gone, or the key is:
a root login at the Hetzner Cloud Console, the "break-glass". The console is a terminal on
the server's own `getty@tty1` and `serial-getty@ttyS0`. It goes through `login` and
`/etc/pam.d/login`, never through sshd, so it works when sshd is broken or misconfigured.

A way in that bypasses the normal one is the first thing an intruder looks for, and the
last thing an operator remembers to report. So each use must leave a record that root cannot
quietly edit, and must tell the people whose data is on the server, at the time.

## Decision

1. **The credential.** Root's password, used only at the Hetzner Cloud Console, which sits
   behind the `<owner>`'s Hetzner account and its two-factor authentication. It is generated
   in, and held only in, the `<owner>`'s password manager, letters and digits only (the
   browser console's keyboard mapping can mistype symbols). It is never typed, displayed or
   generated inside an AI session. SSH never accepts it: `PasswordAuthentication no` today,
   `PermitRootLogin prohibit-password` refuses passwords and keyboard-interactive for root,
   and from Task 23 the sshd PAM stack holds no password module at all. Rotated after any use
   other than a drill.
2. **The integrity log** (`prisma/migrations/20261008000200_integrity_log`), table
   `integrity_log`:
   - *Append-only.* A statement-level trigger refuses every UPDATE, DELETE and TRUNCATE for
     every role, the owner included. Statement-level, so a statement touching no row is
     refused too, and so are `INSERT ... ON CONFLICT DO UPDATE` and `MERGE`.
   - *Hash-chained.* `integrity_append(kind, actor_ref, detail)` is the one writer. It holds
     `pg_advisory_xact_lock(hashtext('integrity_log'))`, so appends are serial and `seq` has
     no gaps, and stores
     `hash = sha256(prev_hash|seq|at|kind|actor_ref|detail::text)` (`at` rendered by
     `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`, genesis `prev_hash`
     64 zeros). `at` is the wall clock after the lock (`clock_timestamp()`), cut to
     milliseconds, so it never runs backwards against `seq` and holds no digit the hash does
     not cover. `ops/host/integrity-hash.mjs` (`entryHash`) is the same formula in Node, for
     the daily reconcile (Task 22). The two runtimes cannot share code, so the formula is
     written twice; `__tests__/integration/integrity-log.test.ts` recomputes every stored
     hash with `entryHash` and fails if they differ.
   - *Closed to the application.* No grant to `makrai_app` or `makrai_identity` on the table
     or the function, and `REVOKE ALL ... FROM PUBLIC` on the function. Only the schema
     owner writes it. `role-grants.test.ts` already requires every table in `public` to carry
     no grant beyond ADR-0009's tables, and no callable function either role can execute.
   - At M0 the only kind is `break_glass.open`, with `actor_ref` `console:<PAM_USER>` and
     `detail` `{"channel":"hetzner-console","tty":"<PAM_TTY>"}`.
3. **The hook.** `/etc/pam.d/login` gains one line, after `@include common-session`:
   `session optional pam_exec.so quiet type=open_session /usr/local/sbin/makrai-break-glass-session`.
   The hook (`ops/host/makrai-break-glass-session`) acts only when `PAM_TYPE=open_session`
   and `PAM_SERVICE=login`, so SSH sessions, sudo and logouts write nothing. It:
   1. appends the entry, through `docker exec -i docker-postgres-1 psql` as `POSTGRES_USER`;
   2. sends the notice (decision 4);
   3. writes one journald line, tag `makrai-break-glass`:
      `entry=<id> seq=<n> hash=<64 hex> notice=<status>`, or `entry=FAILED notice=<status>`.
      Task 22 ships these lines off the host hourly and checks each shipped hash against the
      chain daily.
4. **The notice** goes to `ALERT_TO` (`ADMIN_EMAIL` in the server `.env`) and to the active
   owners and admins of every organisation, in `bcc` so that no owner sees another
   organisation's addresses. It carries only the event, the UTC time and the entry id; its
   text is `ops/host/break-glass-notice.txt`, read from the server checkout.
5. **Access never waits on logging, notification or a terminal** (P3). The hook has no
   `set -e`, runs every step whatever the last one did, and always exits 0; `optional` means
   PAM ignores it even if it crashes. The database step and the notice each run under
   `timeout -k 1 ${BG_TIMEOUT:-10}` and the log line under `timeout -k 1 2`, so a hung
   database, mailer or logger holds a console login for at most about 25 s. BG_TIMEOUT is
   taken from the environment pam_exec passes, never from `.env`, and only 1 to 30 counts
   (0 would make `timeout` wait forever). The server is given a `statement_timeout` half a
   second under BG_TIMEOUT: killing `docker exec` does not stop psql inside the container,
   and without it an append stuck behind a lock finished after the hook had logged
   `entry=FAILED` (seen on a local cluster), leaving an entry with no shipped hash.
6. **No user text reaches SQL** (P5). The entry is built from `PAM_USER` and `PAM_TTY` only,
   each cut to a short whitelist of characters, then handed to psql as variables (`\set`) that
   the SQL reads as `:'user'` and `:'tty'`. The SQL is a quoted heredoc; the shell expands
   nothing in it.
7. **The hook stands alone** (D-10). It reads `.env` itself, as text, taking only
   `POSTGRES_USER`, `POSTGRES_DB`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` and `ADMIN_EMAIL`,
   and never runs it; it does not source `makrai-lib.sh`. A broken library or a line of
   shell in `.env` cannot break the way back in, or run as root. The Resend key and every
   address reach curl as a config on stdin (`--config -`, written by the `printf` builtin),
   never in argv; the log line carries no address.

### Deviations recorded here

- **Not C22's delivery log.** C22 (Notifier) records each notice in the platform's in-app
  delivery log. This notice is sent from the host, through Resend, because it must go out
  when the application is the thing that is broken. Its delivery record is the shipped
  `notice=` field: `sent`, or `failed:<reason>`, where the reason is the HTTP status Resend
  returned (`000`: no response), `recipients` (Resend accepted it but the owner list could not
  be read, so only `ALERT_TO` was sent it), `config` (key, sender or `ALERT_TO` missing) or
  `template` (the notice text could not be read). Task 22's reconcile fails on any
  `notice=failed`.
- **No reason prompt.** The operator is not asked why they broke the glass. pam_exec gives
  the hook no terminal to ask on, and a prompt that waited for an answer would make access
  wait (P3). The reason goes in the incident record afterwards.

## Limits

These are what this design does **not** do. Each is a property of the platform, not an
oversight in the hook.

1. **Root can disable a trigger, drop the table or rewrite the chain** (P1). The owner role is
   a superuser. Until M3 anchors the chain externally (C17), the evidence that survives a root
   rewrite is the hashes already shipped off the host, checked against the chain, and the
   shipped `login` lines that say a console session happened. A rewrite after shipping shows
   as a hash mismatch; a login whose entry was suppressed shows as a console login without an
   entry.
2. **Hetzner-side root paths bypass host logging entirely.** The Rescue system, the
   root-password reset through the guest agent (active on this server) and disk snapshots all
   reach the data without a login on the host. Only the Hetzner account's two-factor
   authentication governs them. That the guest-agent reset runs `chpasswd`, and so would show
   in Task 22's `rootPasswordChanges`, is believed, not verified (F-30).
3. **An approval window is unrestricted root** (F-29). While the `<owner>` has a window open,
   an agent holds root. The window-close baseline diff catches new keys, authentication
   methods, PAM and sudoers changes, but not other persistence, such as a cron job or a
   systemd unit. This is the vision's stated limit: root bypasses software, so the guarantee
   is tamper evidence.
4. **Operator sessions are root access too.** Key-and-code SSH sessions (Task 23) are not
   break-glass and write no entry here. Shipped sshd lines log them, and every daily
   reconcile counts them (Task 22). Agents reach the server only inside owner-opened approval
   windows. A forced-command dispatcher for the operator key is the M1 issue (Task 37).
5. **A failed step is recorded, not retried.** If the database is down, the login proceeds,
   no entry is written and the line says `entry=FAILED`; the console login itself is still in
   the shipped `login` lines. If the shipped line is lost too (journald down), only the
   `login` line and the absent notice remain. If the owner list cannot be read, only
   `ALERT_TO` hears of it, and the line says so.
6. **One mail for everyone.** `ALERT_TO` is the only `to` address (Resend's send-email
   reference caps `to` at 50 and states no maximum for `bcc`, checked 2026-10-08); every owner
   and admin is in `bcc`. If Resend refuses a large `bcc` list it has not documented a limit
   for, the line says `failed:<status>`. At M0 the platform has a handful of organisations.
7. **The notice text is read from the server checkout.** If the checkout lacks
   `ops/host/break-glass-notice.txt`, no notice is sent and the line says `failed:template`.
   DEPLOY keeps the checkout current.

## Consequences

**Positive**

- Every console root login leaves an entry, a shipped hash and a notice, or a shipped line
  saying which of them failed. None of them can delay or refuse the login.
- The record is closed to the application: a defect or an injection in either lane cannot
  read, forge or erase it.
- A restore keeps the property: pg_dump creates the trigger after the rows are copied, and
  COPY is an insert. `integrity-log.test.ts` loads a COPY into a migrated, empty table and
  then sees UPDATE, DELETE and TRUNCATE refused.

**Negative, accepted**

- The table can never be emptied, in any environment. `resetDb()` leaves it out of its
  TRUNCATE, and test databases accumulate entries.
- The hash formula exists in two languages, held together by a test, not by shared code.
- A second copy of the `.env` reading logic, in the hook, by design (D-10).

## Alternatives rejected

- **Send the notice through the application (C22).** It is the obvious path and the wrong
  one for this event: break-glass is used when the application or its host is broken.
- **Source `makrai-lib.sh` for `load_env` and `alert`.** Fewer lines, but the console path
  would then depend on another file and run `.env` as root.
- **`session required`, so a login without an entry is refused.** It would turn a broken
  database into a locked-out operator: the failure break-glass exists to survive.
- **A row trigger that recomputes the chain on insert.** It would refuse a restore's COPY
  unless it reproduced the function exactly, and root can disable it anyway; the shipped
  hashes are the evidence that does not depend on the host.
- **Ask for a reason at the console.** pam_exec has no terminal, and waiting for an answer
  breaks P3.

## References

- `prisma/migrations/20261008000200_integrity_log/migration.sql`; `prisma/schema.prisma`
  (`IntegrityLogEntry`)
- `ops/host/makrai-break-glass-session`, `ops/host/break-glass-notice.txt`,
  `ops/host/integrity-hash.mjs`, `ops/host/pam.d-login`
- `__tests__/integration/integrity-log.test.ts`, `__tests__/unit/break-glass-session.test.ts`,
  `__tests__/lint/ops-host-scripts.test.ts`, `__tests__/integration/role-grants.test.ts`
