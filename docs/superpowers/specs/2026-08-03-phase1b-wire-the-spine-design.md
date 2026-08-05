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

**Two further actions, found by running `what-if-oracle` on the decomposition:**

- **`member:leave`** — granted to **every** role. Today `member:remove` is `owner`/`admin` only, so an
  `assessor`, `reviewer` or `viewer` who joined the wrong organization, or who has left the
  institution, **has no exit at all** and must ask an administrator. For a product that stores consent
  records, "I cannot disassociate myself" is not a defensible position.
- **`member:revoke_owner`** — `owner` only, the mirror of the existing `member:grant_owner`. §5.4
  refuses account deletion for a last owner and tells them to *"transfer first"* — but no transfer or
  demote action exists, so the escape route the spec depends on was unrepresentable. Because the
  parent spec permits **multiple owners** (§1 decision 4, floor of one and never zero), transfer needs
  no special operation: it is grant-then-revoke, with O-14 preventing the last one from being revoked.

Six actions, then, not four. That both additions were found by pointing the oracle at the
decomposition rather than at a named fork is the point of AGENTS.md §3's fifth move.

The matrix test is generated over every (role × action) cell, so adding an action **fails the build**
until all five roles are ruled on. That is what converts "did anyone decide whether a viewer may
complete an assessment?" from a question nobody asks into a red test.

### 3.2 The bootstrap — the sanctioned before-context **write**

`withOrg` cannot create an organization. The `organizations` policy is
`WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), ''))`, and a new organization is
by definition not yet the current one, so no `ctx` exists under which the insert succeeds (D-078,
verified live on `makrai_test`). Something must mint the first capability from outside the closed
system.

**Three entry points, not one.** The adversarial pass found that step 6 builds an **org switcher**
while nothing lets an authenticated user create a second organization — so the switcher presupposed a
state the plan could not produce except by someone else issuing an invitation. Organization creation is
a **pre-context** action for the same reason as the bootstrap (D-078), so it cannot live in the RBAC
matrix and needs the same sanctioned treatment:

| Path | Precondition | Creates |
|---|---|---|
| Cold registration (`/register`) | none | `User` + `Organization` + `Membership(owner)` + consents |
| **Create another organization** (`/orgs/new`) | authenticated | `Organization` + `Membership(owner)` |
| Accept invitation (`/invitations/[token]`) | none, or authenticated | `User` (if new) + `Membership(role from the row)` |

**`bootstrapOrgWithOwner(...)`** — one function, in `lib/data/preauth.ts`, one transaction on the owner
connection, creating `User` + `Organization` + `Membership(owner)` + consent records **together**.

**Its role argument does not exist.** `owner` is hardcoded. This must be stated because its sibling —
the invitation path — legitimately *does* take a role, and the obvious refactor of two similar
owner-connection writers into one parameterised helper would be a privilege-escalation vector on the
**BYPASSRLS** connection. Two functions, one of which never accepts a role, is the safe shape.
All four in one transaction because `identityDb` deliberately exposes no `$transaction`, so splitting
the work across clients would permit the partial state "user and organization exist, consents do not."
`__tests__/integration/preauth-surface.test.ts` pins the module's exports and will fail until the new
export is deliberately added — the bypass surface stays enumerable rather than growing quietly.

**Slug is derived server-side, never chosen.** The user supplies a display name; the server lowercases
it, replaces non-alphanumerics with hyphens, collapses repeats and trims to 48 characters. On collision
it appends `-` plus **4 random hex characters** and retries on unique violation, up to 5 attempts;
**after 5 it falls back to a fully random `org-<8 hex>` slug rather than failing** — registration must
not be deniable by anyone who can cheaply force collisions (D-107). A
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

**Two axes, not one.** The first inventory of this port was built from "which files import `prisma`",
which is the correct lens for the data-layer change and the **wrong** lens for the URL restructure.
Client components fetch APIs rather than importing Prisma, so eight pages were invisible to it while
absolutely needing to move. Every file is classified on both axes below.

#### 5.2.1 Files that query tenant or identity data directly

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

#### 5.2.2 Files that query nothing directly but whose URL or fetch target moves

These import no Prisma client and were therefore absent from the first inventory. They are not in the
ESLint allowlist either — correctly, since they never imported `lib/db` — which is why that
cross-check did not surface them.

| Page | Change |
|---|---|
| `projects/new` | **Project creation.** Moves to `/orgs/[slug]/projects/new`; POSTs to `/api/v1/orgs/[slug]/projects`. **`orgId` comes from `ctx` inside the handler and is never accepted from the form** — a client-supplied `orgId` is vector #3 in the threat model |
| `assessment/[id]` | The assessment-taking UI. Moves to `/orgs/[slug]/assessment/[id]`; all fetch targets re-pointed |
| `assessment/[id]/report` | The report screen. Same move |
| `(authenticated)/layout.tsx` | Gains the **org switcher** and the per-request context memoisation (`cache()`), which is also D-099's mitigation. Switching org is a **navigation** to another slug, never a state mutation — that is what keeps browser tabs independent |
| `change-password` | Identity, not tenant. **Stays outside org scope** — a decision, not an omission |
| `explore/about`, `explore/controls`, `explore/framework` | Framework reference content, global rather than tenant. **Stay outside org scope**; they render inside the authenticated layout and so still show the switcher |

**Per-role UI exposure is part of the port, not a follow-up.** A `viewer` must not be shown a "Delete
project" control that returns 403 when clicked: it leaks capability information and is a defect in its
own right. Every mutating control is gated on `can(ctx.role, action)` at render time, and O-13 proves it.

#### 5.2.3 Shared components — found by a third lens, after the first two agreed

The first inventory used "imports `prisma`". The second used "is a page or route". **Both are
file-role lenses and both stop at `app/`.** A third — *"holds a URL or calls an API"* — reaches
`components/`, which neither of the others touches and which Plan 1a's ESLint allowlist never covered
either, correctly, since none of these import `lib/db`.

| Component | Change |
|---|---|
| `layout/Sidebar.tsx` | **8 hardcoded `href`s.** Five become org-scoped (`/orgs/[slug]/dashboard`, `/projects`, …), three stay global (`explore/*`). The active-state test `pathname.startsWith(item.href)` breaks once paths gain an `/orgs/[slug]` prefix. The admin section must gate on **org role** via `can()`, not on the platform role it uses today — and its `/admin/assessments` link is removed with that page |
| `dashboard/ProjectCard.tsx` | Links to `/projects/[id]` → `/orgs/[slug]/projects/[id]` |
| `assessment/StartAssessmentButton.tsx` | Fetches the assessments API → nested path; the control itself is gated on `assessment:create` |
| `assessment/QuickAssessment.tsx` | **See the currency note below** |
| `report/AreaCard.tsx`, `ControlResourcesList.tsx`, `ReferencesList.tsx` | Framework-reference links; audit for tenant-scoped URLs |

**Currency finding on the parent spec.** Its harvest table (§5.2) records Quick Check as `RETIRE` —
*"Not ported. Flow unreachable."* That is **not true of the code**: `components/assessment/QuickAssessment.tsx`
is imported and rendered by `assessment/[id]/page.tsx:352`, and `getQuickScore` from
`lib/engine/QuickAssessment.js` is imported by `assessments/[id]/complete/route.ts:7`. The flow is
live. Either the disposition is wrong or the retirement was never carried out; Plan 1b must resolve
which rather than porting a component the plan of record says does not exist (D-012).

#### 5.2.4 `app/(public)/**` and the files that consume the session

Found by the adversarial pass, and the reason it was missed is worth recording because it invalidates
a rule written two hours earlier. Three lenses had been applied — *"imports `prisma`"*, *"is a page
under `(authenticated)`"*, *"holds a URL in `components/`"* — and **all three searched the same three
directories.** Varying the *predicate* while holding the *search root* fixed is not a second lens, and
no number of additional predicates could have reached these files.

| File | Change |
|---|---|
| `(public)/register/page.tsx` | **The form step 3 modifies.** Gains the Organization name field; posts to the bootstrap |
| `(public)/forgot-password/page.tsx` | The D-048 stub; step 9's email work makes it real (D-022) |
| `(public)/login/page.tsx` | Unchanged, but must be confirmed rather than assumed |
| `(public)/terms`, `(public)/privacy` | Static; D-021 records that registration requires accepting pages that 404 |
| **`lib/auth-guard.ts`** | **Deleted at step 4** — see below |
| `lib/validate.ts` | Validates the organization name, which feeds slug derivation |
| `lib/rate-limit.ts` | Registration now provisions a **tenant**, not just an account (D-107) |
| `lib/security-logger.ts` | Called inside ported routes; keeps working now, gains org scope with D-105 |

**`lib/auth-guard.ts` is subsumed by step 4, not ported.** `requireAuth()` becomes `requireIdentity()`;
`requireAdmin()` becomes `requireOrgContext(slug, action)`. It must be deleted **in the same step that
removes `role` from the token**, and the reason is that the failure is otherwise *silent*:

> The session **type declaration** still declares `role`. Only the runtime callback stops populating
> it. So `session.user.role` becomes `undefined` with **no compiler error** — `tsc` passes, lint
> passes, every existing test passes, and `app/api/projects/route.ts:11`
> (`user.role === 'admin' ? {} : { createdById: user.id }`) quietly routes every admin down the
> non-admin branch. Four other call sites behave the same way.

Step 4 therefore also removes `role` and `mustChangePassword` from the **`next-auth` module
augmentation**, so that every consumer becomes a compile error rather than a silent `undefined`. That
is the difference between a step that breaks loudly and one that breaks invisibly for three steps.

#### 5.2.5 `prisma/seed.ts`

Absent from every earlier lens because it imports Prisma but is neither a page nor a route. It creates
one admin `User` and **no organization** — so after this plan a freshly seeded database yields a user
who belongs to nothing and cannot use the application. It must seed through the same
`bootstrapOrgWithOwner` path the registration flow uses, so that the seeded state is a state the
application can actually produce.

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

**`GET /api/users/me/export` must give the same answer, and currently does not.** It exports the
caller's **assessments** — which this section has just ruled are the *organization's* records, not the
person's. Deletion and export are the same question asked twice, and only one of them was reasoned
about; the other was inherited from the single-tenant app and ported unexamined. The export therefore
returns **personal data only**: account fields, consent records, and membership list. Organizational
artifacts the person authored are excluded, with the response stating plainly that assessments belong
to the organization and are available from it. O-17 pins the symmetry.

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
its sha256 digest, single-use via §4.2's conditional update, **expiring after 7 days** — a value, not
"expiring", because an unspecified duration is one an implementer invents and nobody revisits. The inviter's role caps the
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

### 6.1 Email and copy-link are both required — they were never alternatives

Found by running `what-if-oracle` on the decomposition: **step 9 and step 12 contradict each other as
originally written.** The shared testing sender delivers only to the account holder's own address,
while the exhaustive live matrix needs **20 users with 20 distinct addresses**. Nineteen of those
invitations cannot be delivered, so the live test cannot exercise the very path step 9 exists to prove.

The resolution is not to weaken either one:

| Path | Purpose | Count |
|---|---|---|
| **Real email via Resend** | Proves the delivery path end to end — template, API, inbox | **1** invitation, to the account holder |
| **Copy-link (D-030)** | Constructs the fixture and drives the matrix | the remaining **19** |

So D-030's copy-link fallback — presented as the *rejected* option when email delivery was chosen — is
**required regardless**, and would have been required by any fixture larger than one mailbox. The
invitation flow therefore returns the one-time link to the inviter *and* sends the email; the link is
displayed once and never re-derivable, since only the digest is stored (§4.2).

This is a seam defect between two decisions taken an hour apart, each sound in isolation. It is the
class AGENTS.md §3's decomposition obligation exists to catch.

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
| **O-11** | **Every (role × route) cell enforced by the real route**, both orgs, exhaustively | a route consulting the *wrong* action, or none |
| **O-12** | **Member 2 of a role acts on a resource member 1 created** → identical result | residual creator-based access |
| **O-13** | **No mutating control is rendered to a role that may not use it**, every role, every screen | UI capability over-exposure |
| **O-14** | **An organization can never reach zero owners** — the last owner cannot be demoted (`member:revoke_owner`), removed by an admin, **self-removed via `member:leave`**, or self-deleted | an org stranded with no one able to administer it |
| **O-15** | **Soft-deleting an organization revokes access on the next request** for every member, at every role, including owner | `deletedAt` filtered in one path and not another |
| **O-16** | **Every role can leave an organization unaided** — `viewer`, `reviewer` and `assessor` included, subject only to O-14 | an exit path that requires an administrator |
| **O-17** | **`GET /users/me/export` returns personal data only** — no assessment the organization owns, matching §5.4's deletion ruling | the same question answered two different ways |

O-14 and O-15 were found by applying §3's decomposition obligation to this document's *own* obligation
list, after the two defects the human partner caught. The parent spec lists "never zero owners" as an
invariant requiring a test (§2.5) and this spec had mentioned it only in passing, inside the
account-deletion paragraph — so the *self-deletion* case was covered and the *demote* and
*remove-by-admin* cases were not. `Organization.deletedAt` was likewise referenced once, in
`requireOrgContext`, with nothing asserting the behaviour.

### 7.1 Why O-11 and O-12 exist — the gap they close

`__tests__/authz/policy.test.ts` already covers `can(role, action)` over every cell. It is a **pure
function test**: it never touches a route, a session, or the database. The foundation spec's IDOR matrix
covers every route against **three personas** — other-org member, non-member, unauthenticated — and not
against each role.

Between them, those two designs leave a hole: **`can()` can be perfectly correct while every route
calls the wrong action, or no action at all, and both suites still pass.** Nothing connects the matrix
to the handlers. That gap had not been raised anywhere before the spec review on 2026-08-03.

O-12 is the discriminating case and the reason the fixture carries **two members per role** rather than
one. With a single member per role, a surviving ownership check (`assessment.userId !== user.id` — the
premise of the `lib/authz.ts` being deleted) passes silently, because that member created the row they
are acting on: role-based and creator-based access are indistinguishable. With two, member 2 acts on
member 1's resource, and any ownership residue turns the cell red. The second member is the control
condition, not extra coverage.

### 7.2 The fixture

**Two organizations × five roles × two members = 20 users**, built once in a global setup.

| Suite | Scope | Asserts |
|---|---|---|
| Integration (real HTTP, real sessions, real database) | **exhaustive** — every user × every route × both orgs | O-11, O-12, plus cross-org: *every* user of Org A against *every* Org B route → 404, **including Org A's owner**, who must get 404 rather than 403 |
| Live browser (Playwright) | **exhaustive** — every role walks every screen in both orgs | O-13, and that the rendered UI enforces what the handlers enforce |

Expectations are computed from a declared `ROUTE_ACTIONS` map (`{route, method} → Action`) fed through
`can()`. The map is the artifact under test: if a handler consults a different action than the one
declared, observed behaviour diverges from expectation and the cell fails.

**Both suites are exhaustive by ruling of the human partner, 2026-08-03.** The integration suite alone
cannot see O-13 — a `viewer` shown a "Delete" control that 403s on click leaks capability information
and is invisible to HTTP-level testing. Runtime cost is accepted and will be measured rather than
estimated; Playwright `storageState` authenticates each of the 20 users once and reuses the session
across specs.

**Hard dependency, sequenced early for that reason:** Playwright's Chromium failed to launch on this
machine during Plan 1a with a Qt platform-plugin error, while the chrome-devtools MCP worked (D-102).
An exhaustive live matrix cannot be a step-10 discovery. Proving the browser launcher is **step 0**.

Every guard is proven **non-vacuous** by reverting it and watching the test go red — the Plan 1a
discipline, retained because a test that passes for the wrong reason is the failure these tests exist
to catch.

---

## 8. Definition of done

| Gate | Evidence |
|---|---|
| `npm run verify` green | `tsc` **0 errors** (D-070 closes), lint 0, all tests pass |
| Isolation matrix | every ported route × {other-org member, non-member, unauthenticated} → 404 |
| O-1…O-13 | all passing, each proven non-vacuous |
| **Role × permission, exhaustive** | 2 orgs × 5 roles × 2 members, every route, at the integration level (O-11, O-12) **and** every role walking every screen live (O-13) |
| **Two organizations, independently created** | Org A and Org B each created through the real registration flow by their own owner — **not** one org with two members. A member of A cannot reach B by direct URL at any role, including owner |
| **A full assessment, end to end** | created, answered, completed, report rendered, PDF downloaded — inside an org, by a member with the role that permits it |
| Invitations | an owner invites a colleague; the colleague joins at the invited role; a forwarded link is refused for a different account |
| Email | one real invitation delivered and opened |
| Register | no `Open` row targeted at Phase 1b that is not explicitly re-targeted with justification |

The second row is stated explicitly because the first draft of this spec got it wrong: it described an
invitation moving a second user into the *same* organization as demonstrating "two orgs, isolated
data". That demonstrates invitations and proves nothing about isolation — there is no second tenant to
be isolated from. Two organizations means the whole create-org path runs twice, from two different
owners. Corrected at the spec review on 2026-08-03.

Followed by a plain statement of what was and was not verified live.

---

## 9. Task sequence

Each step is blocked by the one above it; this is not a preference.

0. **Prove the browser launcher.** Playwright's Chromium failed here on a Qt platform-plugin error
   during Plan 1a while the chrome-devtools MCP worked (D-102). The definition of done now requires an
   **exhaustive** live matrix, so the launcher is a hard dependency and cannot be a step-10 discovery.
   Timeboxed; if Playwright cannot be made to launch, decide the vehicle before building the fixture.
1. **RBAC matrix reconciliation** — four missing actions (§3.1)
2. **Schema + migration** — `sessionEpoch`, `tokenHash`/`acceptedAt` + `CHECK`, guarded `Legacy` delete
   (§4). Applied to **both** databases (`makrai` and `makrai_test`), and the catalog re-verified after,
   as Plan 1a did
3. **`bootstrapOrgWithOwner`** + registration rewrite, org name on the `(public)/register` form, plus
   **`/orgs/new`** so an authenticated user can create a second organization — without it the switcher
   built at step 6 has nothing to switch to (§3.2)
4. **`requireIdentity`** + `sessionEpoch` checks + ESLint ban on raw `auth` (§3.3). **In the same step:
   delete `lib/auth-guard.ts` and strip `role`/`mustChangePassword` from the `next-auth` module
   augmentation**, so every consumer becomes a compile error instead of a silent `undefined` (§5.2.4).
   Splitting these across steps leaves three steps during which `tsc` is green and admin authorization
   is quietly wrong
5. **`requireOrgContext`** + branded `OrgContext` (§3.4)
6. **URL restructure** to `/orgs/[slug]/…` + `proxy.ts` + org switcher (§5.1)
7. **Resolve every file across all three lenses** — the 22 allowlisted files (port most, delete
   `research/export` and `lib/authz.ts`, remove one page, reduce another), the 8 URL-moving pages, the
   7 shared components, and `prisma/seed.ts`. The ESLint allowlist shrinks to zero and the override
   block is deleted (§5.2, D-074). **Completeness is generated, not asserted:** a test enumerates
   `app/**/page.tsx`, `app/**/route.ts` and `components/**` from disk and fails on any file absent
   from the port checklist, and a second enumerates route files and fails on any missing a
   `ROUTE_ACTIONS` entry. Hand-written lists that must be complete are latent defects with a timestamp
   (AGENTS.md §3, D-103)
8. **Invitations** — create, accept, revoke (§6)
9. **Email live** via Resend (§6) — the only step gated on something outside this repo
10. **The 20-user fixture** — 2 orgs × 5 roles × 2 members, built once in a global setup and shared by
    both suites (§7.2)
11. **Exhaustive role × permission matrix** at the integration level — O-11, O-12
12. **Exhaustive live verification** — every role walks every screen in both orgs; O-13; plus the
    end-to-end gates in §8

The route port is step 7, not step 1. The SDD ledger's resume note called it "the first task"; that was
written before checking, and it is wrong — steps 3–5 are hard prerequisites.

---

## 10. Deferrals recorded by this design

Opened in commit `4fe15c3` alongside ADR-0002: **D-097** (plaintext invitation tokens), **D-098**
(invitation email binding), **D-099** (per-request identity reads pressure the owner connection and the
obvious fix re-opens D-075), **D-100** (the ADR index linked a nonexistent ADR-0002; no mechanism checks
document cross-references), **D-101** (slug-collision existence oracle; timing-distinguishable 404
branches). Opened at the spec review: **D-102** (Playwright's Chromium does not launch here, and the
exhaustive-live ruling turns that from a footnote with a workaround into a hard dependency of the
phase exit), **D-103** (design-time completeness had no checkpoint — the diagnosis behind AGENTS.md
§3's decomposition obligation, carrying its own falsifiable test).

Opened by running `what-if-oracle` on this decomposition, all deliberately **out** of Plan 1b's scope
with triggers rather than phases: **D-104** (org-visible data makes concurrent editing possible for the
first time and nothing detects a conflict), **D-105** (no tenant-scoped audit trail in a tool that
scores institutions on record-keeping), **D-106** (`MembershipStatus` filtered for but never set),
**D-107** (unbounded organization creation).

Three findings from that same pass were **not** deferred, because each was a hole in what this plan
already claims to do rather than new scope: the email/copy-link collision (§6.1), `member:leave` and
`member:revoke_owner` (§3.1), and the export/delete symmetry (§5.4).

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
