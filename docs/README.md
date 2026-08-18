# Documentation

Everything in this directory describes the software in this repository: how it is designed,
how to operate it, and the conventions a contributor follows.

Working material for the maintainers — planning notes, audit transcripts, the decision
register, and the operating instructions for the team's tooling — is deliberately kept
outside this repository. A repository holds the software and what is needed to build, run,
review and operate it.

## Architecture decisions

Records of decisions that are expensive to reverse. Read these before changing how data is
reached or how the framework is versioned.

| Record | Decides |
| --- | --- |
| [`adr/0001-data-access-architecture.md`](adr/0001-data-access-architecture.md) | Tenant isolation is enforced by Postgres row-level security, keyed on a transaction-scoped setting. Application code never re-filters by organization id. |
| [`adr/0002-identity-and-account-linking.md`](adr/0002-identity-and-account-linking.md) | How accounts, credentials and organization membership relate. |
| [`adr/0003-framework-version-registry-third-lane.md`](adr/0003-framework-version-registry-third-lane.md) | Framework content is versioned and hash-pinned; assessments pin the version they were answered against. |
| [`adr/README.md`](adr/README.md) | When an ADR is required, and the format. |

## Operations

| Runbook | Covers |
| --- | --- |
| [`runbooks/deployment.md`](runbooks/deployment.md) | Deploying the stack. |
| [`runbooks/backup-restore.md`](runbooks/backup-restore.md) | Backups and restore. |
| [`runbooks/troubleshooting.md`](runbooks/troubleshooting.md) | Diagnosing a running system. |

> **These runbooks are known to be incomplete and are not yet trustworthy.** They predate the
> current architecture, have never been executed end to end, and name a deployment hostname that
> has never been confirmed. Each carries a warning at its head. Treat them as drafts and expect
> to correct them while performing the first real deployment.

## Product

- [`VISION_AND_PLAN.md`](VISION_AND_PLAN.md) — what the platform is for, the adopter it is built
  for, and the standards it implements.

## Security

- [`security/2026-08-10-registration-rate-limit-threat-derivation.md`](security/2026-08-10-registration-rate-limit-threat-derivation.md)
  — a worked threat derivation for the registration rate limit: what it defends, what it cannot,
  and the measurements behind the numbers.
- [`../SECURITY.md`](../SECURITY.md) — how to report a vulnerability.

## Contributing

- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — setup, the gates a change must pass, and the
  tenancy rule most likely to be broken.
- [`COMMIT_CONVENTION.md`](COMMIT_CONVENTION.md) — commit message format and what does not
  belong in one.
