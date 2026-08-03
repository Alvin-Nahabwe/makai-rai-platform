# Plan 1b — Wiring the isolation spine into the application: Design Spec

**Status:** For review · **Date:** 2026-08-03 · **Branch:** `phase1b-wire-the-spine` (off `main` @ `ab2c153`)
**Depends on:** ADR-0001 (data access), **ADR-0002** (identity — written for this plan, commit `4fe15c3`),
`docs/superpowers/specs/2026-08-02-phase1-foundation-design.md`, `DEFERRED_REGISTER.md`
**Process:** `superpowers:brainstorming`; `what-if-oracle` at the identity fork (mandatory, AGENTS.md §2);
`engineering-skills:senior-security` STRIDE over the identity→context→RLS boundary;
`database-design:postgresql` on the three schema changes; `backend-development:api-design-principles`
on the route surface.

---

## 0. Scope

**Single responsibility:** connect the isolation spine to the application, and make the
organization lifecycle real.

**Explicitly not its job:** evidence attachment + credibility tiers (D-001); framework-as-versioned-data
(D-003); the scoring-methodology question (D-020, D-031); hosting (D-018); SSO (D-044); the identity
table (D-053); 2FA (D-043).

**Why this cut.** Plan 1a proved the isolation machinery and shipped it *disconnected*. A grep for
consumers of `lib/data/*` across `app/`, `lib/` and `components/` returns **four test files and zero
application files**. Until that changes, "RLS ships" and "tenant data is protected" are different
statements. Evidence attachment and framework-versioning are each their own design surface and are
safer to design once real tenant data actually flows through the spine.

---

## 1. The starting state, verified

Measured 2026-08-03, not inherited:

| Fact | How established |
|---|---|
| Zero application files import `lib/data/*` | grep over `app/`, `lib/`, `components/` |
| Nothing creates an `Organization` or a `Membership` | grep for `organization.create`/`membership.create`/`upsert` — one hit, and it is a *comment* in `lib/data/identity.ts:123` |
| Dev DB: `users=1 orgs=1 memberships=0 invitations=0 projects=0 assessments=0` | live query |
| The one org is `Legacy` (`00000000-…-0001`), inserted by `20260803034110_port_tenant_tables_to_org_id` so `SET NOT NULL` could apply | migration source |
| `npm run typecheck` fails with exactly 3 errors | D-070; they are `project.create`/`assessment.create` calls with no `orgId` |
| `RESEND_API_KEY` is a 15-char placeholder | `GET https://api.resend.com/domains` → HTTP 400 `API key is invalid` |
| Nothing in the UI links to `/api/research/export` | grep over `app/`, `components/` |
| `Project.createdById` and `Assessment.userId` are `NOT NULL` with Prisma's default `RESTRICT` | `prisma/schema.prisma` |

**The consequence, stated plainly: the application cannot create a project today.** Not untested —
structurally impossible. `projects.orgId` is `NOT NULL`, no organization has a member, and nothing
constructs the `OrgContext` that `withOrg` requires.

---

## 2. Corrections to the Phase 1 foundation spec

That spec remains the parent design. Plan 1a falsified parts of it; those are corrected here rather
than left for an implementer to trip over.

| §  | It says | Correction |
|---|---|---|
| 3.2 | `orgDb(activeOrgId, membership)` injects `orgId` **and** enforces role | Falsified by the Task 0 spike (`$extends` NO-GO). Reality: `withOrg(ctx, cb)` sets the GUC; `assertCan(ctx, action)` is separate. AGENTS.md §3 names the conflated responsibility as the original design defect |
| 3.3 | `org_id = NULLIF(…)::uuid` | Wrong twice: the column is quoted camelCase `"orgId"`, and `::uuid` against a `TEXT` column raises `operator does not exist: text = uuid` — the exact failure of the first spike (D-064) |
| 3.3 | 5-day RLS spike with an abort criterion | Discharged; D-005 closed |
| 2.1 | Invitation stores `tokenHash` (sha256); `acceptedAt` present | **Shipped as plaintext `token`, no `acceptedAt`.** Corrected here (D-097) |
| 2.1 | `lastActiveOrgId` FK with `onDelete: SetNull` | Shipped as plain `String?`, no FK, deliberately, with recorded reasoning (D-069) |
| 3.4 | Matrix includes `assessment:complete`, `assessment:respond`, `remediation:update`, `org:read` | `lib/authz/policy.ts` has none of the four. **Blocks the port** — see §3.1 |
| 5.1 | Backfill one org per existing user | Superseded: the shipped backfill created a single `Legacy` org. Both DBs hold zero tenant rows, so the difference is moot — and `Legacy` is now removed (§4.3) |
| 4.3 | Next 16 `proxy` replaces `middleware` | **Holds** — confirmed in `node_modules/next/dist/docs/…/proxy.md`; `proxy.ts` exists; D-027 closed |
| 6.2 | T1–T4 structural tests | **All four shipped** |

---

## 3. Design

### 3.1 Reconcile the RBAC matrix — first, because the port cannot be written without it

`lib/authz/policy.ts` lacks `assessment:complete`, `assessment:respond`, `remediation:update` and
`org:read`, yet `POST /assessments/[id]/complete` and `/remediation` are both being ported. Without
these actions an implementer reaches those files with nothing to write, and the natural improvisation
is to reuse `assessment:update` — silently granting completion to everyone who can edit.

The matrix test is generated over every (role × action) cell, so adding an action **fails the build**
until all five roles are ruled on. That is what converts "did anyone decide whether a viewer may
complete an assessment?" from a question nobody asks into a red test.

### 3.2 The bootstrap — the sanctioned before-context **write**

`withOrg` cannot create an organization. The `organizations` policy is
`WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), ''))`, and a new organization is
by definition not yet the current one, so no `ctx` exists under which the insert succeeds (D-078,
verified live on `makrai_test`). Something must mint the first capability from outside the closed
system.

**`bootstrapOrgWithOwner(...)`** — one function, in `lib/data/preauth.ts`, one transaction on the owner
connection, creating `User` + `Organization` + `Membership(owner)` + consent records **together**.
All four in one transaction because `identityDb` deliberately exposes no `$transaction`, so splitting
the work across clients would permit the partial state "user and organization exist, consents do not."
`__tests__/integration/preauth-surface.test.ts` pins the module's exports and will fail until the new
export is deliberately added — the bypass surface stays enumerable rather than growing quietly.

**Slug is derived server-side, never chosen.** The user supplies a display name; the server lowercases
it, replaces non-alphanumerics with hyphens, collapses repeats and trims to 48 characters. On collision
it appends `-` plus **4 random hex characters** and retries on unique violation, up to 5 attempts. A
random discriminator rather than a sequential `-2` because sequential leaks *how many* similar
organizations exist while random leaks only that one did. The user never sees "that slug is taken,"
which is what closes the existence oracle (D-101). The `UNIQUE` constraint stays — it is the integrity
guarantee, not the user-facing error.

### 3.3 `requireIdentity()` — the single choke point

Returns `{ userId, isActive, platformRole, mustChangePassword }`, read fresh from `identityDb` on
every call, and rejects when `token.sessionEpoch !== user.sessionEpoch` or the token's `iat` exceeds
the absolute cap.

**Application code may not import `auth` from `lib/auth`.** Enforced by extending the existing
`no-restricted-imports` + `no-restricted-syntax` rule that already bans `lib/db` — including its
dynamic-`import()` and `require()` selectors, which a specifier-only ban misses (verified during
Plan 1a). This is reuse of a proven mechanism, not a new one.

### 3.4 `requireOrgContext(slug, action)` — the authorization decision

RLS does not validate `ctx.orgId`; it obeys it. This function *is* the authorization decision and
`withOrg` is its transport. It proves six things per call, all from the database, none from the token:

1. a valid session names a `userId`;
2. that user exists, is `isActive`, and `sessionEpoch` matches;
3. an `Organization` with this `slug` exists and `deletedAt IS NULL`;
4. a `Membership` joins **this** user to **that** org with `status = 'active'`;
5. `can(membership.role, action)` — role from the membership row, never the token, never the request;
6. the returned `orgId` is the `organization.id` read in step 3.

Both lookups run **unconditionally**, even when the first returns nothing, so the two 404 branches do
equal work and stop being timing-distinguishable (D-101).

It returns a **branded** `OrgContext` carrying a non-exported unique symbol, so `withOrg` structurally
cannot be called with a hand-built `{ orgId, role }`. This is D-089's pick-up. Branding is chosen over
a runtime assertion on this project's own evidence: interception guards failed four consecutive times
on `identityDb` and construction held (D-092).

`lastActiveOrgId` may select **which slug to redirect to** and nothing else. The redirect target then
passes through `requireOrgContext` like any other request (D-069).

---

## 4. Schema changes

### 4.1 `users.sessionEpoch Int @default(0)`

A counter, not a timestamp. `sessionsValidFrom TIMESTAMPTZ` with `iat >= sessionsValidFrom` loses to a
specific failure: **JWT `iat` has one-second resolution**, so a token issued in the same second as the
invalidation survives — and that second is the moment of maximum risk, since forced invalidation
usually follows suspected compromise. Clock skew between app instances and the database widens the same
hole. Integer equality has no resolution to lose.

`NOT NULL DEFAULT 0` is a non-volatile default, so no table rewrite. **No index** — it is read only
while fetching the user by primary key and is never a filter.

Deliberate deviation from `database-design:postgresql`, which prefers `BIGINT`: the value is a **JWT
claim**, and Prisma's `BigInt` serialises awkwardly to JSON for no benefit at 2.1bn increments per user.

### 4.2 `invitations`: `tokenHash` + `acceptedAt`

```prisma
tokenHash   String    @unique   // sha256 hex
acceptedAt  DateTime?
```

```sql
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_tokenHash_is_sha256_hex"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
```

The `CHECK` is the point, more than the hashing. A plaintext token **cannot satisfy it**, so D-097
becomes structurally unrepresentable rather than something reviewers must remember to look for. Zero
rows exist, so no backfill. TEXT hex rather than `BYTEA` is a deliberate deviation: 32 bytes saved is
worth less than a constraint that cannot be silently regressed.

**Single-use acceptance is the status transition itself**, not a prior read:

```
BEGIN
  UPDATE invitations SET status='accepted', "acceptedAt"=now()
   WHERE "tokenHash" = $1 AND status = 'pending'     ← row lock; the loser re-evaluates and matches 0
  if count = 0 → reject
  INSERT INTO memberships (...)                       ← only the winner reaches here
COMMIT
```

Under `READ COMMITTED` the second transaction blocks on the row lock, re-evaluates its `WHERE` after
the first commits, matches zero rows and rejects. No advisory locks, no `SERIALIZABLE`. The existing
`@@unique([orgId, userId])` on `memberships` is the structural backstop and also handles "an existing
member accepts again."

### 4.3 Remove the `Legacy` organization — guarded

```sql
DELETE FROM "organizations" o
 WHERE o.id = '00000000-0000-0000-0000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM "projects"    p WHERE p."orgId" = o.id)
   AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."orgId" = o.id);
```

Migrations run as `makrai`, a superuser, and superusers bypass RLS unconditionally — `FORCE ROW LEVEL
SECURITY` binds a non-superuser *owner*, not a superuser. (D-079 already records that this migration
set is superuser-only to apply, since `CREATE EVENT TRIGGER` requires it.) A future migration run under
a non-superuser owner would need `SET LOCAL app.current_org_id` first; the migration says so in a
comment, because it is not obvious.

The `NOT EXISTS` guards make the statement a **no-op wherever the row is load-bearing**. My knowledge
that it is empty covers two databases I can see; this migration will run against environments I cannot.

---

## 5. The port

### 5.1 Tenant API routes nest under `/api/v1/orgs/[slug]/…`

Flat routing would require reading a tenant row to discover its own organization **before any context
exists** — possible only on the RLS-bypassing owner connection, on every request. That is exactly the
pre-context read this architecture eliminates.

The strongest alternative considered: iterate the caller's memberships and retry under each context
until a row appears. Correct, and rejected — N transactions per request, and it makes the active org
implicit again, breaking the tab independence URL-scoping buys.

**What nesting yields.** A request to `/api/v1/orgs/org-a/assessments/{id-owned-by-org-B}` succeeds at
`requireOrgContext` (the caller really is a member of A), runs under A's GUC, and RLS filters B's row
out — so the handler sees zero rows and returns 404. **No application code checked anything.** There is
no `if (assessment.orgId !== ctx.orgId)`, which is the exact line whose omission produced the July 2026
IDOR. The check you never wrote cannot be the check you forgot.

Versioning is introduced now because the rename cost is already being paid by the move, and VISION §6
Phase 4 plans an external API. `/api/auth/*` stays unversioned — it is NextAuth's own surface.

### 5.2 Disposition

| Route / page | Data | Disposition |
|---|---|---|
| `projects`, `projects/[id]` | tenant | nested; `withOrg` |
| `assessments`, `[id]`, `[id]/complete`, `[id]/remediation` | tenant | nested; `withOrg` + `assertCan` |
| `reports/[id]/pdf` | tenant | nested; **fetch inside `withOrg`, render outside** (§5.3) |
| `dashboard`, `projects`, `projects/[id]`, `[id]/compare` (pages) | tenant | move to `/orgs/[slug]/…`; **query changes from `createdById: userId` to org-scoped** |
| `users/me/password`, `users/me/export` | identity | stay flat; `identityDb` |
| `auth/register` | identity + bootstrap | `bootstrapOrgWithOwner` |
| `admin/users` (page), `admin/users/[id]/role` | identity | stay; `identityDb`; platform role, not org role |
| `admin/assessments` (page) | cross-tenant listing | **removed** (D-006) |
| `admin/settings` (page) | mixed | counts stay; the `assessment.findMany` listing **removed**, same reasoning |
| `research/export` | cross-tenant | **route deleted** (D-007). Nothing links to it |
| `users/me` DELETE | tenant + identity | **deactivate + scrub** (§5.4) |

`lib/authz.ts` is **deleted**, not extended: its ownership premise (`assessment.userId !== user.id`) is
wrong under tenancy, where a colleague in the same organization legitimately reads a project they did
not create. This closes D-072's two-competing-authorities problem.

### 5.3 The PDF route holds a transaction open

The naive port renders the PDF **inside** `withOrg`, holding a pooled connection for a CPU-bound render
against `max: 10`, with Prisma's transaction `timeout`/`maxWait` defaults still unpinned (D-065).
Fetch inside the transaction, close it, then render.

### 5.4 Account deletion becomes deactivation

Ruling: a departing member must not be able to erase the organization's governance records. The
database already agrees — `Project.createdById` and `Assessment.userId` are `NOT NULL` with `RESTRICT`,
so Postgres refuses to delete an author, and `identityDb` exposes no `delete`/`deleteMany` (D-095).

`DELETE /api/users/me` therefore: refuses if the caller is the **last owner** of any organization
(transfer first); otherwise removes their memberships, scrubs identity, sets `isActive = false`, bumps
`sessionEpoch`, and deletes personal consent records. Projects and assessments remain with the
organization, attributed to a deactivated account.

**Scrubbing is specified, not left to judgement.** `email` carries a `UNIQUE` constraint and cannot be
nulled, so it becomes `deleted-<userId>@invalid` — the `.invalid` TLD is reserved by RFC 2606 and can
never route, and including the id keeps it unique without a lookup. `name` becomes `Deleted user`.
`passwordHash` is overwritten with a random value rather than left in place, so the row cannot
authenticate even if `isActive` is later flipped by mistake. The `userId` is retained precisely because
`RESTRICT` requires it: it is the attribution anchor for records the organization keeps.

### 5.5 Error semantics

| Condition | API | Page |
|---|---|---|
| No session | **401** JSON | redirect `/login` |
| Slug unknown **or** not a member | **404** | **404** |
| Member, insufficient role | **403** | **403** |

An API returning a 302 to an HTML login page breaks `fetch` clients, which is why the first row splits.
The existing `{ error }` envelope is kept rather than churned.

---

## 6. Invitations and email

`pending → accepted | expired | revoked`. Token from `crypto.randomBytes` (≥128 bits), stored only as
its sha256 digest, single-use via §4.2's conditional update, expiring. The inviter's role caps the
invitable role **at creation**; `member:grant_owner` is owner-only.

**Email-bound.** For an email that already has an account, the accepting session's email must match;
for a new account, the email is fixed from the invitation and not editable on the form. Without this,
forwarding an email — or pasting a copy-link into the wrong channel — grants organizational access at
the role the invitation names (D-098).

**Delivery is proven live** via Resend's shared testing sender to the account holder's own address, so
no verified domain or DNS is required. **Prerequisite the repo cannot supply: a valid
`RESEND_API_KEY`.** The current value is a 15-character placeholder that the API rejects. This is why
email is sequenced last — everything else proceeds without it. That the testing sender works without a
verified domain is to be confirmed against Resend's documentation at implementation time, not taken on
assertion.

---

## 7. Proof obligations

From the STRIDE pass over the identity→context→RLS boundary. Each is a test, not a review note.

| # | Obligation | Falsifies |
|---|---|---|
| O-1 | A member of org A requesting `/orgs/B/…` gets **404** — every ported route and page, as a matrix | context from an unproven slug |
| O-2 | `lastActiveOrgId` set directly to a non-member org → `/` does **not** redirect there; it renders the org picker, and a direct request to that slug 404s | D-069 |
| O-3 | Revoke a membership mid-session → the **next** request is denied, no re-login | stale role |
| O-4 | Deactivate a user / bump `sessionEpoch` mid-session → next request denied | stale session |
| O-5 | Accepting an invitation with `role:'owner'` injected into the body yields the **invitation's** role | self-granted privilege |
| O-6 | Replaying an accepted token creates no second membership | non-atomic acceptance |
| O-7 | No stored value functions as a token — assert every row matches `^[0-9a-f]{64}$` | D-097 |
| O-8 | `withOrg` rejects a hand-constructed context — **at compile time** | forged context |
| O-9 | Nothing under `app/` imports `auth` from `lib/auth` — ESLint | the choke point bypassed |
| O-10 | `can(role, action)` regenerated over every cell, so a new action cannot skip a role | undecided permissions |

Every guard is proven **non-vacuous** by reverting it and watching the test go red — the Plan 1a
discipline, retained because a test that passes for the wrong reason is the failure these tests exist
to catch.

---

## 8. Definition of done

| Gate | Evidence |
|---|---|
| `npm run verify` green | `tsc` **0 errors** (D-070 closes), lint 0, all tests pass |
| Isolation matrix | every ported route × {other-org member, non-member, unauthenticated} → 404 |
| O-1…O-10 | all passing, each proven non-vacuous |
| **Live, two browsers** | User A in Org A, User B in Org B; A cannot reach B's project by direct URL; an invitation moves B into A's org; a full assessment runs start to finish |
| Email | one real invitation delivered and opened |
| Register | no `Open` row targeted at Phase 1b that is not explicitly re-targeted with justification |

Followed by a plain statement of what was and was not verified live.

---

## 9. Task sequence

Each step is blocked by the one above it; this is not a preference.

1. **RBAC matrix reconciliation** — four missing actions (§3.1)
2. **Schema + migration** — `sessionEpoch`, `tokenHash`/`acceptedAt` + `CHECK`, guarded `Legacy` delete (§4)
3. **`bootstrapOrgWithOwner`** + registration rewrite, org name on the form (§3.2)
4. **`requireIdentity`** + `sessionEpoch` checks + ESLint ban on raw `auth` (§3.3)
5. **`requireOrgContext`** + branded `OrgContext` (§3.4)
6. **URL restructure** to `/orgs/[slug]/…` + `proxy.ts` + org switcher (§5.1)
7. **Resolve all 22 allowlisted files** — port most, delete two (`research/export`, `lib/authz.ts`),
   remove one page and reduce another; the ESLint allowlist shrinks to zero and the override block is
   deleted (§5.2, D-074)
8. **Invitations** — create, accept, revoke (§6)
9. **Email live** via Resend (§6) — the only step gated on something outside this repo
10. **Live end-to-end verification** (§8)

The route port is step 7, not step 1. The SDD ledger's resume note called it "the first task"; that was
written before checking, and it is wrong — steps 3–5 are hard prerequisites.

---

## 10. Deferrals recorded by this design

Opened in commit `4fe15c3` alongside ADR-0002: **D-097** (plaintext invitation tokens), **D-098**
(invitation email binding), **D-099** (per-request identity reads pressure the owner connection and the
obvious fix re-opens D-075), **D-100** (the ADR index linked a nonexistent ADR-0002; no mechanism checks
document cross-references), **D-101** (slug-collision existence oracle; timing-distinguishable 404
branches).

Rows this plan is expected to close: D-006, D-007, D-022, D-030, D-045, D-048, D-069, D-070, D-072,
D-074, D-078, D-080, D-089, D-097, D-098, D-100, D-101. Rows whose triggers fire during it: D-029
(slug immutability becomes load-bearing for authorization, not merely UX), D-075 (identity reads stay on
the owner connection), D-081 (a relation added to `User` must be classified), D-088, D-095, D-096.

---

## 11. What this spec does not answer

- Whether the scoring methodology is defensible (D-020, D-031) — the largest open product risk, and
  deliberately outside this plan.
- Whether the framework content is current against ISO 42001 / AU / UNESCO (D-032, D-033).
- Hosting, and therefore the real cost of the dedicated-instance escape hatch (D-018, D-015).
- Evidence attachment (D-001) and framework-as-versioned-data (D-003), which together are Plan 1c and
  are what Phase 1's literal exit wording ("a full assessment **with evidence**") still requires.
- Whether Resend's shared testing sender behaves as described — to be confirmed at implementation time.
