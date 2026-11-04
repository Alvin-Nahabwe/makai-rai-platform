# ADR-0014: The hourly reminder job runs through an internal route that host cron calls

**Status:** Accepted · **Date:** 2026-10-29 · **Deciders:** owner (SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)

*Option (a) of SRS 9.7, the recommendation that FR-OPS-02 adopted (line 3742). ADR-C4 has no file: it was removed in revision 0.6 (line 3736).*

## Context

Core FR-OPS-02 and section 6.6 say "a command shipped in the web image (for example
`node scripts/send-reminders.mjs`)". The runner image contains no `scripts/` directory and no
TypeScript (`docker/Dockerfile`, runner stage), so a separate command cannot import the app's data
layer, policy or email module. The core's reason for a command (no network surface, no shared secret,
core call 14) still holds as a goal.

The options were: (a) an internal route in the app, refused by nginx (`location /api/internal/ { return
404; }`), called by host cron with `docker compose exec` running Node's own `fetch` to
`127.0.0.1:3000` (the integrated draft's choice over BusyBox `wget`, whose header support is
unverified) and a token read from the container's own environment, so the token never appears on the
host command line; (b) a self-contained `.mjs` script mounted into a throwaway container of the web
image (as the synthetic journey is), with the due-reminder rules in a SQL function under RLS and email
sent by direct HTTP to Resend; (c) a separately bundled TypeScript entry point added to the image; (d)
run it in the migrator image with an overridden environment.

## Decision

Option (a). It reuses the tested data layer, the follow-up rules and the email templates, so the
overdue rule and the "no record text" rule have one implementation each. nginx refuses the path and
the token does not leave the container. Accepted in the integrated draft: FR-OPS-02 and section 6.6
now say this (IC-3; gap NF-3).

## Consequences

- One new secret in `.env` (NFR-SEC-14; `env-secrets-manager` applies to that change), compared with
  `crypto.timingSafeEqual`.
- A `systemContext(orgId, purpose)` designed in K0 by Opus, importable only by the reminder module.
- `pg_try_advisory_lock` against overlapping runs and a claimed row before each send (section 6.6).
- A `NON_ACTION_ROUTES` entry with a stated reason.
- An nginx rule and its test (NFR-SEC-13).

## Alternatives rejected

- (b) A self-contained script. Rejected: it duplicates the email templates and the transport outside
  the tested code, so the rule "no record text in email" would have two implementations.
- (c) A separately bundled TypeScript entry point. Rejected: it adds build tooling on the critical
  days, and bundling the Prisma client this way is untested here (unverified).
- (d) Run it in the migrator image. Rejected: it puts a superuser connection string next to the job.

## References

- SRS 9.7 ADR-C5 (line 3738); the recommendation at line 3742.
- FR-OPS-02, NFR-SEC-14, NFR-SEC-13; SRS 6.6; IC-3; gap NF-3; core call 14.
- NFR-MNT-06 (this record).
- Specification: MAK-AI RAI Platform v1, Software Requirements Specification, revision 0.6, section 9.7.
