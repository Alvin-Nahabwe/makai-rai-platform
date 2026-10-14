# ADR-0010 — Console break-glass, and the integrity log that records it

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** owner + engineering
**Related:** ADR-0009 (the application roles, which this log is closed to)
**Register:** M0-11; vision components C17 (Integrity Log), C21 (Operations), C22 (Notifier);
Gate 2 decision G2-15 as amended by open decision OD I.5 (B). Identifiers of the form D-nn
and F-nn below are decisions and findings in the Phase C plan of record, not rows in
`docs/DEFERRED_REGISTER.md`.

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
   `PermitRootLogin prohibit-password` refuses passwords and keyboard-interactive for root
   *(superseded 2026-10-14: see "Amendment, 2026-10-14" at the end)*,
   and from Task 23 the sshd PAM stack holds no password module at all. Rotated after any use
   other than a drill.
2. **The integrity log** (`prisma/migrations/20261008000200_integrity_log`), table
   `integrity_log`:
   - *Append-only.* A statement-level trigger refuses every UPDATE, DELETE and TRUNCATE for
     every role, the owner included. Statement-level, so a statement touching no row is
     refused too, and so are `INSERT ... ON CONFLICT DO UPDATE` and `MERGE`. The trigger is
     `ENABLE ALWAYS`, so `session_replication_role = replica`, which silences ordinary
     triggers without DDL, does not silence it; only an explicit `ALTER TABLE ... DISABLE
     TRIGGER` does.
   - *Hash-chained.* `integrity_append(kind, actor_ref, detail)` is the one writer. It takes
     `LOCK TABLE integrity_log IN SHARE UPDATE EXCLUSIVE MODE`, so appends are serial and
     `seq` has no gaps. It stores
     `hash = sha256(prev_hash|seq|at|kind|actor_ref|detail::text)`, where `at` is rendered by
     `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` and the genesis
     `prev_hash` is 64 zeros. `at` is the wall clock after the lock (`clock_timestamp()`),
     cut to milliseconds, so it never runs backwards against `seq` and holds no digit the
     hash does not cover. `ops/host/integrity-hash.mjs` (`entryHash`) is the same formula in
     Node, for the daily reconcile (Task 22). The two runtimes cannot share code, so the
     formula is written twice (D-11). `__tests__/integration/integrity-log.test.ts`
     recomputes every stored hash with `entryHash`, in a session whose time zone is not UTC.
   - *Closed to the application.* No grant to `makrai_app` or `makrai_identity` on the table
     or the function, and `REVOKE ALL ... FROM PUBLIC` on the function. Only the schema
     owner writes it. `role-grants.test.ts` already requires every table in `public` to carry
     no grant beyond ADR-0009's tables, and no callable function either role can execute.
   - *Neither role can stall an append through a lock.* `LOCK TABLE` in the append's mode
     needs a privilege neither role holds. Without one, a role can still take a few locks on
     the table through parse analysis, which opens a query's tables before the executor
     checks privileges: ACCESS SHARE, ROW SHARE and, for a `PREPARE`d INSERT, ROW EXCLUSIVE.
     None of them conflicts with SHARE UPDATE EXCLUSIVE. Tested per role, with a session
     holding a prepared INSERT open: `an application role holding a parsed INSERT cannot
     stall an append`.
   - At M0 the only kind is `break_glass.open`, with `actor_ref` `console:<PAM_USER>` and
     `detail` `{"channel":"hetzner-console","tty":"<PAM_TTY>"}`.
3. **The hook.** `/etc/pam.d/login` gains one line, after `@include common-session`:
   `session optional pam_exec.so quiet type=open_session /usr/local/sbin/makrai-break-glass-session`.
   The hook (`ops/host/makrai-break-glass-session`) acts only when `PAM_TYPE=open_session`
   and `PAM_SERVICE=login`, so SSH sessions, sudo and logouts write nothing. It:
   1. appends the entry, through `docker exec -i docker-postgres-1 psql` as `POSTGRES_USER`;
   2. sends the notice (decision 4);
   3. writes one journald line, tag `makrai-break-glass`, in one of three forms:
      - `entry=<id> seq=<n> hash=<64 hex> notice=<status>`: the entry landed.
      - `entry=FAILED notice=<status>`: the database step ended without an entry line, so
        nothing was written. The rare exception is a connection lost during the commit,
        which the no-shipped-hash rule below catches.
      - `entry=UNCERTAIN notice=<status>`: the database step was cut off before it answered,
        so an entry may have landed unseen.

      When `.env` or the notice text was refused, ` env=<why>` and ` text=<why>` follow,
      with `<why>` one of `missing`, `symlink`, `type`, `owner`, `read`. Task 22 ships these
      lines off the host hourly and checks each shipped hash against the chain daily.
      **Task 22 treats a row with no shipped hash as reportable,** not as an error in the
      reconcile: it is what `entry=UNCERTAIN` (or a lost line) leaves behind.
4. **The notice** goes to `ALERT_TO` (`ADMIN_EMAIL` in the server `.env`) and to the active
   owners and admins of every live organisation: memberships with `status = 'active'`, of
   users with `isActive`, in organisations whose `deletedAt` is null, the application's own
   definition of a live organisation.
   - **One call, one email per recipient.** The hook makes one call to Resend's batch
     endpoint (`POST /emails/batch`, `x-batch-validation: permissive`). It carries one email
     per recipient, each with its own `to` and no `cc` or `bcc`. So no recipient sees
     another's address or `ADMIN_EMAIL`, and no copy goes to the sender's own address.
     `ALERT_TO` is first, then the owners and admins in address order, each address once
     whatever its case. At most 100 emails go: Resend's batch limit (Limit 9).
   - **Content.** The notice carries only the event, the UTC time and the entry id. Its
     text is `ops/host/break-glass-notice.txt`, read from the server checkout.
   - **The answer is classified, never logged.** In permissive mode Resend sends every valid
     email and lists each refused one as `errors[{index, message}]`, the index 0-based in the
     batch.
     - *Sources:* the `resend` SDK 6.16.0, `CreateBatchSuccessResponse`; Resend's batch
       reference for the 0-based order and the 100 limit.
     - *Not documented:* the HTTP status of a permissive reply with errors. So any non-2xx
       counts as the request failing.
     - *What is read:* the body only, and only for `"data"`, `"errors"` and index 0. It is
       never logged, because an error message can quote an address.
5. **Access never waits on logging, notification or a terminal** (P3).
   - **It cannot fail the login.** The hook has no `set -e`, runs every step whatever the
     last one did, and always exits 0. `optional` means PAM ignores it even if it crashes.
     It ignores INT, TERM, HUP, QUIT and TSTP, so a keystroke or a dropped console cannot end
     or suspend it part-way.
   - **Every external step is bounded.**
     - The database step and the notice: `timeout -k 1 ${BG_TIMEOUT:-10}`.
     - The owner check (`stat`) and the two file reads (`head`): `timeout -k 1 1`.
     - The log line, which carries the shipped hash: `timeout -k 1 2`.
   - **The worst case is about 27 s at the default:** B + 1 for the database, B + 1 for the
     mail, 2 + 1 for the log line, and file reads that succeed in well under a second. A hung
     file read skips the step it feeds, so it never adds to those terms. Measured with
     docker, curl and logger all hung at the default (2026-10-08): 22.01 s when they honour
     TERM, and 25.01 s when they ignore it. The first re-review measured 21.0 s on its own
     stubs.
   - **BG_TIMEOUT.** It comes from the environment pam_exec passes, never from `.env`. Only 1
     to 30 counts; 0 would make `timeout` wait forever. Above 10 the worst case passes the
     drill's 30 s threshold, so production leaves it unset.
   - **The server stops at the hook's own deadline.** Killing `docker exec` does not stop
     psql inside the container. Without a server-side bound, an append stuck behind a lock
     finished after the hook had logged `entry=FAILED` (seen on a local cluster). The hook
     passes an absolute deadline: the wall-clock moment half a second before `timeout` stops
     the client. Before each statement it sets `statement_timeout` to the time left. The
     container shares the host's clock, so neither statement can run past the hook's window.
   - **Files it reads are checked first.** `.env` and the notice text are read only from a
     regular file (not a symlink, a FIFO or a device) owned by root or by the operator (the
     owner of the server checkout, `/srv/makrai/app`), and only under `timeout`. A refused
     file is named in the log line and the hook goes on.
6. **No user text reaches SQL** (P5). The entry is built from `PAM_USER` and `PAM_TTY` only,
   each cut to a short whitelist of characters, then handed to psql as variables (`\set`) that
   the SQL reads as `:'user'` and `:'tty'`. The SQL is a quoted heredoc; the shell expands
   nothing in it.
7. **The hook stands alone** (D-10).
   - It reads `.env` itself, as text, taking only `POSTGRES_USER`, `POSTGRES_DB`,
     `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` and `ADMIN_EMAIL`, and never runs it. It does
     not source `makrai-lib.sh`. A broken library or a line of shell in `.env` cannot break
     the way back in, or run as root.
   - The Resend key and every address reach curl as a config on stdin (`--config -`,
     written by the `printf` builtin), never in argv. `curl -q` keeps any `~/.curlrc` out,
     as `psql -X` keeps any psqlrc out.
   - The log line carries no address.

### Deviations recorded here

- **Not C22's delivery log.** C22 (Notifier) records each notice in the platform's in-app
  delivery log. This notice is sent from the host, through Resend, because it must go out
  when the application is the thing that is broken.
  - **The delivery record** is the shipped `notice=` field: `sent`, or `failed:<reason>`.
    The reason is one of:
    - the HTTP status Resend returned for the request (`000`: no response);
    - `alert`: `ALERT_TO`'s email was not accepted;
    - `recipients`: `ALERT_TO`'s was, but some owner or admin got none, because the list
      could not be read, an address was refused, or the batch was cut at 100;
    - `config`: key, sender or `ALERT_TO` missing or malformed;
    - `template`: the notice text could not be read.
  - `;truncated` follows when the batch was cut.
  - Task 22's reconcile fails on any `notice=failed`. Its parser takes
    `(sent|failed:(\d{3}|alert|recipients|config|template))(;truncated)?`.
- **No reason prompt.** The operator is not asked why they broke the glass. pam_exec gives
  the hook no terminal to ask on, and a prompt that waited for an answer would make access
  wait (P3). The reason goes in the incident record afterwards.
- **A table lock, not the advisory lock the plan named.** The plan's interface serialised
  appends with `pg_advisory_xact_lock(hashtext('integrity_log'))`. Advisory locks are open to
  every role, and that key is published in this repository, so either application role
  could hold it and make every append time out (`entry=FAILED`).
  - **The replacement.** `LOCK TABLE ... IN SHARE UPDATE EXCLUSIVE MODE` serialises appends
    the same way, because the mode conflicts with itself. It does not block `pg_dump`'s
    ACCESS SHARE. Taking it with `LOCK TABLE` needs a privilege neither role holds, and it
    conflicts with none of the parse-time modes an unprivileged role can still take.
  - **Why not SHARE ROW EXCLUSIVE.** An earlier fix round used it. It conflicts with the ROW
    EXCLUSIVE that a role holds without any grant once it has `PREPARE`d an INSERT into the
    table and stays in its transaction. That stalled every append until the deadline
    (observed: cancelled at 2028 ms).
  - **Tested:** `an application role cannot stall an append`, and `an application role
    holding a parsed INSERT cannot stall an append`.
  - **Informational.** Like any SHARE UPDATE EXCLUSIVE holder, an append briefly conflicts
    with autovacuum on this table. Autovacuum yields, and an append takes milliseconds.

## Limits

These are what this design does **not** do. Each is a property of the platform, not an
oversight in the hook.

1. **Root can disable a trigger, drop the table or rewrite the chain** (P1).
   - The owner role is a superuser.
   - **What survives a root rewrite,** until M3 anchors the chain externally (C17): the
     hashes already shipped off the host, checked against the chain, and the shipped `login`
     lines that say a console session happened.
   - A rewrite after shipping shows as a hash mismatch. A login whose entry was suppressed
     shows as a console login without an entry.
2. **Hetzner-side root paths bypass host logging entirely.**
   - The Rescue system, the root-password reset through the guest agent (active on this
     server) and disk snapshots all reach the data without a login on the host.
   - Only the Hetzner account's two-factor authentication governs them.
   - That the guest-agent reset runs `chpasswd`, and so would show in Task 22's
     `rootPasswordChanges`, is believed, not verified (F-30).
3. **Boot-time root at the console bypasses `/etc/pam.d/login`.**
   - From the same console, a reboot into GRUB with `init=/bin/bash`, or into the rescue or
     emergency target (`sulogin`, which does not use this PAM stack), reaches root with no
     entry and no notice.
   - What remains is an unexpected reboot in the shipped logs.
   - It sits behind the same Hetzner account 2FA as the Rescue system. Task 22 could flag
     unscheduled boots.
4. **The hourly shipping gap.** Between a console login and the next hourly ship, root can
   delete that login's journald lines and rewrite its row. In that window the notice, already
   in the recipients' mailboxes, is the only record off the host.
5. **An approval window is unrestricted root** (F-29).
   - While the `<owner>` has a window open, an agent holds root.
   - The window-close baseline diff catches new keys, authentication methods, PAM and sudoers
     changes, but not other persistence, such as a cron job or a systemd unit.
   - This is the vision's stated limit: root bypasses software, so the guarantee is tamper
     evidence.
6. **Operator sessions are root access too.**
   - Key-and-code SSH sessions (Task 23) are not break-glass and write no entry here.
   - Shipped sshd lines log them, and every daily reconcile counts them (Task 22).
   - Agents reach the server only inside owner-opened approval windows. A forced-command
     dispatcher for the operator key is the M1 issue (Task 37).
7. **A failed step is recorded, not retried.**
   - If the database is down, the login proceeds, no entry is written and the line says
     `entry=FAILED`. The console login itself is still in the shipped `login` lines.
   - If the shipped line is lost too (journald down), only the `login` line and the absent
     notice remain.
8. **An application lane can cost the notice its owner list, never the entry.**
   - **How.** `makrai_app` holds UPDATE and DELETE on `memberships`, and `makrai_identity`
     UPDATE on `users` (ADR-0009). So either can lock a table the recipients query reads,
     until the deadline.
   - **What still happens.** The append runs first and reads neither, so it lands. The owner
     list is lost, but the notice still reaches `ALERT_TO`. The line says
     `notice=failed:recipients`, which the reconcile flags.
   - **Tested:** `an application lane can cost the notice its owner list, never the entry`.
9. **At most 100 emails per notice: Resend's batch limit.**
   - **Past 99 live owners and admins,** `ALERT_TO` and the first 99 by address are sent and
     the rest are not. The line says `notice=failed:recipients;truncated`.
   - **Quota.** Each recipient counts as one email against the Resend quota.
   - **Testing sender.** Resend's testing sender delivers only to the Resend account's own
     address, so it refuses every other email. Whether permissive mode still sends
     `ALERT_TO`'s copy in that case is not verified. The drill (Task 21 step 8) shows it.
10. **The notice text is read from the server checkout.**
    - If the checkout lacks `ops/host/break-glass-notice.txt`, or the file fails the file
      checks, no notice is sent and the line says `failed:template` with the reason.
    - DEPLOY keeps the checkout current.

## Consequences

**Positive**

- Every console root login leaves an entry, a shipped hash and a notice, or a shipped line
  saying which of them failed or is uncertain. None of them can delay or refuse the login.
- **The record is closed to the application.** A defect or an injection in either lane
  cannot read, forge or erase an entry, or stall an append, by any of these routes: a
  grant, `LOCK TABLE`, the old advisory key, or a parse-time lock. Locking a table the
  recipients query reads can cost the notice its owner list (Limit 8), never the entry.
- **A restore keeps the property.** pg_dump creates the trigger, with its ALWAYS state,
  after the rows are copied, and COPY is an insert. `integrity-log.test.ts` loads a COPY
  into a migrated, empty table and then sees UPDATE, DELETE and TRUNCATE refused.

**Negative, accepted**

- The table can never be emptied, in any environment. `resetDb()` leaves it out of its
  TRUNCATE, and test databases accumulate entries.
- The hash formula exists in two languages, held together by a test, not by shared code.
- A second copy of the `.env` reading logic, in the hook, by design (D-10).
- The hook reads Resend's response body, but only for three keys, and never logs it.

## Alternatives rejected

- **Send the notice through the application (C22).** It is the obvious path and the wrong
  one for this event: break-glass is used when the application or its host is broken.
- **Source `makrai-lib.sh` for `load_env` and `alert`.** Fewer lines, but the console path
  would then depend on another file and run `.env` as root.
- **`session required`, so a login without an entry is refused.** It would turn a broken
  database into a locked-out operator: the failure break-glass exists to survive.
- **A row trigger that recomputes the chain on insert.** It would refuse a restore's COPY
  unless it reproduced the function exactly, and root can disable it anyway. The shipped
  hashes are the evidence that does not depend on the host.
- **Ask for a reason at the console.** pam_exec has no terminal, and waiting for an answer
  breaks P3.
- **`ALERT_TO` as the visible `to`.** It disclosed the alert inbox to every owner and admin
  of every organisation, including self-registered ones.
- **One email with every recipient in `bcc`, and the sender as `to`.** It failed three ways,
  and the permissive batch fixes all three:
  - it sent a copy to the sender's no-reply address on every break-glass, so it bounced
    whenever that address takes no mail;
  - it was all-or-nothing: one address Resend refused would silence `ALERT_TO` too;
  - Resend documents no `bcc` maximum.

## References

- `prisma/migrations/20261008000200_integrity_log/migration.sql`; `prisma/schema.prisma`
  (`IntegrityLogEntry`)
- `ops/host/makrai-break-glass-session`, `ops/host/break-glass-notice.txt`,
  `ops/host/integrity-hash.mjs`, `ops/host/pam.d-login`
- `__tests__/integration/integrity-log.test.ts`, `__tests__/unit/break-glass-session.test.ts`,
  `__tests__/lint/ops-host-scripts.test.ts`, `__tests__/integration/role-grants.test.ts`

---

## Amendment, 2026-10-14 — Decision 1: how SSH refuses root's password

Decision 1's clause "`PermitRootLogin prohibit-password` refuses passwords and keyboard-interactive
for root" is superseded. It stays above as the record of what was first decided. On OpenSSH 9.6,
`prohibit-password` also disables keyboard-interactive authentication for root, so the TOTP code
stage (OD I.5) could never run for the one account that logs in over SSH. From the Task 23
switch, SSH has:

- `PermitRootLogin yes`;
- `AuthenticationMethods publickey,keyboard-interactive:pam`: the operator key, then the code;
- a PAM auth stack of only `pam_google_authenticator.so`, without `nullok`.

Root's password is still never accepted over SSH. Password is not a method in that list,
`PasswordAuthentication` is `no`, and the PAM stack holds no password module. The settings live in
`ops/host/50-makrai-sshd.conf` and `ops/host/pam.d-sshd`, and
`__tests__/lint/ops-host-scripts.test.ts` pins each of them. The console credential, and the rest
of Decision 1, is unchanged.
