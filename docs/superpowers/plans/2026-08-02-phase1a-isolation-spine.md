# Phase 1a — Isolation Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the multi-tenant isolation foundation — tenant schema, Postgres RLS, a mandatory scoped data-access layer, and the structural tests that make forgetting any of it a build failure.

**Architecture:** Shared Postgres database with a `NOT NULL orgId` on every tenant table. Per **ADR-0001**, responsibilities are separated rather than duplicated: composite same-org foreign keys make cross-tenant *references* unrepresentable; `withOrg` establishes tenant context and performs **no filtering**; **Postgres RLS is the authoritative tenant filter**; the app layer owns authorization only. RLS is kept non-decorative by six structural controls (FORCE, a non-bypassing role, a fail-closed policy, a DDL event trigger, the T1 test, and a lint ban) — not by re-filtering in application code.

**Execution order changed after Task 0:** policy → data layer → RLS → guards. The Task-0 spike returned NO-GO for the `$extends` wrapper and GO for `withOrg`; see `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`.

**Tech Stack:** Next.js 16.2.9, Prisma 7.8.0, PostgreSQL (docker `docker-postgres-1`), Vitest 4.1.9, TypeScript.

**Source spec:** `docs/superpowers/specs/2026-08-02-phase1-foundation-design.md`

## Global Constraints

- Every tenant table carries `orgId String` **NOT NULL**. No nullable tenant keys.
- `orgId` leads every composite index on tenant tables. Sole exception: `Membership` carries `@@index([userId])` because "which orgs am I in" is inherently cross-org.
- Routes never import `lib/db`. Tenant data goes through `withOrg` in `lib/data/tenant.ts`; non-tenant models (`User`, `ConsentRecord` — 17 of 50 call sites) go through `identityDb` in `lib/data/identity.ts`.
- **The application never re-filters by `orgId`.** A `where: { orgId }` in app code duplicates a filter RLS owns (ADR-0001). App code filters for *domain* reasons only.
- The org context GUC is set with `set_config('app.current_org_id', $1, true)` — **parameterised**, never string-interpolated into `SET LOCAL`.
- RLS policy comparison is exactly: `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. The `NULLIF` is mandatory.
- The app connects as a **non-owner, non-superuser** role. Every tenant table gets `FORCE ROW LEVEL SECURITY`.
- Authorization (role checks) lives in the app layer, never as JOINs inside RLS policies.
- Unauthorised access to an existing resource returns **404**, never 403 — do not leak existence.
- Every task ends with a commit. Follow existing commit style; end messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Exit condition:** Task 7 complete and green → write Plan 1b (org lifecycle & port).

**Decisions binding this plan:** ADR-0001 (data-access architecture), ADR-0002 (identity & linking policy).

---

## File Structure

| File | Responsibility |
|---|---|
| `spike/rls-prisma7/` | Task 0 only. Throwaway. Deleted in Task 0 Step 8. |
| `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md` | Permanent evidence of the spike's GO/NO-GO |
| `prisma/schema.prisma` | Modified — org tables, tenant `orgId`, composite FKs, indexes |
| `prisma/migrations/*/migration.sql` | Generated then hand-edited for RLS/roles |
| `__tests__/helpers/db.ts` | Integration-test harness: connect, truncate |
| `__tests__/integration/schema.test.ts` | Org/membership/invitation constraints |
| `__tests__/integration/isolation.test.ts` | T1, T2, T4 structural guards |
| `lib/authz/policy.ts` | `can(role, action)` — pure, no I/O |
| `__tests__/authz/policy.test.ts` | Matrix-generated RBAC coverage |
| `lib/data/tenant.ts` | `withOrg()` + `assertCan()` — the only path to tenant data |
| `lib/data/identity.ts` | `identityDb` — non-tenant models (`User`, `ConsentRecord`) |
| `__tests__/integration/tenant-layer.test.ts` | `withOrg` mechanism + role enforcement |
| `eslint.config.mjs` | Modified — ban `lib/db` imports outside `lib/data/` |

---

## Spec coverage — what this plan does NOT implement

Checked against the spec section by section. These are carried by Plan 1b, listed so the gap is deliberate rather than discovered later:

| Spec section | Deferred to Plan 1b |
|---|---|
| §2.5 | Zero-org-unreachable and never-zero-owners invariants — they live in registration and membership mutation logic |
| §3.5 | Narrowing `/admin/assessments` (D-006) and gating `/api/research/export` (D-007) |
| §4 | Registration transaction, invitations, email, `/orgs/[slug]` routing, `middleware`→`proxy`, org switcher |
| §5 | The gated port of engine / content / report / PDF, and the provisional-score marker |
| §6.3 | IDOR matrix over resource *routes*; session-staleness; invitation lifecycle tests |
| §6.4 | Live browser verification — the actual definition of done |

Everything else in the spec is implemented below.

---

## Task 0: RLS + Prisma 7 spike (decision gate — 5 working days max)

This task is **not** TDD. It is a throwaway investigation that produces a GO/NO-GO decision.

> **COMPLETED 2026-08-02.** Verdict: **NO-GO for `$extends`**, **GO for `withOrg`**. The code below is preserved as the historical record of what was probed; the mechanism it tests was falsified. Tasks 3–6 were subsequently rewritten around `withOrg` per ADR-0001. See `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`.

**Files:**
- Create: `spike/rls-prisma7/schema.prisma`, `spike/rls-prisma7/setup.sql`, `spike/rls-prisma7/probe.ts`
- Create: `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`

**Interfaces:**
- Consumes: nothing
- Produces: a documented GO/NO-GO. On GO, confirms the exact `set_config` + `$extends` mechanics that Tasks 3 and 6 rely on.

- [ ] **Step 1: Create an isolated spike database**

```bash
docker exec docker-postgres-1 psql -U makrai -d postgres -c "DROP DATABASE IF EXISTS makrai_spike;"
docker exec docker-postgres-1 psql -U makrai -d postgres -c "CREATE DATABASE makrai_spike;"
```

- [ ] **Step 2: Create the restricted role and an RLS-protected table**

Write `spike/rls-prisma7/setup.sql`:

```sql
-- Restricted app role: no superuser, no BYPASSRLS, not the table owner.
DROP ROLE IF EXISTS spike_app;
CREATE ROLE spike_app LOGIN PASSWORD 'spike_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

CREATE TABLE widgets (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  label  text NOT NULL
);

ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE widgets FORCE  ROW LEVEL SECURITY;

CREATE POLICY widgets_org_isolation ON widgets
  USING      (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON widgets TO spike_app;

-- Seed two tenants as the OWNER (owner bypass is what FORCE prevents for the app role).
INSERT INTO widgets (org_id, label) VALUES
  ('11111111-1111-1111-1111-111111111111', 'org-A widget'),
  ('22222222-2222-2222-2222-222222222222', 'org-B widget');
```

Apply it:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_spike < spike/rls-prisma7/setup.sql
```

- [ ] **Step 3: Write the probe script**

Write `spike/rls-prisma7/probe.ts`. It answers the three questions the spec requires:

```ts
import { PrismaClient } from '@prisma/client';

const APP_URL = 'postgresql://spike_app:spike_pw@localhost:5432/makrai_spike';
const ORG_A = '11111111-1111-1111-1111-111111111111';

// Corrected after execution: Prisma 7.8 has no datasourceUrl — it takes an adapter.
const base = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: APP_URL })),
});

// (a) Does $extends wrap EVERY operation in a transaction that sets the GUC?
function scoped(orgId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return base.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
            return query(args);
          });
        },
      },
    },
  });
}

async function main() {
  const results: Record<string, unknown> = {};

  // PROBE A — scoped client sees only its own org
  const db = scoped(ORG_A);
  const scopedRows = await db.widget.findMany();
  results.A_scoped_row_count = scopedRows.length;          // expect 1
  results.A_scoped_labels = scopedRows.map((r) => r.label); // expect ['org-A widget']

  // PROBE B — NULLIF fail-closed: no GUC set => 0 rows, NO error
  try {
    const bare = await base.widget.findMany();
    results.B_unscoped_row_count = bare.length;             // expect 0
    results.B_threw = false;
  } catch (e) {
    results.B_threw = true;
    results.B_error = (e as Error).message;                 // a throw here = FAIL
  }

  // PROBE C — cross-org write is refused by WITH CHECK
  try {
    await db.widget.create({
      data: { orgId: '22222222-2222-2222-2222-222222222222', label: 'smuggled' },
    });
    results.C_cross_org_write_allowed = true;               // true = FAIL
  } catch {
    results.C_cross_org_write_allowed = false;              // expect false
  }

  console.log(JSON.stringify(results, null, 2));
}

main().finally(() => base.$disconnect());
```

- [ ] **Step 4: Run the probe**

```bash
npx tsx spike/rls-prisma7/probe.ts
```

Expected for GO:
```
A_scoped_row_count: 1
A_scoped_labels: ["org-A widget"]
B_unscoped_row_count: 0
B_threw: false
C_cross_org_write_allowed: false
```

`B_threw: true` means the `NULLIF` guard is not behaving as expected — investigate before proceeding; it is the difference between failing closed and intermittent 500s.

- [ ] **Step 5: Probe connection pooling**

Run the probe twice concurrently against the same pool and confirm neither run sees the other's org:

```bash
npx tsx spike/rls-prisma7/probe.ts & npx tsx spike/rls-prisma7/probe.ts & wait
```

Expected: both print `A_scoped_row_count: 1`. Any run showing 2 means the GUC leaked across pooled connections — that is a **NO-GO** for the transaction-wrapping approach as written.

- [ ] **Step 6: Probe nested writes**

Add to `probe.ts` and re-run — nested creates must also be scoped:

```ts
  // PROBE D — nested write inside a transaction still carries the GUC
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ORG_A}, true)`;
      await tx.widget.create({ data: { orgId: ORG_A, label: 'nested-ok' } });
    });
    results.D_nested_write_ok = true;   // expect true
  } catch (e) {
    results.D_nested_write_ok = false;
    results.D_error = (e as Error).message;
  }
```

- [ ] **Step 7: Write the findings document**

Create `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md` with: the probe output verbatim, prisma/postgres versions (`npx prisma --version`, `docker exec docker-postgres-1 postgres --version`), a **GO** or **NO-GO** verdict, and — on NO-GO — which probe failed and why.

- [ ] **Step 8: Tear down the spike and commit the evidence**

```bash
docker exec docker-postgres-1 psql -U makrai -d postgres -c "DROP DATABASE makrai_spike;"
docker exec docker-postgres-1 psql -U makrai -d postgres -c "DROP ROLE IF EXISTS spike_app;"
rm -rf spike/
git add docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md
git commit -m "spike: de-risk Postgres RLS + Prisma 7 integration

Time-boxed decision gate per spec §3.3. Records GO/NO-GO with probe output.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Record the decision**

On **GO** — proceed to Task 1. On **NO-GO** or 5 days elapsed — update register row D-005 in `docs/DEFERRED_REGISTER.md` to `Scheduled` with the trigger and target, **skip Tasks 3 and 4**, and proceed to Task 1 with the scoped data layer as the sole runtime guard. Commit the register change.

---

## Task 1: Integration-test harness + organization tables

**Files:**
- Create: `__tests__/helpers/db.ts`, `__tests__/integration/schema.test.ts`
- Modify: `prisma/schema.prisma`, `vitest.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `testDb: PrismaClient`, `resetDb(): Promise<void>` from `__tests__/helpers/db.ts`. Prisma models `Organization`, `Membership`, `Invitation`; enums `OrgRole` (`owner|admin|assessor|reviewer|viewer`), `MembershipStatus` (`active|suspended`), `InvitationStatus` (`pending|accepted|expired|revoked`).

- [ ] **Step 1: Create the test database**

```bash
docker exec docker-postgres-1 psql -U makrai -d postgres -c "CREATE DATABASE makrai_test;"
```

No `.env.test` file and no `dotenv` — `dotenv` is not a dependency of this project, and adding one for test config is unnecessary. Test connection strings are set in `vitest.config.ts` (Step 3) with environment-variable overrides.

- [ ] **Step 2: Write the test harness**

Create `__tests__/helpers/db.ts`:

Prisma 7.8 has **no `datasourceUrl` option** — `PrismaClient` takes an `adapter`. Mirror the pattern already used in `lib/db.ts` (`@prisma/adapter-pg@^7.8.0` and `pg@^8.22.0` are existing dependencies):

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/** Truncate every table except Prisma's migration ledger. */
export async function resetDb(): Promise<void> {
  const rows = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 3: Point vitest at the test database**

Modify `vitest.config.ts` — add to the `test` block. Values fall back to the local docker database so a fresh clone works with no setup, and CI can override:

```ts
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://makrai:makrai@localhost:5432/makrai_test',
      // Populated in Task 3; harmless until then.
      APP_DATABASE_URL:
        process.env.TEST_APP_DATABASE_URL ??
        'postgresql://makrai_app:app_dev_password@localhost:5432/makrai_test',
    },
```

- [ ] **Step 4: Write the failing test**

Create `__tests__/integration/schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

describe('organization schema', () => {
  beforeEach(resetDb);

  it('creates an org with an owner membership', async () => {
    const user = await testDb.user.create({
      data: { email: 'a@example.org', name: 'A', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'Makerere AI Lab', slug: 'makerere-ai-lab' },
    });
    const m = await testDb.membership.create({
      data: { orgId: org.id, userId: user.id, role: 'owner' },
    });
    expect(m.role).toBe('owner');
    expect(m.status).toBe('active');
  });

  it('rejects a duplicate membership for the same user and org', async () => {
    const user = await testDb.user.create({
      data: { email: 'b@example.org', name: 'B', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'Org B', slug: 'org-b' },
    });
    await testDb.membership.create({
      data: { orgId: org.id, userId: user.id, role: 'admin' },
    });
    await expect(
      testDb.membership.create({
        data: { orgId: org.id, userId: user.id, role: 'viewer' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate org slug', async () => {
    await testDb.organization.create({ data: { name: 'One', slug: 'dup' } });
    await expect(
      testDb.organization.create({ data: { name: 'Two', slug: 'dup' } }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `npx vitest run __tests__/integration/schema.test.ts`
Expected: FAIL — `testDb.organization` is undefined (model does not exist yet).

- [ ] **Step 6: Add the models**

Modify `prisma/schema.prisma` — add enums and models:

```prisma
enum OrgRole {
  owner
  admin
  assessor
  reviewer
  viewer
}

enum MembershipStatus {
  active
  suspended
}

enum InvitationStatus {
  pending
  accepted
  expired
  revoked
}

model Organization {
  id        String    @id @default(uuid())
  name      String
  slug      String    @unique
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?

  memberships Membership[]
  invitations Invitation[]
  // NOTE: `projects Project[]` is deliberately NOT declared here. Prisma requires
  // both sides of a relation to exist, and Project does not gain its `org`
  // back-reference until Task 2. Declaring it now fails `prisma validate`.

  @@map("organizations")
}

model Membership {
  id        String           @id @default(uuid())
  orgId     String
  userId    String
  role      OrgRole
  status    MembershipStatus @default(active)
  createdAt DateTime         @default(now())

  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId])
  @@index([userId])
  @@map("memberships")
}

model Invitation {
  id          String           @id @default(uuid())
  orgId       String
  email       String
  role        OrgRole
  tokenHash   String           @unique
  expiresAt   DateTime
  status      InvitationStatus @default(pending)
  invitedById String
  acceptedAt  DateTime?
  createdAt   DateTime         @default(now())

  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@index([orgId, status])
  @@map("invitations")
}
```

Add to `model User`:

```prisma
  memberships     Membership[]
  lastActiveOrgId String?
```

- [ ] **Step 7: Generate the migration and apply it to both databases**

```bash
npx prisma migrate dev --name add_organizations_memberships_invitations
DATABASE_URL="postgresql://makrai:makrai@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 8: Run the tests to confirm they pass**

Run: `npx vitest run __tests__/integration/schema.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Commit**

```bash
git add prisma/ __tests__/ vitest.config.ts .gitignore
git commit -m "feat(tenancy): add Organization, Membership, Invitation

Integration-test harness against a dedicated makrai_test database.
Membership carries @@index([userId]) deliberately — 'which orgs am I in'
is inherently cross-org and runs on every session.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Port tenant tables to NOT NULL orgId

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/*/migration.sql` (hand-edited for the backfill)
- Create: `__tests__/integration/tenant-schema.test.ts`

**Interfaces:**
- Consumes: `Organization`, `Membership` from Task 1
- Produces: `Project`, `ProjectMetadata`, `Assessment`, `RemediationItem` each with `orgId String` NOT NULL and `@@unique([orgId, id])` on `Project` and `Assessment`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/tenant-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function seedOrg(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@example.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  await testDb.membership.create({
    data: { orgId: org.id, userId: user.id, role: 'owner' },
  });
  return { org, user };
}

describe('tenant tables', () => {
  beforeEach(resetDb);

  it('requires orgId on a project', async () => {
    const { user } = await seedOrg('org-a');
    await expect(
      // @ts-expect-error orgId is required
      testDb.project.create({ data: { name: 'P', createdById: user.id } }),
    ).rejects.toThrow();
  });

  it('refuses an assessment pointing at another org\'s project', async () => {
    const a = await seedOrg('org-a');
    const b = await seedOrg('org-b');
    const projectA = await testDb.project.create({
      data: { orgId: a.org.id, name: 'A project', createdById: a.user.id },
    });
    await expect(
      testDb.assessment.create({
        data: {
          orgId: b.org.id,             // org B ...
          projectId: projectA.id,      // ... pointing at org A's project
          userId: b.user.id,
          engineState: {},
        },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run __tests__/integration/tenant-schema.test.ts`
Expected: FAIL — the cross-org assessment is currently *accepted*, because `orgId` is nullable and no composite FK exists.

- [ ] **Step 3: Update the schema**

Modify `prisma/schema.prisma`.

First, add the inverse relation field to `Organization` — this is the other half of the relation Task 1 deliberately left undeclared:

```prisma
  projects Project[]
```

On `Project` — replace `orgId String?` with `orgId String`, add the relation and constraints:

```prisma
  org Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@unique([orgId, id])
  @@index([orgId, createdAt])
  @@index([orgId, createdById])
```

On `Assessment` — replace `orgId String?` with `orgId String`, and replace the plain project relation with the composite one:

```prisma
  project Project @relation(fields: [orgId, projectId], references: [orgId, id], onDelete: Cascade)

  @@unique([orgId, id])
  @@index([orgId, projectId])
  @@index([orgId, status])
  @@index([orgId, userId])
```

On `ProjectMetadata` — add `orgId String` and switch to the composite relation:

```prisma
  orgId   String
  project Project @relation(fields: [orgId, projectId], references: [orgId, id], onDelete: Cascade)
```

On `RemediationItem` — add `orgId String` and switch to the composite relation:

```prisma
  orgId      String
  assessment Assessment @relation(fields: [orgId, assessmentId], references: [orgId, id], onDelete: Cascade)

  @@index([orgId, assessmentId])
```

Remove the now-redundant `@@index([orgId])` entries.

- [ ] **Step 4: Create the migration without applying it**

```bash
npx prisma migrate dev --create-only --name port_tenant_tables_to_org_id
```

- [ ] **Step 5: Hand-edit the migration to backfill before constraining**

Open the generated `migration.sql` and insert this **before** any `SET NOT NULL` statement. One org per existing user preserves today's visibility boundary; a shared "legacy" org would let every existing user read every other's data.

```sql
-- Backfill: one organization per existing user, that user as owner.
INSERT INTO "organizations" ("id", "name", "slug", "createdAt", "updatedAt")
SELECT gen_random_uuid(),
       u."name" || '''s Organization',
       'org-' || substr(md5(u."id"), 1, 12),
       now(), now()
FROM "users" u;

INSERT INTO "memberships" ("id", "orgId", "userId", "role", "status", "createdAt")
SELECT gen_random_uuid(), o."id", u."id", 'owner', 'active', now()
FROM "users" u
JOIN "organizations" o ON o."slug" = 'org-' || substr(md5(u."id"), 1, 12);

-- Point existing rows at their creator's org.
UPDATE "projects" p
SET "orgId" = m."orgId"
FROM "memberships" m
WHERE m."userId" = p."createdById" AND p."orgId" IS NULL;

UPDATE "assessments" a
SET "orgId" = p."orgId"
FROM "projects" p
WHERE p."id" = a."projectId";

UPDATE "project_metadata" pm
SET "orgId" = p."orgId"
FROM "projects" p
WHERE p."id" = pm."projectId";

UPDATE "remediation_items" ri
SET "orgId" = a."orgId"
FROM "assessments" a
WHERE a."id" = ri."assessmentId";

-- Any row whose creator no longer exists cannot be assigned an owner; drop it.
DELETE FROM "projects" WHERE "orgId" IS NULL;
```

- [ ] **Step 6: Apply the migration to both databases**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai@localhost:5432/makrai_test" npx prisma migrate deploy
npx prisma generate
```

- [ ] **Step 7: Run the tests to confirm they pass**

Run: `npx vitest run __tests__/integration/tenant-schema.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Confirm the full suite still passes**

Run: `npx vitest run`
Expected: PASS — 83 pre-existing engine tests plus the new integration tests.

- [ ] **Step 9: Commit**

```bash
git add prisma/ __tests__/
git commit -m "feat(tenancy): NOT NULL orgId + composite same-org foreign keys

Cross-tenant references are now structurally unrepresentable: an assessment
referencing another org's project fails at the constraint, independent of
application correctness or RLS configuration.

Backfill creates one org per existing user, preserving today's visibility
boundary — a shared legacy org would have been an access-control change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: RBAC policy module

*(Was Task 5. Reordered per ADR-0001: policy → data layer → RLS → guards. Content unchanged.)*

**Files:**
- Create: `lib/authz/policy.ts`, `__tests__/authz/policy.test.ts`

**Interfaces:**
- Consumes: `OrgRole` from Task 1
- Produces: `type Action`, `can(role: OrgRole, action: Action): boolean`, `ACTIONS`, `ROLES`.

Implement exactly as specified in the "RBAC policy module" section retained below at Task 3a.

- [ ] **Step 1: Write the failing test** — `__tests__/authz/policy.test.ts`, matrix-as-fixture (see Task 3a code block).
- [ ] **Step 2: Run to confirm it fails.** `npx vitest run __tests__/authz/policy.test.ts` → cannot resolve module.
- [ ] **Step 3: Implement `lib/authz/policy.ts`** (see Task 3a code block).
- [ ] **Step 4: Run to confirm pass** (4 tests).
- [ ] **Step 5: Commit** `feat(authz): can(role, action) policy module with matrix-generated tests`.

### Task 3a — reference code

```ts
// lib/authz/policy.ts
import type { OrgRole } from '@prisma/client';

/** Role order is load-bearing: the test matrix indexes into it. */
export const ROLES = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const;

export const ACTIONS = [
  'org:read', 'org:update', 'org:delete',
  'member:list', 'member:invite', 'member:remove', 'member:grant_owner',
  'project:create', 'project:read', 'project:update', 'project:delete',
  'assessment:create', 'assessment:read', 'assessment:respond',
  'assessment:complete', 'assessment:delete',
  'remediation:update',
] as const;

export type Action = (typeof ACTIONS)[number];

const READ_ALL: Action[] = ['org:read', 'member:list', 'project:read', 'assessment:read'];
const WRITE: Action[] = ['project:create', 'project:update', 'assessment:create',
  'assessment:respond', 'assessment:complete', 'remediation:update'];
const MANAGE: Action[] = ['org:update', 'member:invite', 'member:remove',
  'project:delete', 'assessment:delete'];
const OWNER_ONLY: Action[] = ['org:delete', 'member:grant_owner'];

const GRANTS: Record<OrgRole, Action[]> = {
  owner:    [...READ_ALL, ...WRITE, ...MANAGE, ...OWNER_ONLY],
  admin:    [...READ_ALL, ...WRITE, ...MANAGE],
  assessor: [...READ_ALL, ...WRITE],
  reviewer: [...READ_ALL],   // inert until the review spec lands (register D-004)
  viewer:   [...READ_ALL],
};

/** Pure: no I/O. RLS does isolation; this does authorization. (ADR-0001) */
export function can(role: OrgRole, action: Action): boolean {
  return GRANTS[role].includes(action);
}
```

The test asserts every (role x action) cell against this matrix, so adding an action without
deciding all five roles fails the build:

```
//                                        owner admin assessor reviewer viewer
'org:read':'xxxxx'  'member:list':'xxxxx'  'project:read':'xxxxx'  'assessment:read':'xxxxx'
'org:update':'xx...'  'member:invite':'xx...'  'member:remove':'xx...'
'project:delete':'xx...'  'assessment:delete':'xx...'
'org:delete':'x....'  'member:grant_owner':'x....'
'project:create':'xxx..'  'project:update':'xxx..'  'assessment:create':'xxx..'
'assessment:respond':'xxx..'  'assessment:complete':'xxx..'  'remediation:update':'xxx..'
```

---

## Task 4: Data-access layer — `withOrg`, restricted role, identity path

*(Was Task 6, rewritten per ADR-0001 and the Task-0b spike.)*

**Files:**
- Create: `lib/data/tenant.ts`, `lib/data/identity.ts`, `__tests__/integration/tenant-layer.test.ts`
- Create: `prisma/migrations/*/migration.sql` (app role + grants only — no RLS yet)
- Modify: `.env`, `vitest.config.ts`, `eslint.config.mjs`

**Interfaces:**
- Consumes: `can`/`Action` from Task 3
- Produces: `type OrgContext = { orgId: string; role: OrgRole }`, `withOrg<T>(ctx, cb): Promise<T>`,
  `assertCan(ctx, action): void`, `ForbiddenError`, and `identityDb` (unscoped client for
  non-tenant models) from `lib/data/`.

**ADR-0001 constraints binding this task:**
- `withOrg` sets the org GUC and **does no filtering**. It must NOT inject `where: { orgId }`.
  RLS is the authoritative tenant filter; duplicating it is a layering violation.
- `requireOrgContext(slug, action)` is **out of scope here** — it needs a session, which the
  auth rewrite in Plan 1b provides. Task 4 delivers the `OrgContext` type and `assertCan` only.
- 17 of 50 existing call sites are non-tenant (`User`, `ConsentRecord`) and cannot use
  `withOrg` — login reads `User` before any org context exists. Hence `identityDb`.

- [ ] **Step 1: Create the restricted app role (migration)**

```bash
npx prisma migrate dev --create-only --name add_restricted_app_role
```

Replace the generated `migration.sql` with:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_app') THEN
    CREATE ROLE makrai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE makrai_app WITH PASSWORD 'app_dev_password';

GRANT USAGE ON SCHEMA public TO makrai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makrai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makrai_app;
```

Apply to both databases:

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai@localhost:5432/makrai_test" npx prisma migrate deploy
```

Append to `.env`:

```
APP_DATABASE_URL="postgresql://makrai_app:app_dev_password@localhost:5432/makrai"
```

Verify the role cannot bypass RLS:

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai -Atc \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='makrai_app';"
```

Expected: `makrai_app|f|f`

- [ ] **Step 2: Write the failing test**

RLS does not exist yet, so this tests the **mechanism**, not isolation. Isolation is proven in
Task 6 once policies are in place. Create `__tests__/integration/tenant-layer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { withOrg, assertCan, ForbiddenError } from '../../lib/data/tenant';

const ORG = '11111111-1111-1111-1111-111111111111';

describe('withOrg mechanism', () => {
  it('sets app.current_org_id inside the callback', async () => {
    const seen = await withOrg({ orgId: ORG, role: 'admin' }, async (tx) => {
      const rows = await tx.$queryRaw<{ v: string }[]>`
        SELECT current_setting('app.current_org_id', true) AS v`;
      return rows[0].v;
    });
    expect(seen).toBe(ORG);
  });

  it('does not leak the setting outside the transaction', async () => {
    await withOrg({ orgId: ORG, role: 'admin' }, async (tx) => {
      await tx.$queryRaw`SELECT 1`;
    });
    const { identityDb } = await import('../../lib/data/identity');
    const rows = await identityDb.$queryRaw<{ v: string | null }[]>`
      SELECT current_setting('app.current_org_id', true) AS v`;
    expect(rows[0].v === null || rows[0].v === '').toBe(true);
  });
});

describe('assertCan', () => {
  it('refuses an action the role lacks', () => {
    expect(() => assertCan({ orgId: ORG, role: 'viewer' }, 'project:create'))
      .toThrow(ForbiddenError);
  });
  it('permits an action the role has', () => {
    expect(() => assertCan({ orgId: ORG, role: 'assessor' }, 'project:create'))
      .not.toThrow();
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `npx vitest run __tests__/integration/tenant-layer.test.ts`
Expected: FAIL — cannot resolve `lib/data/tenant`.

- [ ] **Step 4: Implement the tenant layer**

Create `lib/data/tenant.ts`:

```ts
import { PrismaClient, type OrgRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { can, type Action } from '../authz/policy';

export type OrgContext = { orgId: string; role: OrgRole };

export class ForbiddenError extends Error {
  constructor(action: Action, role: OrgRole) {
    super(`role ${role} may not ${action}`);
    this.name = 'ForbiddenError';
  }
}

/** Authorization. Isolation is RLS's job — see ADR-0001. */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/**
 * Connects as makrai_app, which is NOBYPASSRLS — so a query that escapes the
 * org context returns nothing rather than another tenant's rows.
 */
const appClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.APP_DATABASE_URL })),
});

/**
 * The ONLY path to tenant data.
 *
 * Opens one interactive transaction, sets the org GUC that RLS policies read,
 * and hands the caller the transaction handle. It deliberately performs NO
 * filtering: RLS is the authoritative tenant filter (ADR-0001).
 *
 * set_config(..., true) is transaction-local AND parameterised. Never
 * interpolate an org id into a `SET LOCAL` string.
 */
export function withOrg<T>(
  ctx: OrgContext,
  cb: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return appClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
    return cb(tx);
  });
}
```

Create `lib/data/identity.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * Non-tenant data only: User and ConsentRecord.
 *
 * These have no orgId and no org context — login reads User before any
 * organization is known. 17 of 50 call sites are in this category, which is
 * why a single universal wrapper cannot serve the app (ADR-0001).
 *
 * Do NOT reach tenant models through this client. Use withOrg().
 */
export const identityDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});
```

- [ ] **Step 5: Run to confirm pass** — `npx vitest run __tests__/integration/tenant-layer.test.ts` (4 tests).

- [ ] **Step 6: Add the bypass ban (T3)**

Append to the exported config array in `eslint.config.mjs`:

```js
  {
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/lib/db', '@/lib/db'],
          message:
            'Routes must not use the unscoped Prisma client. Use withOrg() from lib/data/tenant, or identityDb from lib/data/identity for non-tenant models.',
        }],
      }],
    },
  },
```

- [ ] **Step 7: Verify the ban is live**

```bash
printf "import { prisma } from '@/lib/db';\nexport const x = prisma;\n" > app/__banprobe.ts
npx eslint app/__banprobe.ts
```

Expected: **error**. Then `rm app/__banprobe.ts`.

- [ ] **Step 8: Commit**

```bash
git add lib/data/ __tests__/integration/tenant-layer.test.ts eslint.config.mjs prisma/ .env.example 2>/dev/null
git commit -m "feat(tenancy): withOrg data layer, restricted app role, identity path

Implements ADR-0001. withOrg opens one interactive transaction, sets
app.current_org_id via parameterised set_config, and does NO filtering --
RLS is the authoritative tenant filter and duplicating it in application
code would be a layering violation.

identityDb is a deliberately separate path for User and ConsentRecord: 17 of
50 call sites are non-tenant and login reads User before any org exists.

Mechanism is tested here; isolation is proven in Task 6 once policies land.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: RLS policies, FORCE, and the event trigger

*(Was Task 3, rewritten. Now lands AFTER the data layer, per the ordering ruling.)*

**Files:**
- Create: `prisma/migrations/*/migration.sql` (SQL-only)

**Interfaces:**
- Consumes: tenant tables (Task 2), app role (Task 4)
- Produces: RLS enabled + forced on all tenant tables; an event trigger that makes shipping an
  unprotected tenant table structurally impossible.

- [ ] **Step 1: Create an empty migration**

```bash
npx prisma migrate dev --create-only --name enable_rls_and_guard_trigger
```

- [ ] **Step 2: Write the RLS migration**

```sql
ALTER TABLE "projects"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "assessments"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessments"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" FORCE  ROW LEVEL SECURITY;

-- NULLIF is mandatory: after a SET LOCAL transaction the GUC retains an empty
-- string, and a bare ''::uuid cast ERRORS (intermittent 500s) instead of
-- failing closed. With NULLIF it yields NULL -> zero rows, cleanly.
CREATE POLICY org_isolation ON "projects"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY org_isolation ON "project_metadata"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY org_isolation ON "assessments"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

CREATE POLICY org_isolation ON "remediation_items"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);
```

- [ ] **Step 3: Add the event trigger (ADR-0001 control #4)**

Append to the same migration. This is the strongest of the six controls: it makes "someone
added a tenant table and forgot the policy" impossible rather than merely tested.

```sql
CREATE OR REPLACE FUNCTION enforce_rls_on_tenant_tables()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
  has_org_id boolean;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public'
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = split_part(obj.object_identity, '.', 2)
        AND column_name = 'orgId'
    ) INTO has_org_id;

    IF has_org_id THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',  obj.object_identity);
      RAISE NOTICE 'RLS auto-enabled on tenant table %', obj.object_identity;
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS trg_enforce_rls_on_tenant_tables;
CREATE EVENT TRIGGER trg_enforce_rls_on_tenant_tables
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION enforce_rls_on_tenant_tables();
```

Note the documented limit: this binds tables created **after** installation. Existing tables
are handled explicitly above, and Task 6's T1 test is the backstop.

- [ ] **Step 4: Apply to both databases**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 5: Prove the event trigger fires**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c \
  'CREATE TABLE "trigger_probe" (id uuid PRIMARY KEY, "orgId" uuid NOT NULL);'
docker exec docker-postgres-1 psql -U makrai -d makrai_test -Atc \
  "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='trigger_probe';"
```

Expected: `t|t` — RLS was enabled automatically, with no migration written for it.

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c 'DROP TABLE "trigger_probe";'
```

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(tenancy): RLS policies, FORCE, and a DDL event trigger

FORCE ROW LEVEL SECURITY closes the table-owner bypass -- without it RLS is
decorative. The policy uses NULLIF so an unset GUC yields zero rows rather
than a cast error.

The event trigger auto-enables RLS on any new public table carrying an orgId
column, making a forgotten policy structurally impossible rather than merely
tested (ADR-0001 control 4). Verified live against a probe table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Structural guard tests (T1, T2, T4) and isolation proof

*(Was Task 4, extended: now also proves end-to-end isolation through `withOrg`.)*

**Files:**
- Create: `__tests__/integration/isolation.test.ts`

- [ ] **Step 1: Write the tests**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { withOrg } from '../../lib/data/tenant';

async function seed(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  return { org, user, project };
}

describe('T1 — every tenant table has RLS enabled AND forced', () => {
  it('fails if any table with an orgId column is unprotected', async () => {
    const unprotected = await testDb.$queryRaw<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname AND col.table_schema = 'public'
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND col.column_name = 'orgId'
        AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)
      GROUP BY c.relname`;
    expect(unprotected).toEqual([]);
  });
});

describe('T2 — RLS fails closed', () => {
  beforeEach(resetDb);
  it('returns zero rows and does not throw with no org context', async () => {
    const { identityDb } = await import('../../lib/data/identity');
    const a = await seed('t2-a');
    expect(a.project.id).toBeTruthy();
    // identityDb connects as the owner; use the app client with no withOrg wrapper.
    const { PrismaClient } = await import('@prisma/client');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { Pool } = await import('pg');
    const bare = new PrismaClient({
      adapter: new PrismaPg(new Pool({ connectionString: process.env.APP_DATABASE_URL })),
    });
    const rows = await bare.project.findMany();
    expect(rows).toEqual([]);
    await bare.$disconnect();
  });
});

describe('isolation through withOrg (end-to-end)', () => {
  beforeEach(resetDb);

  it('sees only the active org', async () => {
    const a = await seed('iso-a');
    await seed('iso-b');
    const rows = await withOrg({ orgId: a.org.id, role: 'admin' },
      (tx) => tx.project.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('iso-a project');
  });

  it('cannot read another org even by id', async () => {
    const a = await seed('iso-c');
    const b = await seed('iso-d');
    const found = await withOrg({ orgId: a.org.id, role: 'admin' },
      (tx) => tx.project.findUnique({ where: { id: b.project.id } }));
    expect(found).toBeNull();
  });

  it('refuses a cross-org write (WITH CHECK)', async () => {
    const a = await seed('iso-e');
    const b = await seed('iso-f');
    await expect(
      withOrg({ orgId: a.org.id, role: 'admin' }, (tx) =>
        tx.project.create({
          data: { orgId: b.org.id, name: 'smuggled', createdById: a.user.id },
        })),
    ).rejects.toThrow();
  });
});

describe('T4 — composite same-org FK blocks cross-tenant references', () => {
  beforeEach(resetDb);
  it('refuses remediation attached to another org assessment', async () => {
    const a = await seed('t4-a');
    const b = await seed('t4-b');
    const asmt = await testDb.assessment.create({
      data: { orgId: a.org.id, projectId: a.project.id, userId: a.user.id, engineState: {} },
    });
    await expect(
      testDb.remediationItem.create({
        data: {
          orgId: b.org.id, assessmentId: asmt.id, areaId: 'PO-03',
          areaName: 'Accountability Gap', tier: 'gap', description: 'cross-tenant',
        },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect all PASS.** `npx vitest run __tests__/integration/isolation.test.ts`

- [ ] **Step 3: Prove T1 is non-vacuous**

The event trigger now auto-protects new tables, so bypass it deliberately to confirm T1 still
detects an unprotected table:

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c \
  'CREATE TABLE "leaky" (id uuid PRIMARY KEY, "orgId" uuid NOT NULL);
   ALTER TABLE "leaky" NO FORCE ROW LEVEL SECURITY;
   ALTER TABLE "leaky" DISABLE ROW LEVEL SECURITY;'
npx vitest run __tests__/integration/isolation.test.ts
```

Expected: **T1 FAILS**, listing `leaky`.

- [ ] **Step 4: Clean up and re-run**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c 'DROP TABLE "leaky";'
npx vitest run
```

Expected: full suite green (83 engine tests + integration).

- [ ] **Step 5: Commit** `test(tenancy): structural guards T1/T2/T4 + end-to-end isolation proof`

---

## Task 7: Close the register rows this plan discharges

**Files:**
- Modify: `docs/DEFERRED_REGISTER.md`

- [ ] **Step 1: Update rows and the closure log**

Set D-005 to `Closed-done` on GO (or `Scheduled` on NO-GO, with its new trigger and target). Add closure-log entries citing the commit SHAs from Tasks 3, 4 and 6, stating exactly what was verified — and note plainly that verification so far is **integration-level, not live in a browser**; AGENTS.md rule 2 is satisfied only by Plan 1b's E2E task.

- [ ] **Step 2: Commit**

```bash
git add docs/DEFERRED_REGISTER.md
git commit -m "docs(register): close D-005 after the RLS spike and spine build

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Definition of done for Plan 1a

- `npx vitest run` green, including T1/T2/T4 and the RBAC matrix.
- T1 demonstrated non-vacuous (Task 4 Step 3 went red against a probe table).
- ESLint bypass ban demonstrated live (Task 6 Step 6 errored).
- `npx tsc --noEmit` clean.
- **Not yet done:** nothing here has been driven through a browser. Isolation is proven at the database and data-layer level only. Plan 1b carries the live-verification bar.
