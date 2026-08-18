# Security policy

This project scores other teams on whether they can show their governance works. It would be a poor
advertisement for that if someone who found a flaw here had nowhere to send it.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security problem.** A useful report
gives the affected path or file, what an attacker gains, and the shortest steps that show it; proof
against a local instance is welcome, and `README.md` covers bringing one up. Two routes, in order of
preference:

1. **GitHub private vulnerability reporting** — the **Security** tab → **Report a vulnerability**,
   opening a draft advisory visible only to reporter and maintainers. *Not yet usable:* GitHub
   offers this on public repositories, and `Alvin-Nahabwe/makai-rai-platform` is private, so the tab
   is unreachable from outside. Enabling it is a prerequisite for going public.
2. **Email** — `<SECURITY-CONTACT-EMAIL-NOT-YET-SET>`. **This placeholder is not an address and mail
   to it will not arrive.** The maintainer must replace it with a real, monitored address before the
   repository is published or the platform serves anyone. Until both routes work there is no private
   channel — a gap recorded here rather than hidden.

## Check what is already known first

Every risk this project has accepted, deferred, or recorded as a known defect is already written
down. The maintainers keep a register of every deferral, accepted risk and known bug, and a
current security assessment, both outside this repository. Ask for the relevant entry before
assuming something is unknown. A registered item is still
worth reporting if its severity looks wrong or the row underestimates it — say which row.

## What to expect, honestly

One maintainer works on this part-time and nothing is deployed, so there is no on-call rotation and
promising 24-hour triage would be a fiction. The commitment is **acknowledgement within 7 days** and
**an initial assessment within 21 days** — accepted, already registered, out of scope, or not
reproducible, with reasoning. There is **no fix deadline**: with no users and no deployment, fixes
are scheduled against the plan rather than the clock, and an accepted finding not fixed at once gets
a tracked register entry with a pick-up condition, so it cannot be quietly dropped.
Reporters are credited unless they ask otherwise. If 21 days pass in silence, escalate with a public
issue saying a security report went unanswered — with no detail in it.

## Scope

**In scope** — code in this repository: the Next.js application and its HTTP API under `app/api/`;
tenant isolation between organizations; authentication, session handling and the role/permission
layer; the deployment configuration in `docker/` (`Dockerfile`, `docker-compose.prod.yml`,
`docker-compose.yml`, `nginx/default.conf`).

**Out of scope:**

- **The legacy static single-page app at `makrai.netlify.app`** — still live, but a different
  codebase not built from here. Reports belong with whoever maintains that deployment.
- **Third-party dependencies** — report upstream. One is in scope here only when this project's
  particular use of it is what makes it exploitable; then describe the call path.
- **Hosted infrastructure** — none exists to test. A Hetzner VPS and a Cloudflare domain are
  purchased but unconfigured; the platform has never served a request outside a developer machine
  or CI. Do not attack any host on the assumption it belongs to this project.

## Supported versions

The project is **pre-production**. There is **no released version**: no git tag exists and the
`0.1.0` in `package.json` has never been published or deployed. Only the current state of **`main`**
is supported. Nothing is backported, because there is nowhere to backport to.

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
