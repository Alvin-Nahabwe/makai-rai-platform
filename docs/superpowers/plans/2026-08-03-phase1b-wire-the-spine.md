# Plan 1b — Wiring the Isolation Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the multi-tenant isolation spine built in Plan 1a to the application, and make the organization lifecycle real, so that two independently-created organizations hold isolated data that is verified live.

**Architecture:** Registration becomes a tenant bootstrap (`User` + `Organization` + `Membership(owner)` in one owner-connection transaction, because the `organizations` RLS policy makes creation via the app role structurally impossible). Every request resolves identity at one choke point and org membership from the database, producing a **branded** `OrgContext` that `withOrg` alone accepts. Routes and pages move under `/orgs/[slug]/…` so the active organization is an explicit URL parameter rather than ambient state, and Postgres RLS — not application code — filters every tenant row.

**Tech Stack:** Next.js 16.2.9 (App Router, `proxy.ts` — **not** `middleware.ts`), Prisma 7.8 + `@prisma/adapter-pg`, next-auth 5.0.0-beta.31, PostgreSQL 16 with RLS + `FORCE ROW LEVEL SECURITY`, vitest, Playwright, Resend 6.16.0.

**Source of truth:** `docs/superpowers/specs/2026-08-03-phase1b-wire-the-spine-design.md`. **Read it before Task 1.** It carries the reasoning; this plan carries the steps.

---

## Global Constraints

Every task's requirements implicitly include all of these.

1. **Tenant data goes through `withOrg(ctx, cb)` only.** Non-tenant (`User`, `ConsentRecord`) through `identityDb`. Before-context reads and writes through `lib/data/preauth.ts`. Nothing else. (ADR-0001)
2. **`app/**` may not import `lib/db` or `auth` from `lib/auth`.** Enforced by ESLint `no-restricted-imports` **and** `no-restricted-syntax` (the latter catches dynamic `import()` and `require()`, which a specifier-only ban misses).
3. **Identifiers are quoted camelCase `TEXT`.** Never write `::uuid` against `"orgId"` or `organizations.id` — it raises `operator does not exist: text = uuid`. (D-064)
4. **Migrations run as the superuser `makrai` and must be applied to BOTH databases** — `makrai` and `makrai_test` — with the catalog re-verified after. (D-079)
5. **Every guard is proven non-vacuous**: revert the guard, watch the test go red, restore it. A test that passes for the wrong reason is the failure these tests exist to catch.
6. **Where a list must be complete, generate it from the source of truth** rather than writing it. Hand-written lists that must be complete are latent defects with a timestamp. (AGENTS.md §3, D-103)
7. **Role is never carried in the JWT.** The token asserts identity only. (ADR-0002)
8. **`git status --porcelain --untracked-files=all` must be empty at the end of every task.** Untracked residue is invisible to every reviewer.
9. **Register a row in `docs/DEFERRED_REGISTER.md` in the same commit** as any deferral, substitution, or triggered-skill-not-run. (AGENTS.md §6)
10. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Verification commands** (exact):

| Purpose | Command |
|---|---|
| Types | `npm run typecheck` — **currently 3 errors** (D-070); **0 after Task 7** |
| Lint | `npm run lint` — must stay at 0 problems |
| Unit + integration | `npm test` |
| One file | `npx vitest run __tests__/path/to.test.ts` |
| E2E | `npm run test:e2e` |
| Everything | `npm run verify` — **red until Task 7**, green thereafter |
| Migrate | `npx prisma migrate dev --name <name>` then apply to test DB (Task 2) |

---

## File Structure

**New files**

| File | Single responsibility |
|---|---|
| `lib/auth/identity.ts` | `requireIdentity()` — the one place a session becomes a verified identity. Nothing else. |
| `lib/auth/context.ts` | `requireOrgContext(slug, action)` — the one place a slug becomes a proven `OrgContext`. |
| `lib/authz/routeActions.ts` | `ROUTE_ACTIONS` — the declared `{route, method} → Action` map. The artifact the matrix tests. |
| `lib/email/send.ts` | Resend transport. One export; no template logic. |
| `lib/email/templates.ts` | Invitation email body. Pure functions, no I/O. |
| `app/(public)/invitations/[token]/page.tsx` | Invitation acceptance. Pre-membership by nature. |
| `app/(authenticated)/orgs/new/page.tsx` | Create a second organization when already authenticated. |
| `__tests__/helpers/fixture.ts` | `buildTwoOrgFixture()` — the 20-user fixture, built once, shared by both suites. |

**Modified** — `lib/authz/policy.ts`, `lib/data/tenant.ts`, `lib/data/preauth.ts`, `lib/auth.ts`, `prisma/schema.prisma`, `prisma/seed.ts`, `proxy.ts`, `eslint.config.mjs`, and everything under §5.2 of the spec.

**Deleted** — `lib/authz.ts` (its ownership premise is wrong under tenancy), `lib/auth-guard.ts` (subsumed by `requireIdentity`/`requireOrgContext`), `app/api/research/export/route.ts` (D-007), `app/(authenticated)/admin/assessments/page.tsx` (D-006).

---

## Task 0: Prove the browser launcher

**Why first:** the definition of done requires an *exhaustive* live matrix. Playwright's Chromium failed here during Plan 1a on a Qt platform-plugin error (D-102). Discovering that at Task 12 is discovering it when the tempting response is to weaken the exit criterion rather than fix the tooling.

**Files:** none necessarily; possibly `playwright.config.ts`.

**Interfaces:** Produces — a working `npm run test:e2e`, or a recorded decision about the verification vehicle.

- [ ] **Step 1: Reproduce the failure and capture the exact error**

```bash
npx playwright test --list 2>&1 | tail -20
npx playwright install chromium 2>&1 | tail -5
```

Record the **verbatim** error. Per AGENTS.md §5, one error message is a symptom, not a diagnosis.

- [ ] **Step 2: Invoke `superpowers:systematic-debugging`**

This is D-084's lesson: the skill was never invoked across four real debugging episodes in Plan 1a. A Qt platform-plugin error most commonly names a missing system library.

- [ ] **Step 3: Try the documented dependency install**

```bash
npx playwright install-deps chromium
npx playwright test --list
```

- [ ] **Step 4: Confirm a real browser run**

```bash
npm run test:e2e
```
Expected: the three existing specs execute (pass or fail on assertions — *launching* is what is under test).

- [ ] **Step 5: If it still fails after a 60-minute timebox, STOP and escalate with findings**

Per AGENTS.md §5, escalate with *"I ran X, got Y, cause is Z, here are the options"* — not a verdict. Options to present: run the live matrix through the `chrome-devtools` MCP (slow, one call per interaction); run Playwright in a container; reduce the live matrix to representative and record the exception explicitly. **Do not silently downgrade the exit criterion.**

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore(e2e): prove the Playwright launcher (D-102)"
```

---

## Task 1: Reconcile the RBAC matrix

**Why before everything else:** `POST /assessments/[id]/complete` and `/remediation` are ported in Task 7, and no action exists to express their check. An implementer reaching those files improvises with `assessment:update`, silently granting completion to everyone who can edit.

**Files:**
- Modify: `lib/authz/policy.ts`
- Modify: `__tests__/authz/policy.test.ts`

**Interfaces:**
- Produces: `Action` gains `'org:read' | 'assessment:respond' | 'assessment:complete' | 'remediation:update' | 'member:leave' | 'member:revoke_owner'`. `can(role: OrgRole, action: Action): boolean` is unchanged in signature.

- [ ] **Step 1: Write the failing test**

Add to `__tests__/authz/policy.test.ts`'s existing `MATRIX` fixture. The suite already generates one `it()` per (role × action) cell, so extending the fixture extends the tests.

```ts
// __tests__/authz/policy.test.ts — extend the existing MATRIX constant
const MATRIX: Record<Action, OrgRole[]> = {
  // ... existing entries unchanged ...
  'org:read':            ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'assessment:respond':  ['owner', 'admin', 'assessor'],
  'assessment:complete': ['owner', 'admin', 'assessor'],
  'remediation:update':  ['owner', 'admin', 'assessor'],
  'member:leave':        ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'member:revoke_owner': ['owner'],
};
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run __tests__/authz/policy.test.ts
```
Expected: FAIL — TypeScript rejects the unknown keys, since `MATRIX` is typed `Record<Action, …>`.

- [ ] **Step 3: Add the actions and grants**

```ts
// lib/authz/policy.ts
export type Action =
  | 'org:read' | 'org:update' | 'org:delete'
  | 'project:read' | 'project:create' | 'project:update' | 'project:delete'
  | 'assessment:read' | 'assessment:create' | 'assessment:update' | 'assessment:delete'
  | 'assessment:respond' | 'assessment:complete'
  | 'remediation:update'
  | 'member:read' | 'member:invite' | 'member:remove' | 'member:leave'
  | 'member:grant_owner' | 'member:revoke_owner';
```

Then extend each role's array in `GRANTS` to match the matrix above. **`member:leave` goes to all five roles** — `member:remove` is owner/admin-only, so without it an `assessor`, `reviewer` or `viewer` has no way out of an organization at all.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run __tests__/authz/policy.test.ts && npm run typecheck
```
Expected: PASS. `typecheck` still shows exactly **3** errors (D-070, closed in Task 7).

- [ ] **Step 5: Prove non-vacuity**

Temporarily remove `'member:leave'` from `viewer`'s grants; re-run; confirm the `viewer may member:leave` case goes red. Restore.

- [ ] **Step 6: Commit**

```bash
git add lib/authz/policy.ts __tests__/authz/policy.test.ts
git commit -m "feat(authz): six actions the port needs, including member:leave and member:revoke_owner"
```

---

## Task 2: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_session_epoch_and_invitation_digest/migration.sql`
- Modify: `__tests__/integration/schema.test.ts`

**Interfaces:**
- Produces: `users.sessionEpoch Int @default(0)`; `invitations.tokenHash String @unique` (replacing `token`); `invitations.acceptedAt DateTime?`.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/integration/schema.test.ts
it('stores invitation tokens only as a sha256 hex digest, enforced by CHECK', async () => {
  const rows = await testDb.$queryRaw<{ conname: string }[]>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'invitations'::regclass AND contype = 'c'
      AND conname = 'invitations_tokenHash_is_sha256_hex'`;
  expect(rows).toHaveLength(1);
});

it('rejects a plaintext token in tokenHash', async () => {
  await expect(
    testDb.$executeRawUnsafe(
      `INSERT INTO "invitations" ("id","orgId","email","role","tokenHash","invitedById","expiresAt")
       VALUES ('i1','o1','a@b.c','viewer','not-a-digest','u1', now() + interval '7 days')`),
  ).rejects.toThrow(/invitations_tokenHash_is_sha256_hex|violates check constraint/);
});

it('gives every user a sessionEpoch defaulting to 0', async () => {
  const [col] = await testDb.$queryRaw<{ column_default: string; is_nullable: string }[]>`
    SELECT column_default, is_nullable FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'sessionEpoch'`;
  expect(col.is_nullable).toBe('NO');
  expect(col.column_default).toBe('0');
});

it('has removed the vestigial Legacy organization', async () => {
  const rows = await testDb.$queryRaw<{ id: string }[]>`
    SELECT id FROM organizations WHERE id = '00000000-0000-0000-0000-000000000001'`;
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run __tests__/integration/schema.test.ts
```
Expected: FAIL — no such constraint, no such column, Legacy row present.

- [ ] **Step 3: Edit the schema**

```prisma
model User {
  // ... existing fields ...
  sessionEpoch Int @default(0)
}

model Invitation {
  // ... replace `token String @unique` with:
  tokenHash  String    @unique
  acceptedAt DateTime?
}
```

- [ ] **Step 4: Generate the migration and hand-edit it**

```bash
npx prisma migrate dev --name session_epoch_and_invitation_digest --create-only
```

Append to the generated SQL — Prisma will not produce these:

```sql
-- A plaintext token cannot satisfy this. D-097 becomes structurally
-- unrepresentable rather than something reviewers must remember to check.
ALTER TABLE "invitations"
  ADD CONSTRAINT "invitations_tokenHash_is_sha256_hex"
  CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- The Legacy org was inserted by 20260803034110 so SET NOT NULL could apply.
-- It now has no members and no projects.
--
-- This DELETE works because migrations run as `makrai`, a SUPERUSER, and
-- superusers bypass RLS unconditionally; FORCE ROW LEVEL SECURITY binds a
-- non-superuser OWNER, not a superuser (D-079). A migration run under a
-- non-superuser owner would need `SET LOCAL app.current_org_id` first.
--
-- The NOT EXISTS guards make this a no-op wherever the row is load-bearing.
-- Both known databases hold zero tenant rows; this will also run against
-- databases nobody here has seen.
DELETE FROM "organizations" o
 WHERE o.id = '00000000-0000-0000-0000-000000000001'
   AND NOT EXISTS (SELECT 1 FROM "projects"    p WHERE p."orgId" = o.id)
   AND NOT EXISTS (SELECT 1 FROM "memberships" m WHERE m."orgId" = o.id);
```

- [ ] **Step 5: Apply to both databases and verify the catalog**

```bash
npx prisma migrate deploy
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
```

Then confirm both are identical:

```bash
node -e "
require('dotenv/config'); const {Pool}=require('pg');
(async()=>{for(const u of [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL]){
 const p=new Pool({connectionString:u});
 const q=await p.query(\`select
   (select count(*) from information_schema.columns where table_name='users' and column_name='sessionEpoch') epoch,
   (select count(*) from pg_constraint where conname='invitations_tokenHash_is_sha256_hex') chk,
   (select count(*) from organizations where id='00000000-0000-0000-0000-000000000001') legacy,
   (select count(*) from pg_class where relrowsecurity and relforcerowsecurity) forced\`);
 console.log(u.split('/').pop(), JSON.stringify(q.rows[0])); await p.end();}})()"
```
Expected on both: `epoch=1, chk=1, legacy=0, forced=7`.

- [ ] **Step 6: Run tests**

```bash
npx vitest run __tests__/integration/schema.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/ __tests__/integration/schema.test.ts
git commit -m "feat(schema): sessionEpoch, hashed invitation tokens, drop the Legacy org (D-097)"
```

---

## Task 3: The bootstrap — three pre-context entry points

**Files:**
- Modify: `lib/data/preauth.ts`
- Modify: `app/api/auth/register/route.ts`
- Modify: `app/(public)/register/page.tsx`
- Create: `app/(authenticated)/orgs/new/page.tsx`, `app/api/v1/orgs/route.ts`
- Modify: `__tests__/integration/preauth-surface.test.ts`
- Create: `__tests__/integration/bootstrap.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export function bootstrapOrgWithOwner(input: {
    email: string; name: string; passwordHash: string;
    orgName: string; researchConsent: boolean; ipAddress: string;
  }): Promise<{ userId: string; orgId: string; slug: string }>;

  export function createOrgForUser(input: {
    userId: string; orgName: string;
  }): Promise<{ orgId: string; slug: string }>;

  export function deriveSlug(orgName: string): string;   // exported for testing
  ```
  **Neither function accepts a role.** `owner` is hardcoded in both. The invitation path (Task 8) legitimately takes a role from its row; merging the two into one parameterised helper would be a privilege-escalation vector on the BYPASSRLS connection.

- [ ] **Step 1: Write the failing tests**

```ts
// __tests__/integration/bootstrap.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { bootstrapOrgWithOwner, createOrgForUser, deriveSlug } from '../../lib/data/preauth';

beforeEach(resetDb);

describe('bootstrapOrgWithOwner', () => {
  it('creates user, organization, owner membership and consents atomically', async () => {
    const r = await bootstrapOrgWithOwner({
      email: 'a@uni.ac.ug', name: 'A', passwordHash: 'x',
      orgName: 'Makerere AI Lab', researchConsent: true, ipAddress: '127.0.0.1',
    });
    const m = await testDb.membership.findFirst({ where: { userId: r.userId, orgId: r.orgId } });
    expect(m?.role).toBe('owner');
    expect(m?.status).toBe('active');
    expect(await testDb.consentRecord.count({ where: { userId: r.userId } })).toBe(3);
    expect(r.slug).toBe('makerere-ai-lab');
  });

  it('writes nothing at all when any part fails', async () => {
    await bootstrapOrgWithOwner({
      email: 'dup@uni.ac.ug', name: 'A', passwordHash: 'x',
      orgName: 'One', researchConsent: false, ipAddress: '127.0.0.1' });
    await expect(bootstrapOrgWithOwner({
      email: 'dup@uni.ac.ug', name: 'B', passwordHash: 'y',
      orgName: 'Two', researchConsent: false, ipAddress: '127.0.0.1' })).rejects.toThrow();
    // The second organization must NOT exist — the transaction rolled back.
    expect(await testDb.organization.count({ where: { name: 'Two' } })).toBe(0);
  });

  it('never reports a slug collision to the caller', async () => {
    const a = await bootstrapOrgWithOwner({ email: 'x@u.ac', name: 'X', passwordHash: 'x',
      orgName: 'Shared Name', researchConsent: false, ipAddress: '1.1.1.1' });
    const b = await bootstrapOrgWithOwner({ email: 'y@u.ac', name: 'Y', passwordHash: 'y',
      orgName: 'Shared Name', researchConsent: false, ipAddress: '1.1.1.1' });
    expect(a.slug).toBe('shared-name');
    expect(b.slug).toMatch(/^shared-name-[0-9a-f]{4}$/);   // random, not sequential
  });
});

describe('deriveSlug', () => {
  it.each([
    ['Makerere AI Lab', 'makerere-ai-lab'],
    ['  Spaces   Everywhere  ', 'spaces-everywhere'],
    ['Ünïcødé & Symbols!!', 'n-c-d-symbols'],
    ['a'.repeat(80), 'a'.repeat(48)],
  ])('derives %j to %j', (input, expected) => expect(deriveSlug(input)).toBe(expected));
});

describe('createOrgForUser', () => {
  it('makes an existing user the owner of a second organization', async () => {
    const first = await bootstrapOrgWithOwner({ email: 'z@u.ac', name: 'Z', passwordHash: 'z',
      orgName: 'First Org', researchConsent: false, ipAddress: '1.1.1.1' });
    const second = await createOrgForUser({ userId: first.userId, orgName: 'Second Org' });
    const memberships = await testDb.membership.findMany({ where: { userId: first.userId } });
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.role === 'owner')).toBe(true);
    expect(second.slug).toBe('second-org');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run __tests__/integration/bootstrap.test.ts
```
Expected: FAIL — `bootstrapOrgWithOwner is not a function`.

- [ ] **Step 3: Implement in `lib/data/preauth.ts`**

```ts
import { randomBytes } from 'node:crypto';

/**
 * The sanctioned before-context WRITE. `withOrg` structurally cannot create an
 * organization: the `organizations` policy is
 * WITH CHECK (id = NULLIF(current_setting('app.current_org_id', true), ''))
 * and a NEW organization is by definition not yet the current one (D-078).
 *
 * All four rows in ONE transaction: `identityDb` deliberately exposes no
 * $transaction, so splitting this across clients would permit the partial state
 * "user and organization exist, consents do not".
 *
 * There is no `role` parameter and there must never be one. Its sibling
 * `acceptInvitation` legitimately takes a role from the invitation row; merging
 * the two into one parameterised helper would be a privilege-escalation vector
 * on a connection that bypasses RLS.
 */
export function bootstrapOrgWithOwner(input: {
  email: string; name: string; passwordHash: string;
  orgName: string; researchConsent: boolean; ipAddress: string;
}): Promise<{ userId: string; orgId: string; slug: string }> {
  return ownerClient.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: input.email, name: input.name, passwordHash: input.passwordHash,
        termsAccepted: true, termsAcceptedAt: new Date(),
        researchConsent: input.researchConsent,
      },
    });
    const org = await createOrgInTx(tx, input.orgName);
    await tx.membership.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    await tx.consentRecord.createMany({
      data: [
        { userId: user.id, consentType: 'terms_of_service', granted: true, ipAddress: input.ipAddress },
        { userId: user.id, consentType: 'privacy_policy',   granted: true, ipAddress: input.ipAddress },
        ...(input.researchConsent
          ? [{ userId: user.id, consentType: 'research_data_usage' as const, granted: true, ipAddress: input.ipAddress }]
          : []),
      ],
    });
    return { userId: user.id, orgId: org.id, slug: org.slug };
  });
}

export function createOrgForUser(input: { userId: string; orgName: string }) {
  return ownerClient.$transaction(async (tx) => {
    const org = await createOrgInTx(tx, input.orgName);
    await tx.membership.create({ data: { orgId: org.id, userId: input.userId, role: 'owner' } });
    return { orgId: org.id, slug: org.slug };
  });
}

/** Derived server-side, never chosen. A "that slug is taken" error is an org-existence oracle (D-101). */
export function deriveSlug(orgName: string): string {
  return orgName.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

async function createOrgInTx(tx: TenantTx, orgName: string) {
  const base = deriveSlug(orgName) || 'org';
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    try {
      return await tx.organization.create({ data: { name: orgName, slug } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;   // only a slug collision may be retried
    }
  }
  // Registration must not be deniable by anyone who can cheaply force collisions (D-107).
  return tx.organization.create({
    data: { name: orgName, slug: `org-${randomBytes(4).toString('hex')}` },
  });
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'P2002';
}
```

- [ ] **Step 4: Extend the surface-pinning test**

`__tests__/integration/preauth-surface.test.ts` pins this module's exports and **will now fail**. Add `bootstrapOrgWithOwner`, `createOrgForUser` and `deriveSlug` to the expected set. That failure is the forced checkpoint working — the bypass surface stays enumerable.

- [ ] **Step 5: Rewrite the registration route and form**

`app/api/auth/register/route.ts` calls `bootstrapOrgWithOwner` instead of `prisma.user.create` + `prisma.consentRecord.createMany`. Validate `orgName` with `validateString(body.orgName, 'organization name', 100)` from `lib/validate.ts`. `app/(public)/register/page.tsx` gains an **Organization name** input, `required`, added to the `form` state object and the POST body.

- [ ] **Step 6: Run tests and prove non-vacuity**

```bash
npx vitest run __tests__/integration/bootstrap.test.ts __tests__/integration/preauth-surface.test.ts
```
Then remove the `await` on `tx.membership.create` so the transaction no longer waits, re-run, confirm the atomicity test goes red. Restore.

- [ ] **Step 7: Commit**

```bash
git add lib/data/preauth.ts app/ __tests__/
git commit -m "feat(tenancy): the sanctioned before-context write — registration creates a tenant (D-078)"
```

> **`/orgs/new` is deliberately NOT in this task.** It needs `requireIdentity()`, which Task 4 creates, and Task 4's own tests need `bootstrapOrgWithOwner` from this task. Splitting the dependency that way keeps both tasks independently testable; putting `/orgs/new` here would make Task 3 un-runnable on its own.

---

## Task 4: `requireIdentity`, and the silent-failure fix

**The dangerous step in this plan.** Removing `role` from the token does **not** produce a compile error, because the `next-auth` module augmentation still declares it. `session.user.role` silently becomes `undefined`, `app/api/projects/route.ts:11` routes every admin down the non-admin branch, and `tsc`, ESLint and every existing test stay green. The augmentation and `lib/auth-guard.ts` therefore change **in this same commit**.

**Files:**
- Create: `lib/auth/identity.ts`
- Modify: `lib/auth.ts`, `types/next-auth.d.ts` (or wherever the augmentation lives — find with `grep -rn "declare module 'next-auth'" .`)
- Modify: `eslint.config.mjs`
- **Delete:** `lib/auth-guard.ts`
- Create: `__tests__/integration/identity.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Identity = {
    userId: string; email: string; name: string | null;
    platformRole: 'admin' | 'assessor'; mustChangePassword: boolean;
  };
  export function requireIdentity(): Promise<Identity>;   // redirects to /login when absent
  export async function bumpSessionEpoch(userId: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/integration/identity.test.ts
it('rejects a token whose sessionEpoch is stale', async () => {
  const { userId } = await bootstrapOrgWithOwner({ /* … */ });
  const token = { id: userId, sessionEpoch: 0 };
  await bumpSessionEpoch(userId);                       // logout-everywhere
  await expect(resolveIdentity(token)).rejects.toThrow(/session/i);
});

it('rejects a token for a deactivated user', async () => {
  const { userId } = await bootstrapOrgWithOwner({ /* … */ });
  await identityDb.user.update({ where: { id: userId }, data: { isActive: false } });
  await expect(resolveIdentity({ id: userId, sessionEpoch: 0 })).rejects.toThrow(/inactive|session/i);
});

it('reads platformRole from the database, not the token', async () => {
  const { userId } = await bootstrapOrgWithOwner({ /* … */ });
  await identityDb.user.update({ where: { id: userId }, data: { role: 'admin' } });
  const id = await resolveIdentity({ id: userId, sessionEpoch: 0 });
  expect(id.platformRole).toBe('admin');               // token said nothing about role
});
```

Export a pure `resolveIdentity(token)` from `lib/auth/identity.ts` so the logic is testable without a request; `requireIdentity()` is the thin wrapper that reads the session and redirects.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run __tests__/integration/identity.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// lib/auth/identity.ts
const ABSOLUTE_MAX_AGE_S = 7 * 24 * 60 * 60;

export async function resolveIdentity(token: {
  id?: unknown; sessionEpoch?: unknown; iat?: unknown;
}): Promise<Identity> {
  if (typeof token.id !== 'string' || token.id.length === 0) throw new SessionError('no subject');
  if (typeof token.iat === 'number' && Date.now() / 1000 - token.iat > ABSOLUTE_MAX_AGE_S) {
    throw new SessionError('absolute session lifetime exceeded');
  }
  const user = await identityDb.user.findUnique({
    where: { id: token.id },
    select: { id: true, email: true, name: true, role: true,
              isActive: true, mustChangePassword: true, sessionEpoch: true },
  });
  if (!user || !user.isActive) throw new SessionError('inactive');
  if (user.sessionEpoch !== token.sessionEpoch) throw new SessionError('session revoked');
  return { userId: user.id, email: user.email, name: user.name,
           platformRole: user.role, mustChangePassword: user.mustChangePassword };
}
```

In `lib/auth.ts`: `session: { strategy: 'jwt', maxAge: 12 * 60 * 60 }`; the `jwt` callback sets `token.sessionEpoch = user.sessionEpoch` and **stops setting `role` and `mustChangePassword`**; the `session` callback exposes only `id`.

- [ ] **Step 4: Strip the module augmentation — this is what makes the failure loud**

Remove `role` and `mustChangePassword` from the `next-auth` `Session`/`JWT` augmentation. Every consumer now becomes a **compile error** rather than a silent `undefined`.

```bash
npm run typecheck
```
Expected: MORE than 3 errors now — one per `session.user.role` reader. That increase is the point. Task 7 drives it to 0.

- [ ] **Step 5: Delete `lib/auth-guard.ts` and ban the raw session**

```js
// eslint.config.mjs — add to the existing app/**,lib/** block's patterns array
{ group: ['@/lib/auth', '**/lib/auth', './auth', '../auth'],
  importNames: ['auth'],
  message: 'Use requireIdentity() from lib/auth/identity.ts. See ADR-0002.' }
```
Add `lib/auth/identity.ts` to that block's `ignores`.

- [ ] **Step 6: Add `/orgs/new` — the second entry point**

Now that `requireIdentity()` exists. Without this, the org switcher built in Task 6 has nothing to switch to: registration creates an org, invitations join one, and nothing else lets an authenticated user create a second.

```ts
// app/api/v1/orgs/route.ts
export async function POST(req: NextRequest) {
  const identity = await requireIdentity();
  const { orgName } = await req.json();
  const result = validateString(orgName, 'organization name', 100);
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
  const { slug } = await createOrgForUser({ userId: identity.userId, orgName: result.value });
  return NextResponse.json({ slug }, { status: 201 });
}
```

`app/(authenticated)/orgs/new/page.tsx` is a form posting to it, redirecting to `/orgs/${slug}/dashboard` on success.

- [ ] **Step 7: Prove non-vacuity and commit**

Revert the `sessionEpoch` comparison to `true`; confirm the revocation test goes red; restore.

```bash
npm run lint
git add -A && git commit -m "feat(auth): one identity choke point; role leaves the token (D-045)"
```

---

## Task 5: `requireOrgContext` and the branded context

**Files:**
- Create: `lib/auth/context.ts`
- Modify: `lib/data/tenant.ts`, `eslint.config.mjs`
- Create: `__tests__/integration/org-context.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/data/tenant.ts
  declare const orgContextBrand: unique symbol;
  export type OrgContext = {
    readonly orgId: string; readonly role: OrgRole;
    readonly [orgContextBrand]: true;
  };
  export function createOrgContext(orgId: string, role: OrgRole): OrgContext;  // restricted by ESLint

  // lib/auth/context.ts
  export function requireOrgContext(slug: string, action: Action): Promise<OrgContext>;
  ```

**Honest limit, stated so no one over-trusts it:** branding stops *accidental* construction — `withOrg({ orgId: body.orgId, role: 'owner' })` becomes a type error. It does not stop a deliberate `as OrgContext` cast. The runtime guarantee comes from `requireOrgContext` being the only caller of `createOrgContext`, which Step 5 enforces with a generated test rather than a reviewer's memory.

- [ ] **Step 1: Write the failing test**

```ts
// __tests__/integration/org-context.test.ts
it('refuses a slug the caller is not a member of', async () => {
  const a = await bootstrapOrgWithOwner({ /* org A */ });
  const b = await bootstrapOrgWithOwner({ /* org B */ });
  await expect(requireOrgContextFor(a.userId, b.slug, 'project:read')).rejects.toThrow(NotFoundError);
});

it('refuses an unknown slug with the SAME error as a non-member slug', async () => {
  const a = await bootstrapOrgWithOwner({ /* … */ });
  const e1 = await requireOrgContextFor(a.userId, 'no-such-org', 'project:read').catch((e) => e);
  const e2 = await requireOrgContextFor(a.userId, 'other-org',   'project:read').catch((e) => e);
  expect(e1.constructor).toBe(e2.constructor);   // 404 either way; never confirm existence
});

it('refuses a suspended membership', async () => {
  const a = await bootstrapOrgWithOwner({ /* … */ });
  await testDb.membership.updateMany({ where: { userId: a.userId }, data: { status: 'suspended' } });
  await expect(requireOrgContextFor(a.userId, a.slug, 'project:read')).rejects.toThrow(NotFoundError);
});

it('refuses a soft-deleted organization', async () => {         // O-15
  const a = await bootstrapOrgWithOwner({ /* … */ });
  await testDb.organization.update({ where: { id: a.orgId }, data: { deletedAt: new Date() } });
  await expect(requireOrgContextFor(a.userId, a.slug, 'project:read')).rejects.toThrow(NotFoundError);
});

it('403s a member whose role lacks the action, and 404s a non-member', async () => {
  // viewer in their OWN org attempting project:create -> ForbiddenError, not NotFoundError
});

it('ignores lastActiveOrgId entirely', async () => {            // O-2
  const a = await bootstrapOrgWithOwner({ /* … */ });
  const b = await bootstrapOrgWithOwner({ /* … */ });
  await identityDb.user.update({ where: { id: a.userId }, data: { lastActiveOrgId: b.orgId } });
  await expect(requireOrgContextFor(a.userId, b.slug, 'project:read')).rejects.toThrow(NotFoundError);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run __tests__/integration/org-context.test.ts
```

- [ ] **Step 3: Implement**

```ts
// lib/auth/context.ts
export async function resolveOrgContext(
  userId: string, slug: string, action: Action,
): Promise<OrgContext> {
  // BOTH lookups run unconditionally, even when the first returns nothing, so
  // the two 404 branches do equal work and stop being timing-distinguishable (D-101).
  const [org, memberships] = await Promise.all([
    orgBySlug(slug),
    membershipsForUser(userId),
  ]);
  const membership = org ? memberships.find((m) => m.orgId === org.id) : undefined;
  if (!org || !membership) throw new NotFoundError();     // never distinguish these
  if (!can(membership.role, action)) throw new ForbiddenError(action, membership.role);
  return createOrgContext(org.id, membership.role);
}
```

`membershipsForUser` already filters `status: 'active'` and `org: { deletedAt: null }`; `orgBySlug` already filters `deletedAt: null`. Verify both rather than assuming.

- [ ] **Step 4: Brand `OrgContext` in `lib/data/tenant.ts`**

```ts
declare const orgContextBrand: unique symbol;
export type OrgContext = {
  readonly orgId: string; readonly role: OrgRole; readonly [orgContextBrand]: true;
};
/** Do not call this. Call requireOrgContext(). Restricted by ESLint and by a generated test. */
export function createOrgContext(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}
```

- [ ] **Step 5: Generate the importer restriction, do not write it**

```ts
// __tests__/integration/org-context.test.ts
it('is the only module that constructs an OrgContext', async () => {
  const { execSync } = await import('node:child_process');
  const hits = execSync(`grep -rl "createOrgContext" app lib --include=*.ts --include=*.tsx || true`)
    .toString().trim().split('\n').filter(Boolean).sort();
  expect(hits).toEqual(['lib/auth/context.ts', 'lib/data/tenant.ts']);
});
```

- [ ] **Step 6: Prove non-vacuity and commit**

Change `if (!org || !membership)` to `if (!org)`; confirm the cross-org test goes red; restore.

```bash
git add -A && git commit -m "feat(authz): requireOrgContext proves six facts; OrgContext is branded (D-089)"
```

---

## Task 6: URL restructure, `proxy.ts`, and the org switcher

**Files:** `proxy.ts`; every page moved from `app/(authenticated)/<x>` to `app/(authenticated)/orgs/[slug]/<x>`; `app/(authenticated)/layout.tsx`; `components/layout/Sidebar.tsx`; `app/page.tsx`.

**Interfaces:** Produces the route shape `/orgs/[slug]/{dashboard,projects,projects/[id],projects/[id]/compare,projects/new,assessment/[id],assessment/[id]/report,settings/members}`. `explore/*` and `change-password` stay **outside** org scope. `admin/*` stays outside (platform-level).

- [ ] **Step 1: Write the failing E2E test**

```ts
// e2e/org-routing.spec.ts
test('/ redirects to the remembered org dashboard', async ({ page }) => {
  await login(page, 'owner-a@test.local');
  await page.goto('/');
  await expect(page).toHaveURL(/\/orgs\/[a-z0-9-]+\/dashboard$/);
});

test('a member of A gets 404 on B by direct URL', async ({ page }) => {
  await login(page, 'owner-a@test.local');
  const res = await page.goto('/orgs/org-b/dashboard');
  expect(res?.status()).toBe(404);
});
```

- [ ] **Step 2: Move the pages**

```bash
mkdir -p "app/(authenticated)/orgs/[slug]"
git mv "app/(authenticated)/dashboard" "app/(authenticated)/orgs/[slug]/dashboard"
git mv "app/(authenticated)/projects"  "app/(authenticated)/orgs/[slug]/projects"
git mv "app/(authenticated)/assessment" "app/(authenticated)/orgs/[slug]/assessment"
```
`git mv` rather than delete-and-create, so the diff stays reviewable as a rename.

- [ ] **Step 2b: Re-point the ESLint allowlist at the new paths — or lint breaks**

Found by the pre-flight conflict scan, before any dispatch. `eslint.config.mjs`'s allowlist names the **old** paths (`app/(authenticated)/dashboard/page.tsx`, …). After the `git mv` those globs match nothing, the moved files fall back under the `lib/db` import ban — which they still violate until Task 7 — and `npm run lint` goes from 0 problems to one error per moved file, breaking Global Constraint 1.

Update each moved entry to its new path, **escaping the dynamic segment exactly as the existing entries do**:

```js
'app/(authenticated)/orgs/\\[slug\\]/dashboard/page.tsx',
'app/(authenticated)/orgs/\\[slug\\]/projects/page.tsx',
'app/(authenticated)/orgs/\\[slug\\]/projects/\\[id\\]/page.tsx',
'app/(authenticated)/orgs/\\[slug\\]/projects/\\[id\\]/compare/page.tsx',
```

The `\\[…\\]` escaping is load-bearing and not noise: `files` entries are globs, so an unescaped `[slug]` is a picomatch **character class** matching one character from `slug`, and never a directory literally named `[slug]`. Plan 1a verified this — with plain `[id]` the same entries silently missed and lint reported 8 errors. Round-trip parentheses are fine unescaped, as the existing entries demonstrate.

Verify with `npm run lint` before moving on: **0 problems, not "fewer problems."**

- [ ] **Step 3: Update `proxy.ts` — cheap checks only**

`proxy` typically runs on the edge runtime where Prisma cannot reach Postgres. Resolving authorization there would push toward trusting a JWT claim, reintroducing the staleness bypass ADR-0002 rejects. So: session-presence and unauthenticated redirects **only**. Membership resolution happens in the `/orgs/[slug]` layout and independently in every API route.

- [ ] **Step 4: Sidebar and layout**

`Sidebar.tsx` has **8 hardcoded `href`s**. Five become `/orgs/${slug}/…`; three (`explore/*`) stay global. `pathname.startsWith(item.href)` breaks once paths gain a prefix — compare against the resolved href. The admin section gates on **org role** via `can()`, not the platform role it uses today, and its `/admin/assessments` link is removed with that page. The layout gains the org switcher, which is a **navigation** to another slug, never a state mutation — that is what keeps tabs independent.

- [ ] **Step 5: `/` redirect**

`app/page.tsx` reads `lastActiveOrgId` **as a hint only**, resolves it to a slug, and redirects. If the user is not a member, the redirect target 404s via `requireOrgContext` — which is O-2. If there is no hint, render the org picker.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(routing): active org is a URL segment, not ambient state"
```

---

## Task 7: The port — every file, across all three lenses

**This is the task that turns `npm run verify` green.** It closes D-070, D-072 and D-074.

**Files:** the 22 ESLint-allowlisted files, the 8 URL-moving pages, the 7 shared components, `prisma/seed.ts`, and `app/(public)/**`. **Do not work from this prose list** — Step 1 generates the checklist.

- [ ] **Step 1: Generate the checklist from disk, do not write it**

```ts
// __tests__/integration/port-completeness.test.ts
it('every route declares an action in ROUTE_ACTIONS', async () => {
  const { execSync } = await import('node:child_process');
  const files = execSync(`find app/api -name route.ts`).toString().trim().split('\n');
  const undeclared = files.filter((f) => !isDeclared(f));
  expect(undeclared).toEqual([]);       // the failure message names the file
});

it('no file outside lib/data imports lib/db', async () => {
  const { execSync } = await import('node:child_process');
  const hits = execSync(
    `grep -rln "from '@/lib/db'\\|from '.*\\/db'" app lib components --include=*.ts --include=*.tsx || true`,
  ).toString().trim().split('\n').filter(Boolean).filter((f) => !f.startsWith('lib/data/'));
  expect(hits).toEqual([]);
});
```

A hand-written list that must be complete is a latent defect with a timestamp (D-103). These two tests *are* the checklist.

- [ ] **Step 2: Create `lib/authz/routeActions.ts`**

```ts
export const ROUTE_ACTIONS: Record<string, Partial<Record<'GET'|'POST'|'PATCH'|'DELETE', Action>>> = {
  'app/api/v1/orgs/[slug]/projects/route.ts':            { GET: 'project:read', POST: 'project:create' },
  'app/api/v1/orgs/[slug]/projects/[id]/route.ts':       { GET: 'project:read', PATCH: 'project:update', DELETE: 'project:delete' },
  'app/api/v1/orgs/[slug]/assessments/route.ts':         { GET: 'assessment:read', POST: 'assessment:create' },
  'app/api/v1/orgs/[slug]/assessments/[id]/route.ts':    { GET: 'assessment:read', PATCH: 'assessment:respond' },
  'app/api/v1/orgs/[slug]/assessments/[id]/complete/route.ts': { POST: 'assessment:complete' },
  'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts': { GET: 'assessment:read', PATCH: 'remediation:update' },
  'app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts':    { GET: 'assessment:read' },
  'app/api/v1/orgs/[slug]/members/route.ts':             { GET: 'member:read', POST: 'member:invite' },
  'app/api/v1/orgs/[slug]/members/[userId]/route.ts':    { PATCH: 'member:grant_owner', DELETE: 'member:remove' },
};
```

This map is the artifact the Task 11 matrix tests. If a handler consults a *different* action than the one declared here, observed behaviour diverges from expectation and the cell fails.

- [ ] **Step 3: Port one route as the reference pattern**

```ts
// app/api/v1/orgs/[slug]/projects/route.ts
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;                       // Next 16: params is a Promise
  try {
    const ctx = await requireOrgContext(slug, 'project:read');
    const projects = await withOrg(ctx, (tx) =>
      tx.project.findMany({ orderBy: { updatedAt: 'desc' } }));   // NO orgId filter — RLS does it
    return NextResponse.json({ projects });
  } catch (e) { return toResponse(e); }                // NotFound -> 404, Forbidden -> 403
}
```

**The absent line is the point.** There is no `where: { orgId: ctx.orgId }`. RLS filters under the GUC. The check you never wrote cannot be the check you forgot.

- [ ] **Step 4: Port the remaining routes and pages to that pattern**

Pages use the same two calls, then render. Client components' `fetch` targets gain `/api/v1/orgs/${slug}`. **`app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts`: fetch inside `withOrg`, close the transaction, then render** — holding a pooled connection during a CPU-bound render against `max: 10` with unpinned Prisma timeouts (D-065) is an unpleasant intermittent failure to diagnose later.

- [ ] **Step 5: Deletions and reductions**

```bash
git rm lib/authz.ts app/api/research/export/route.ts
git rm "app/(authenticated)/admin/assessments/page.tsx"
```
`admin/settings/page.tsx` keeps `user.count` and `assessment.count`; its `assessment.findMany` listing is removed (same reasoning as D-006). `users/me/export` returns **personal data only** — no assessments (O-17). `DELETE /users/me` becomes deactivate-and-scrub: refuse if last owner; drop memberships; `email = deleted-<userId>@invalid`; `name = 'Deleted user'`; overwrite `passwordHash` with random; `isActive = false`; bump `sessionEpoch`; delete consent records.

- [ ] **Step 5b: Write `lastActiveOrgId` — nothing in the plan does, so the `/` redirect is dead code**

Found by the Task 6 implementer and confirmed by grep: `lastActiveOrgId` is **read** by the `/`
dispatcher and **written nowhere in the entire plan**, so the "redirect to your remembered
organization" branch is unit-tested and unreachable in production. Every user lands on the org
picker forever.

Write it in the `/orgs/[slug]` layout, after `requireOrgContextFor` has already proven membership —
never before, and never from client input. It is a **hint for a redirect target and nothing else**
(D-069): the value it records has already been authorised this request, and the next request
re-authorises it from scratch regardless. Use `identityDb.user.update`, and do not block the render
on it.

- [ ] **Step 5c: Turn `e2e/org-routing.spec.ts`'s 500 assertion into the real 404**

Task 6 had to write `expect(res.status()).toBe(500)` because the deliberate `lib/auth-guard`
breakage made every authenticated route throw. Once this task lands, that route must return **404**
— the security property that a member of A cannot distinguish "org B does not exist" from "you are
not a member of org B". Until this flips, that property is proven only at unit level and never
end-to-end.

- [ ] **Step 6: `prisma/seed.ts`**

Seed through `bootstrapOrgWithOwner` so the seeded state is one the application can actually produce.

- [ ] **Step 7: Empty the ESLint allowlist**

Delete the entire override block from `eslint.config.mjs` — not entry by entry, the whole block (D-074).

- [ ] **Step 8: Verify**

```bash
npm run typecheck   # expect 0
npm run lint        # expect 0 problems
npm test
npm run verify      # expect green — first time since Plan 1a
```

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(port): every call site onto withOrg/identityDb; verify goes green (D-070, D-072, D-074)"
```

---

## Task 8: Invitations

**Files:** `lib/data/preauth.ts`, `app/api/v1/orgs/[slug]/members/route.ts`, `app/(public)/invitations/[token]/page.tsx`, `app/(authenticated)/orgs/[slug]/settings/members/page.tsx`, `__tests__/integration/invitations.test.ts`.

> **Already done in Task 2 — do not re-implement.** The `token` → `tokenHash` rename structurally broke `preauth.invitationByToken`, so Task 2 updated it to hash the caller's plaintext with sha256 before the lookup, using the same scheme specified below (D-110). Read `lib/data/preauth.ts` before writing `acceptInvitation`; hash identically, and do not change `invitationByToken`'s existing behaviour. This was a reach defect in the plan's own task boundaries — the rename and the hashing were assigned to different tasks and nothing checked that they composed.

**Interfaces:**
```ts
export function createInvitation(input: {
  ctx: OrgContext; email: string; role: OrgRole; invitedById: string;
}): Promise<{ rawToken: string; expiresAt: Date }>;      // rawToken returned ONCE, never stored

export function acceptInvitation(input: {
  rawToken: string; userId: string; userEmail: string;
}): Promise<{ orgId: string; role: OrgRole }>;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('stores only a digest — no stored value works as a token', async () => {          // O-7
  await createInvitation({ /* … */ });
  const rows = await testDb.invitation.findMany();
  for (const r of rows) expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
});

it('takes the role from the row, ignoring anything the caller supplies', async () => { // O-5
  const { rawToken } = await createInvitation({ /* role: 'viewer' */ });
  const r = await acceptInvitation({ rawToken, userId, userEmail });
  expect(r.role).toBe('viewer');
});

it('creates exactly one membership under concurrent acceptance', async () => {        // O-6
  const { rawToken } = await createInvitation({ /* … */ });
  const results = await Promise.allSettled([
    acceptInvitation({ rawToken, userId, userEmail }),
    acceptInvitation({ rawToken, userId, userEmail }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await testDb.membership.count({ where: { userId } })).toBe(1);
});

it('refuses a forwarded link for a different account', async () => {                  // D-098
  const { rawToken } = await createInvitation({ /* email: 'alice@uni.ac' */ });
  await expect(acceptInvitation({ rawToken, userId: bobId, userEmail: 'bob@evil.com' }))
    .rejects.toThrow(/invitation/i);
});

it('refuses an admin minting an owner invitation', async () => {
  await expect(createInvitation({ ctx: adminCtx, role: 'owner', /* … */ })).rejects.toThrow(ForbiddenError);
});
```

- [ ] **Step 2: Run to verify it fails, then implement**

The status transition **is** the gate — never a read followed by a write:

```ts
const hash = createHash('sha256').update(rawToken).digest('hex');
return ownerClient.$transaction(async (tx) => {
  const { count } = await tx.invitation.updateMany({
    where: { tokenHash: hash, status: 'pending', expiresAt: { gt: new Date() } },
    data: { status: 'accepted', acceptedAt: new Date() },
  });
  if (count === 0) throw new NotFoundError();          // used, expired, or never existed
  const inv = await tx.invitation.findUniqueOrThrow({ where: { tokenHash: hash } });
  if (inv.email.toLowerCase() !== input.userEmail.toLowerCase()) throw new NotFoundError();
  await tx.membership.create({ data: { orgId: inv.orgId, userId: input.userId, role: inv.role } });
  return { orgId: inv.orgId, role: inv.role };
});
```

Under `READ COMMITTED` the second transaction blocks on the row lock, re-evaluates its `WHERE` after the first commits, matches zero rows, and rejects. `expiresAt` is **7 days**.

- [ ] **Step 3: `member:leave` and `member:revoke_owner`, with the last-owner guard**

```ts
// O-14: an organization can never reach zero owners
const owners = await tx.membership.count({ where: { orgId, role: 'owner', status: 'active' } });
if (owners === 1 && membership.role === 'owner') throw new LastOwnerError();
```
This guard runs for **all four** paths: demote, remove, leave, and account deletion.

- [ ] **Step 4: Prove non-vacuity and commit**

Replace the conditional `updateMany` with a plain read; confirm the concurrency test goes red; restore.

```bash
git add -A && git commit -m "feat(members): hashed, email-bound, single-use invitations (D-097, D-098)"
```

---

## Task 9: Email

**Files:** `lib/email/send.ts`, `lib/email/templates.ts`, `.env.example`.

**Prerequisite:** a valid `RESEND_API_KEY`. **Supplied 2026-08-03 and verified — read the next step carefully, because the obvious check returns 401 on a perfectly good key.**

- [ ] **Step 1: Interpret the credential check correctly**

```bash
KEY=$(grep -m1 '^RESEND_API_KEY' .env | cut -d= -f2- | tr -d '"'"'"' ')
curl -s -w "\nhttp=%{http_code}\n" -H "Authorization: Bearer $KEY" https://api.resend.com/domains
```

| Response | Meaning | Action |
|---|---|---|
| `401` `{"name":"restricted_api_key"}` | **Valid, send-only key.** This is what the supplied key returns and it is the *correct* configuration — a key that can only send is the least-privilege choice | **Proceed.** Do not treat as failure |
| `400` `{"message":"API key is invalid"}` | Placeholder or malformed | Stop and ask |
| `200` | Full-access key | Proceed; you can also list domains |

Observed 2026-08-03: 36 characters, `re_` prefix, `401 restricted_api_key`. **Verified as working, not assumed.**

- [ ] **Step 2: Confirm the testing-sender rule — and note the key cannot answer it**

The spec assumes `onboarding@resend.dev` delivers without a verified domain, to the account holder's address only. **A send-only key cannot enumerate domains, so this cannot be answered programmatically.** Read Resend's documentation, or answer it empirically with one send in Step 5. **Verify rather than inherit** (AGENTS.md §5) — it determines Step 4.

- [ ] **Step 3: Implement the transport**

One export, no template logic. On failure it **throws** — an invitation that silently fails to send is a silent failure, and `pr-review-toolkit:silent-failure-hunter` is bound to exactly this moment (AGENTS.md §2).

- [ ] **Step 4: Both delivery paths, because they were never alternatives**

The invitation flow returns the one-time link to the inviter **and** sends the email. One real email proves the delivery path; the fixture's other 19 invitations use the copy-link (D-030). Nineteen invitations cannot be delivered to a sender that only reaches one mailbox.

- [ ] **Step 5: Send one real invitation and open it. Commit.**

```bash
git add -A && git commit -m "feat(email): live invitation delivery plus copy-link (D-022, D-030)"
```

---

## Task 10: The 20-user fixture

**Files:** `__tests__/helpers/fixture.ts`, `e2e/fixtures/auth.setup.ts`.

**Interfaces:**
```ts
export type FixtureUser = { userId: string; email: string; orgSlug: string; role: OrgRole; index: 0 | 1 };
export function buildTwoOrgFixture(): Promise<{
  orgs: [{ id: string; slug: string }, { id: string; slug: string }];
  users: FixtureUser[];        // exactly 20
}>;
```

- [ ] **Step 1: Build it**

Two organizations × five roles × **two members each**. Owners come from `bootstrapOrgWithOwner`; everyone else joins by invitation via the copy-link path, so the fixture exercises the real flow rather than inserting rows.

**Two members per role is the control condition, not extra coverage.** With one member per role, a surviving ownership check (`assessment.userId !== user.id`) passes silently because that member created the row they act on — role-based and creator-based access become indistinguishable. With two, member 1 creates and member 2 acts.

- [ ] **Step 2: Playwright `storageState`**

Authenticate each of the 20 once in `auth.setup.ts`; save session state; reuse across specs. Twenty logins per spec would make the exhaustive live matrix unusable.

- [ ] **Step 3: Measure the runtime and record it**

```bash
time npm run test:e2e
```
Record the number. The spec accepts the cost **and says it will be measured rather than estimated**.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test(fixture): 2 orgs x 5 roles x 2 members"
```

---

## Task 11: Exhaustive role × permission matrix (integration)

**Files:** `__tests__/integration/permission-matrix.test.ts`.

- [ ] **Step 1: Generate every cell — never write them**

```ts
for (const [file, methods] of Object.entries(ROUTE_ACTIONS)) {
  for (const [method, action] of Object.entries(methods)) {
    for (const user of fixture.users) {
      const sameOrg = user.orgSlug === targetOrg.slug;
      const expected = !sameOrg ? 404 : can(user.role, action) ? 200 : 403;
      it(`${method} ${file} as ${user.role}#${user.index} ${sameOrg ? 'in-org' : 'cross-org'} -> ${expected}`,
        async () => expect(await request(user, method, file)).toBe(expected));
    }
  }
}
```

20 users × 9 route files × both orgs. **Cross-org is 404 for every role including owner** — an owner of A must not learn that B exists.

- [ ] **Step 2: O-12 — the creator-versus-role control**

```ts
it('member 2 of a role gets the same answer as member 1 on member 1's resource', async () => {
  for (const role of ROLES) {
    const [m1, m2] = fixture.users.filter((u) => u.role === role && u.orgSlug === orgA.slug);
    const project = await createProjectAs(m1);
    expect(await request(m2, 'PATCH', projectRoute(project.id)))
      .toBe(can(role, 'project:update') ? 200 : 403);
  }
});
```
If any ownership residue survives the port, member 2 is denied where member 1 succeeded, and this goes red.

- [ ] **Step 3: Run, prove non-vacuity, commit**

Change one route to consult `assessment:update` instead of `assessment:complete`; confirm the affected cells go red; restore. **This is the test proving `can()` is wired to the routes** — the gap that `policy.test.ts` (a pure function test) and the three-persona IDOR matrix both left open.

```bash
git add -A && git commit -m "test(authz): every role x route cell, both orgs, plus the creator-vs-role control"
```

---

## Task 12: Exhaustive live verification

**Files:** `e2e/role-matrix.spec.ts`, `e2e/two-orgs.spec.ts`, `e2e/assessment-flow.spec.ts`.

- [ ] **Step 1: O-13 — per-role UI exposure**

Every role walks every screen in both orgs. A `viewer` must not be **shown** a "Delete project" control that 403s on click: that leaks capability information and is invisible to HTTP-level testing, which is precisely why this suite is exhaustive rather than representative.

- [ ] **Step 2: Two organizations, independently created**

Both created through the **real registration flow** by their own owner — **not** one org with two members. A member of A cannot reach B at any role, including owner. An invitation then moves a third person into A.

- [ ] **Step 3: A full assessment, end to end**

Created, answered, completed, report rendered, PDF downloaded — by a member with the role that permits it, inside an org.

- [ ] **Step 4: Run the gates in this message**

```bash
npm run verify && npm run test:e2e && npm run typecheck && git status --porcelain --untracked-files=all
```

- [ ] **Step 5: Review the register in full**

No `Open` row targeted at Phase 1b unless explicitly re-targeted with justification. Rows expected to close: D-006, D-007, D-022, D-030, D-045, D-048, D-069, D-070, D-072, D-074, D-078, D-080, D-089, D-097, D-098, D-100, D-101, D-102.

- [ ] **Step 6: Re-read AGENTS.md end to end (§0.3), then re-audit skill invocation mechanically**

Grep the ledger and branch commits for every skill in `docs/SKILLS_INVENTORY.md`; compare checkpoint-bound against unbound. **Also settle D-103's falsifiable test:** if the enumeration trigger fired and the second lens never produced a diff, or a completeness defect reached the human partner that the trigger should have caught, the mechanism is not working and must be *reconsidered rather than reworded*.

- [ ] **Step 7: `security-review` over the whole branch diff (C6), then commit**

```bash
git add -A && git commit -m "test(e2e): two orgs, every role, every screen — Plan 1b exit"
```

---

## Self-Review

**Spec coverage** — every §: 0 (scope) → Tasks 1–12; 1 (starting state) → context; 2 (corrections) → Task 1, 2, 7; 3.1 → Task 1; 3.2 → Task 3; 3.3 → Task 4; 3.4 → Task 5; 4.1/4.2/4.3 → Task 2; 5.1/5.2 → Tasks 6, 7; 5.3 → Task 7 Step 4; 5.4 → Task 7 Step 5; 5.5 → Task 7; 6/6.1 → Tasks 8, 9; 7 (O-1…O-18) → Tasks 5, 8, 11, 12; 8 (done) → Task 12; 9 (sequence) → task order; 10 (deferrals) → Task 12 Step 5.

**Obligation coverage — all 17, verified against the spec rather than recalled:** O-1 → T11; O-2 → T5; O-3/O-4 → T4; O-5/O-6/O-7 → T8; O-8 → T5; O-9 → T4; O-10 → T1; O-11/O-12 → T11; O-13 → T12; O-14 → T8 Step 3; O-15 → T5; O-16 → T8; O-17 → T7 Step 5.

*(An earlier draft of this plan referenced an "O-18". There is no O-18 — the spec defines O-1 through O-17. Caught by grepping the spec for obligation IDs instead of trusting the count I had written down two messages earlier, which is §5's "derived by you earlier and reused" hazard.)*

**Type consistency:** `OrgContext` is branded in `lib/data/tenant.ts` and consumed identically in Tasks 5, 7, 8, 11. `Identity` is defined once in Task 4. `ROUTE_ACTIONS` is defined in Task 7 and consumed in Task 11. `FixtureUser` is defined in Task 10 and consumed in Tasks 11–12.

**Ordering hazard, found and fixed rather than flagged:** `/orgs/new` needs `requireIdentity()` (Task 4) while Task 4's tests need `bootstrapOrgWithOwner` (Task 3). The first draft left `/orgs/new` in Task 3 with a note saying "lands in Task 4's commit if Task 3 runs first" — which is a placeholder wearing a caveat's clothes, and would have handed a subagent an un-runnable task. `/orgs/new` now lives in Task 4 Step 6, and both tasks are independently testable.
