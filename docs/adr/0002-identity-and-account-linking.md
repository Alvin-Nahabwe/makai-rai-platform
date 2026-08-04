# ADR-0002 — Identity, sessions, and account linking: the token asserts identity and nothing else

**Status:** Proposed · **Date:** 2026-08-03 · **Deciders:** engineering + product owner
**Related:** ADR-0001 (data-access architecture)
**Register:** D-043, D-044, D-045, D-053, D-066, D-069, D-075, D-080, D-088, D-089, D-097–D-101

## Context

Plan 1b wires the isolation spine into the application: it builds `requireOrgContext`, ports
every route and page off the owner connection, and rewrites registration and invitations. Each
of those touches identity, so the identity model must be decided first. D-066 deferred this ADR
out of Plan 1a on the explicit ground that *"deciding login policy before the login work that
gives it context is how speculative decisions get made"* — and set its pick-up trigger as
**before the first real account exists**. That trigger fires now.

A previous ADR-0002 was written on `rollback/phase1a-unadherent` and did not survive the
rollback. It was re-derived rather than ratified, per §7.4, and where this ADR reaches the same
conclusion that is a result and not an inheritance. Its decisions on the linking policy and on
deferring the identity table converged with the independent derivation and are carried forward
with attribution. **A defect is recorded here rather than quietly fixed:** `docs/adr/README.md`
on `main` has been indexing ADR-0002 as `Accepted` with a link to a file that does not exist,
while D-066 recorded that the decision was deliberately not made. Two project records
contradicted each other and the one a reader meets first was the wrong one (D-100).

### Verified current state, 2026-08-03

| Fact | Evidence |
|---|---|
| `next-auth@5.0.0-beta.31`, `@auth/core@0.41.2` | `node_modules/*/package.json` |
| `Credentials` is the **only** provider | `lib/auth.ts` |
| Session is `{ strategy: 'jwt' }` with **no `maxAge`** → 30-day default | `lib/auth.ts` |
| Token carries `id`, `role`, `mustChangePassword`, set once at login and never re-read | `lib/auth.ts` jwt/session callbacks |
| Deactivating a user or demoting an admin therefore has **no effect for up to 30 days** | follows from the above |
| `users.lastActiveOrgId` is unconstrained `TEXT`, no FK, read by nothing | `prisma/schema.prisma`; D-069 |
| `makrai_app` holds **no** privilege on `users` / `consent_records` | D-075, verified live |
| All identity reads run on the **owner** connection (SUPERUSER, BYPASSRLS) | `lib/data/identity.ts`, `lib/data/preauth.ts` |
| Invitation tokens are stored **plaintext**; no `acceptedAt` column | `prisma/schema.prisma` |
| `RESEND_API_KEY` is a 15-char placeholder; `GET /domains` → HTTP 400 `API key is invalid` | checked against the live API |

### The constraint that decides question one

The obvious framing of this ADR is *JWT sessions or database sessions?* That question is not
open. From the installed library:

```js
// node_modules/@auth/core/lib/utils/assert.js:114-119
if (hasCredentials) {
    const dbStrategy = options.session?.strategy === "database";
    const onlyCredentials = !options.providers.some(
        (p) => (typeof p === "function" ? p() : p).type !== "credentials");
    if (dbStrategy && onlyCredentials) {
        return new UnsupportedStrategy(
            "Signing in with credentials only supported if JWT strategy is enabled");
    }
}
```

`onlyCredentials` is true when *every* configured provider is credentials-type. This
application configures exactly one. So `strategy: "database"` is a **startup error**, not a
trade-off. Database sessions become available only once a non-credentials provider is added —
which means **SSO and database sessions are the same decision, not two independent axes.**

### The asset that reframes the rest

ADR-0001 established that RLS is the authoritative tenant filter and the application never
re-filters by `orgId`. The consequence must be stated without hedging:

> **Postgres does not validate `ctx.orgId`. It obeys it.** A request carrying an attacker's
> chosen `orgId` is served that tenant's rows correctly, silently, with HTTP 200 and no error
> anywhere in the stack.

Therefore `requireOrgContext` is not *a* control in this architecture — it **is** the
authorization decision, and `withOrg` is its transport. Plan 1a hardened the transport across
five successive rebuilds. Plan 1b builds the decision. The strongest isolation layer in the
system sits downstream of a function that does not yet exist, and that asymmetry is what this
ADR exists to correct.

---

## Decision

### 1. Credentials stay on `User`. No identity/account table in Plan 1b.

Adding one now commits the identity model to a **beta** library's adapter schema against a
speculative benefit. The irreversibility here is **in the accounts, not the schema**: an
identity table is an afternoon plus a mechanical `provider='credentials'` backfill, whereas a
population of real accounts whose linking semantics were never decided must be reconciled
retroactively — and every retroactive reconciliation is a potential account takeover.

This also has a cost specific to *this* codebase that a generic reading misses. Non-tenant
models are reachable only through `identityDb`, which runs on the SUPERUSER/BYPASSRLS owner
connection. **Every model added there enlarges the RLS-bypassing surface** that Plan 1a shrank
across five rebuilds (`Omit` → `Pick` → depth-1 guard → Proxy → construction, D-081/D-092).
Speculative identity tables are not free here; they are paid for in bypass surface.

Pick-up trigger: **D-053**, unchanged — before the first real non-dev account exists, or the
first concrete SSO request, whichever is first.

### 2. Sessions are JWT, and this is recorded as a constraint, not a preference.

Written down explicitly so a future reader does not "improve" it into a database session and
discover the startup error themselves. Revisit **only** together with adding a non-credentials
provider (D-044).

### 3. The token carries identity and nothing else.

Removed from the token: `role`, `mustChangePassword`. Both are read per request. The token
carries the user id and a `sessionEpoch` claim.

The reasoning is not stylistic. A token is self-contained and unverified against the database
per request, so **any authorization bit inside it keeps granting access after the grant is
revoked.** Today's token carries the platform `role`; a demoted admin stays an admin for up to
30 days. Reading role per request costs nothing new, because spec §4.3 already requires a
database round-trip per request to resolve membership — the fresh role rides along on a query
that has to happen anyway.

### 4. Revocation is a `sessionEpoch` counter, checked at one choke point.

`users.sessionEpoch INTEGER NOT NULL DEFAULT 0`. The value at sign-in is embedded in the token.
Every request compares the claim against the stored value; a mismatch ends the session.
Incremented on: logout-everywhere, password change, deactivation (`isActive = false`), and any
administrative account action that should invalidate outstanding sessions.

Session lifetime is pinned: **`maxAge` 12 h** (NextAuth refreshes on activity, so this behaves
as an idle timeout) plus an **absolute 7-day cap** enforced at the choke point against a
**`sessionIssuedAt` claim written once at sign-in**. The idle timeout matters more than usual in
the target context — shared lab machines and intermittent connectivity make a long-lived session
on a walked-away-from browser the realistic exposure, not token theft in transit.

> **Correction, 2026-08-04 — the mechanism, not the decision.** This paragraph originally specified
> the cap be enforced *"by comparing the token's `iat`"*. **That cannot work, and it fails
> silently.** `@auth/core`'s `encode()` calls jose's `.setIssuedAt()` with no argument on every
> re-encode, and a re-encode happens on every `auth()` call under the `jwt` strategy. Verified
> directly against `@auth/core/jwt` during Plan 1b Task 4: re-encoding a decoded token 2.1 seconds
> later moved `iat` from `1785813725` to `1785813727` — by exactly the elapsed time — while a custom
> claim survived unchanged. An `iat`-based cap would therefore **never fire for any actively used
> session**, which is precisely the session this cap exists to bound: the paragraph above justifies
> it by a walked-away-from shared lab machine that is *periodically revisited*. The cap would have
> been a no-op exactly where it mattered, and nothing would have reported it.
>
> Corrected in place rather than superseded because **the decision is unchanged** — 12 h idle, 7-day
> absolute — and only the stated implementation mechanism was factually wrong. `README.md` forbids
> editing an ADR to change a *decision*; recording a corrected mechanism under an unchanged decision
> is the opposite of that, and leaving a known-unworkable mechanism in the record would mislead the
> next reader far more than this edit does.
>
> Worth noting how it was found, because it says something about which instruments reach which
> defects: an implementer ran a `node` probe against the library instead of reasoning about it — §5's
> *"look at the thing itself"*. Neither the STRIDE pass, nor `what-if-oracle`, nor the adversarial
> review, nor the spec self-review reached it, because all four asked whether the **design** was
> right, and the design was right. The error was a factual claim about how a dependency behaves, and
> design scrutiny does not touch that layer. Compare `@auth/core/lib/utils/assert.js:117`, which
> eliminated database sessions from this same ADR — also found by reading the library, not by
> reasoning about it.

**Where the check lives is the load-bearing half of this decision, and prose will not hold
it.** D-092 records five guards on Plan 1a that each closed the bypass shapes their author
enumerated, passed a test pinning exactly those shapes, and left the class open — three of them
while fixing the previous one. Independent reviewers found all five; self-review found none. So
two *construction* mechanisms, both reusing machinery this project has already built and
proven:

- **The raw session is unreachable from application code.** `app/**` may not import `auth` from
  `lib/auth`; it imports `requireIdentity()`. Enforced by the existing
  `no-restricted-imports` + `no-restricted-syntax` rule already proven against `lib/db` —
  including the dynamic-`import()` and `require()` selectors, which a specifier-only ban misses.
- **`OrgContext` is branded.** It carries a non-exported unique symbol, so `withOrg` structurally
  cannot be called with a hand-built `{ orgId, role }`; the only way to obtain the type is to
  call `requireOrgContext`. This is **D-089's pick-up** — it already records the unbranded
  context as a deferred type-design item, and its trigger fires here.

Branding is chosen over a runtime assertion for the reason D-092 identifies: an interception
guard is only as good as the reachability graph its author imagined, while a value that cannot
be constructed needs no imagination. Compare `identityDb`, where four interception attempts
failed and construction held.

### 5. `requireOrgContext(slug, action)` proves six things, every call, from the database.

1. A valid session exists and names a `userId`.
2. That user exists, is `isActive`, and the token's `sessionEpoch` matches the stored value.
3. An `Organization` with this `slug` exists and `deletedAt IS NULL`.
4. A `Membership` joins **this** user to **that** org with `status = 'active'`.
5. `can(membership.role, action)` — role from the membership row. Never the token. Never the request.
6. The returned `orgId` is the `organization.id` read in step 3, never a value derived from
   client input.

None of these may be satisfied from cache that outlives the request. Memoisation **within** a
request (`cache()`) is required — see Consequences for why.

### 6. `lastActiveOrgId` is a UI convenience and never an authorization input.

It may select *which* slug to redirect to. The redirect target then goes through
`requireOrgContext` like any other request. It can name an org the user was removed from,
suspended in, or never joined, and nothing in the schema prevents that (D-069). The danger is
that this path reads as UX and is therefore written by whoever builds the redirect — so it gets
an explicit test that sets the column to a non-member org and proves refusal.

### 7. Membership is never granted by authentication.

*(Carried from the superseded ADR; independently confirmed.)* A verified email domain may act
as a **hint** — "your institution has an organization here, request access" — never as an
automatic grant. Joining requires an invitation or creating an organization. This keeps
authentication and authorization independent, so later identity changes cannot silently become
tenant-membership changes.

### 8. Invitations: hashed, email-bound, atomic, role-from-row.

- Token is ≥128 bits from `crypto.randomBytes`, stored **only** as its sha256 digest. The raw
  value exists in the delivered link and nowhere else. Lookup is by digest, so no timing-safe
  comparison is needed. **This corrects a shipped regression** — the spec required a hash and
  the implementation stored plaintext (D-097).
- `role` comes from the invitation row. The request body has no say.
- The inviter's role caps the invitable role at **creation**; `member:grant_owner` is owner-only.
- Acceptance is **one transaction**: verify → create `Membership` → set `accepted` + `acceptedAt`.
  Single-use is the status transition inside that transaction, not a prior read.
- **Email-bound.** An invitation addressed to a person must not become a membership for whoever
  holds the link. Existing account: the authenticated user's email must match. New account: the
  email is fixed from the invitation and not editable on the form. Without this, forwarding an
  email — or pasting a copy-link into the wrong channel — grants organizational access (D-098).
- Never create a second `User` for an email that already has one; never authenticate anyone as a
  side effect of acceptance.

### 9. Account-linking policy, decided now, before any provider exists.

Unchanged from D-066 and the superseded ADR; re-derived and confirmed. These bind whenever a
second authentication method is added, and are recorded now because policy decided under
procurement pressure is exactly how the email-linking shortcut gets taken:

- A provider identity is keyed by **`(provider, providerSubjectId)` — never by email.** Email is
  mutable and re-assignable; institutional email especially, since it is reclaimed when staff
  leave. A mutable attribute must never be a primary identity key.
- **Never auto-link** a new authentication identity to an existing account on an email claim
  alone. This is the pre-account-takeover attack.
- **Linking requires proof of control** of the existing account: signed in and re-authenticated,
  or an email challenge **we** issue — never one an IdP asserts on the user's behalf.
- Trust `email_verified` only from an explicit provider allowlist, and never as a sufficient
  condition for linking on its own.
- An IdP subject we have not seen **creates a new user**, never a silent merge.
- Unlinking must never leave an account with zero authentication methods.

### 10. Existence disclosure: 404, 403, and redirect are three different answers.

| Condition | Response |
|---|---|
| Slug unknown **or** caller is not a member | **404** |
| Member, but role lacks the action | **403** |
| No session | redirect to `/login` |

A 403 on the first row would confirm the organization exists, making slugs enumerable. For an
assurance tool, *which institutions are running AI risk assessments* is itself sensitive. A 404
on the second row is merely a confusing bug — the caller already knows the org exists.

---

## Consequences

### Positive

- No commitment to a beta adapter schema, and no table that earns nothing until someone asks.
- The revocation gap (D-045) closes with one column and one check on a query that already had to
  happen. Cost is genuinely marginal rather than nominally marginal.
- Two of the ten proof obligations are **reuse, not invention**: the import ban is the `lib/db`
  rule aimed at a second target, and branding is D-089's deferred item finally triggered. Both
  mechanisms were built and proven in Plan 1a.
- Decision 7 keeps identity changes tractable: tenant membership never depends on how anyone
  authenticated, so adding SSO later cannot reshuffle who can read what.

### Negative / accepted

- **A migration is deferred, not avoided.** When SSO is required, the identity table plus a
  `provider='credentials'` backfill must happen. Cheap at low account counts, degrading with
  adoption — hence the event trigger (D-053) rather than a phase target.
- **Reading identity per request loads the owner connection.** Every request now performs an
  identity read on the connection that bypasses RLS, because `makrai_app` has no privilege on
  `users` (D-075). Under load, that pool (`max: 5`) is the bottleneck, and the tempting fix is
  `GRANT SELECT ON users TO makrai_app` — which D-075's own pick-up trigger predicts verbatim:
  *"the temptation will be to re-grant the whole table."* **The sanctioned responses are
  per-request memoisation and pool sizing; if a grant ever becomes genuinely necessary it is
  column-scoped and excludes `passwordHash`, never a bare table grant** (D-099).
- **Two 404 branches are timing-distinguishable** — "slug unknown" performs fewer queries than
  "exists but not a member". Mitigated by always performing both lookups; residual accepted.
- **Org creation leaks existence through slug collision.** A form reporting *"that slug is
  taken"* is an existence oracle. Server-side slug derivation avoids it (D-101).
- `maxAge` 12 h / 7-day absolute are judgement calls with no usage data behind them. Recorded as
  tunable, revisited after the first pilot.

---

## Alternatives rejected

- **Database sessions.** Not rejected on merit — **unavailable.** `@auth/core` raises
  `UnsupportedStrategy` when the strategy is `database` and every provider is credentials-type
  (`assert.js:117`). Re-open only alongside D-044.
- **Identity/account table in Plan 1b.** Speculative against a beta adapter schema; the
  migration stays cheap while account count is low; and it does not by itself prevent the
  failure it is meant to prevent, which is a *linking-policy* failure, not a schema failure.
  It also enlarges the BYPASSRLS surface (decision 1).
- **Defer the linking policy too.** Rejected: it leaves the takeover branch unmitigated, and the
  policy is cheapest to decide precisely when no provider exists to bias it.
- **Domain-based auto-provisioning into organizations.** Rejected: it makes email domain a
  tenant-assignment mechanism, which would require domain-ownership verification as a security
  boundary and exposes lookalike and subdomain spoofing. It also bypasses invitations and
  therefore role assignment.
- **Keep `role` in the token and accept staleness.** Rejected: it is the mechanism by which
  revocation silently fails, and the DB round-trip that would justify it is already mandatory.
- **A runtime assertion instead of a branded `OrgContext`.** Rejected on this project's own
  evidence: interception guards failed four consecutive times on `identityDb` and construction
  held (D-092).

---

## References

- ADR-0001 — data-access architecture (RLS is the authoritative tenant filter)
- `what-if-oracle`, 2026-08-03 — six branches; Likely 42%, Worst 18%, Contrarian 13%. Independent
  re-run; the superseded ADR's 2026-08-02 run gave 38/18/17, and the convergence is treated as
  corroboration rather than as a reason to skip the re-derivation
- `engineering-skills:senior-security`, 2026-08-03 — STRIDE over the cookie → identity →
  `OrgContext` → RLS boundary; nine DREAD-scored threats; ten proof obligations
- Superseded `docs/adr/0002-identity-and-account-linking.md` on `rollback/phase1a-unadherent`,
  evaluated on merit per AGENTS.md §7.4. Decisions 7 and 9 are carried from it
- `node_modules/@auth/core/lib/utils/assert.js:114-119` — the credentials/JWT constraint
- Register: D-043 (2FA), D-044 (SSO provider), D-045 (JWT revocation), D-053 (identity table
  trigger), D-066 (this ADR's deferral), D-069 (`lastActiveOrgId`), D-075 (`users` privilege),
  D-080 (Prisma `undefined` elision), D-088 (`$executeRaw` in a tenant transaction), D-089
  (branded context), D-097–D-101 (opened by this ADR)
