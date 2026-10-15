# Security policy

This project scores other teams on whether they can show their governance works. It would be a poor
advertisement for that if someone who found a flaw here had nowhere to send it.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security problem.** A useful report
gives the affected path or file, what an attacker gains, and the shortest steps that show it; proof
against a local instance is welcome, and `README.md` covers bringing one up. Two routes, in order of
preference:

1. **Email** — `security@makrai.org`, a role address on the project's own domain that reaches
   the maintainer. It is the `Contact` in
   [`https://makrai.org/.well-known/security.txt`](https://makrai.org/.well-known/security.txt).
   Encrypt if the finding warrants it; say so in the subject if you would like a reply channel
   other than email.
2. **GitHub private vulnerability reporting** — the **Security** tab → **Report a
   vulnerability**, which opens a draft advisory visible only to you and the maintainers.
   *Not usable yet:* GitHub offers this on public repositories only, and this repository is
   private. Enabling it is a prerequisite for going public, at which point it becomes the
   preferred route because it keeps the report, the fix and the advisory in one place.

## Check what is already known first

Every risk this project has accepted, deferred, or recorded as a known defect is already written
down. The maintainers keep a register of every deferral, accepted risk and known bug, and a
current security assessment, both outside this repository. Ask for the relevant entry before
assuming something is unknown. A registered item is still
worth reporting if its severity looks wrong or the row underestimates it — say which row.

## What to expect, honestly

One maintainer works on this part-time, so there is no on-call rotation and promising 24-hour
triage would be a fiction. The commitment is **acknowledgement within 7 days** and **an initial
assessment within 21 days** — accepted, already registered, out of scope, or not reproducible, with
reasoning. There is **no fix deadline**: fixes are scheduled against the plan rather than the
clock, and an accepted finding not fixed at once gets a tracked register entry with a pick-up
condition, so it cannot be quietly dropped.
Reporters are credited unless they ask otherwise. If 21 days pass in silence, escalate with a public
issue saying a security report went unanswered — with no detail in it.

## Scope

**In scope**

- **The live service at `https://makrai.org` and its HTTP API.** Test it in good faith and report
  what you find to `security@makrai.org`. Follow
  [`https://makrai.org/.well-known/security.txt`](https://makrai.org/.well-known/security.txt) for
  the contact and the languages we read. Good faith means: no denial of service of any kind (no
  flooding, load testing or resource exhaustion); no access to another user's data, and no
  changing or keeping of it — stop at the first proof and report. If showing a flaw needs a second
  tenant, use a local instance (`README.md`), not the live service.
- **The code in this repository** that runs it: the Next.js application and its HTTP API under
  `app/api/`; tenant isolation between organizations; authentication, session handling and the
  role/permission layer; the deployment configuration in `docker/` (`Dockerfile`,
  `docker-compose.prod.yml`, `docker-compose.yml`, `nginx/default.conf`).

**Out of scope:**

- **The legacy static single-page app at `makrai.netlify.app`** — still live, but a different
  codebase not built from here. Reports belong with whoever maintains that deployment.
- **Third-party dependencies** — report upstream. One is in scope here only when this project's
  particular use of it is what makes it exploitable; then describe the call path.
- **Denial of service, and other users' data, on the live service** — testing that degrades it
  for others, or that reads, changes or keeps another user's data, is not authorised. Describe
  the flaw, and show it on a local instance instead.
- **Any other host.** Only `makrai.org` and its API are in scope. The Hetzner and Cloudflare
  accounts behind it, and every other hostname, are not: do not attack a host on the assumption it
  belongs to this project.

## Supported versions

The project is **pre-production**. A release is a git tag `vX.Y.Z` that equals the `version` in
`package.json` and sits on a commit of `main`; `.github/workflows/release.yml` builds its container
images from that tag, and the production host runs released images by digest (`docs/runbooks/deployment.md`
section 8). The first release is `0.2.0`: `0.1.0` was never published or deployed, and nothing
earlier is supported. Only the **latest release** and the current state of **`main`** are supported.
Nothing is backported, because there is nowhere to backport to.

## Security model — one thing reporters should know

Tenant isolation is enforced by **PostgreSQL row-level security**, not by application code. A tenant
query runs inside one interactive transaction that sets the transaction-scoped setting
`app.current_org_id` (`lib/data/tenant.ts:218`) over a restricted, `NOBYPASSRLS` database role;
policies compare that setting against each row's `orgId` and return nothing when it is unset.
Authorization is a separate, application-side concern that never appears in a policy. Reasoning,
controls and accepted limits: `docs/adr/0001-data-access-architecture.md`.

The consequence: **the application deliberately never re-filters by organization id.** A
`where: { orgId }` in application code was rejected on purpose, because a redundant filter hides the
very misconfiguration row-level security fails by. So "this query has no `orgId` filter" is expected
behaviour on its own. To be a finding, a report must show why row-level security does not cover that
case — the path never enters `withOrg`, it runs on the owner connection instead of the restricted
role, the table has no policy or lacks `FORCE ROW LEVEL SECURITY`, or the setting leaks across
requests. Those are the real defects here, and they are worth a great deal.
