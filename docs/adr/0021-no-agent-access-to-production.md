# ADR-0021: No AI session reaches the production host or its data

**Status:** Accepted · **Date:** 2026-10-31 · **Deciders:** owner (ruling 13; NFR-SEC-17 of SRS revision 0.6, approved 29 Oct 2026 13:14 EAT)
**Supersedes in part:** ADR-0010, the approval-window arrangement (its residual risks 5 and 6: an agent holds root during an owner-opened window, and agents reach the server only inside such windows)

## Context

Until v0.5.x the owner could open a timed SSH connection for an AI agent to ride, to read the
production host (`docs/runbooks/deployment.md` 12.2 as it was; ADR-0010 residual risks 5 and 6).
That was tolerable while production held two test-like accounts and no records (assumption A-6).
From v0.6.0 it holds real teams' records. Root on the host reads the database and the backup
passphrase in `.env`.

Ruling 13 decides this, so NFR-SEC-17 states it as a requirement and not an open decision (it was
raised as OD-N2; IC-13).

## Decision

From v0.6.0 no AI session reaches the production host or its data. The owner runs every production
step, in the owner's own session, in a terminal outside any AI session. No database query, backup
file, application log, export, generated document or `.env` content of the production host reaches
an AI session, and no output of the host is pasted into one (NFR-SEC-17). The owner may widen this;
the specification does not.

`docs/runbooks/deployment.md` 12.2 says so ("The access baseline, and no agent windows"), and 8.5,
9.5 and 12.6 are the owner's steps. `ops/host/README.md` "## Rules" carries it into the host
procedures. This replaces ADR-0010's approval-window arrangement; the rest of ADR-0010 (the console
break-glass hook and the integrity log) stands.

## Consequences

- The owner alone runs and reads every production step, and tells the release team only a decision
  (for example "I proceed with the deploy"), never a count or a line the host printed.
- What an agent used to verify by reading the host (the rotation's W1 to W4 reads, the restore-test
  line, the access baseline) the owner reads. The rotation procedure and its script still name an
  agent for those reads; a banner in `ops/host/README.md` marks the procedure as not to be run until
  it is rewritten for the owner alone, and that rewrite is open (trigger: the first rotation).
- The access-baseline record is host output, so it is kept outside any directory an AI session
  reads.
- Values computed from the repository, not from the host, may still come from an agent, but the
  owner computes the sha256 values that root compares in a staged install.

## Alternatives rejected

- Keep timed approval windows for agents, with the window-close baseline diff (the v0.5.x rule,
  ADR-0010). Rejected: the diff catches changes to access settings but not other persistence, and
  from v0.6.0 root on the host reads real teams' records and the backup passphrase.

## References

- NFR-SEC-17 and NFR-PRIV-05 (SRS 8, operating procedures); ruling 13; constraint K-10;
  assumption A-6; OD-N2; IC-13.
- `docs/runbooks/deployment.md` 12.2; `docs/adr/0010-break-glass-and-integrity-log.md` residual
  risks 5 and 6.
- NFR-MNT-06 (this record).
