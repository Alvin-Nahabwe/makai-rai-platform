# Phase 1a — Isolation Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the multi-tenant isolation foundation — tenant schema, Postgres RLS, a mandatory scoped data-access layer, and the structural tests that make forgetting any of it a build failure.

**Architecture:** Shared Postgres database with a `NOT NULL orgId` on every tenant table. Three isolation layers with uncorrelated failure modes: composite same-org foreign keys (cannot fail at runtime), a scoped data-access layer (fails by omission), and Postgres RLS (fails by misconfiguration). Task 0 is a time-boxed decision gate that de-risks the Prisma-7/RLS integration before anything is built on it.

**Tech Stack:** Next.js 16.2.9, Prisma 7.8.0, PostgreSQL (docker `docker-postgres-1`), Vitest 4.1.9, TypeScript.

**Source spec:** `docs/superpowers/specs/2026-08-02-phase1-foundation-design.md`

## Global Constraints

- Every tenant table carries `orgId String` **NOT NULL**. No nullable tenant keys.
- `orgId` leads every composite index on tenant tables. Sole exception: `Membership` carries `@@index([userId])` because "which orgs am I in" is inherently cross-org.
- Routes never import `lib/db`. All tenant data access goes through `lib/data/`.
- The org context GUC is set with `set_config('app.current_org_id', $1, true)` — **parameterised**, never string-interpolated into `SET LOCAL`.
- RLS policy comparison is exactly: `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`. The `NULLIF` is mandatory.
- The app connects as a **non-owner, non-superuser** role. Every tenant table gets `FORCE ROW LEVEL SECURITY`.
- Authorization (role checks) lives in the app layer, never as JOINs inside RLS policies.
- Unauthorised access to an existing resource returns **404**, never 403 — do not leak existence.
- Every task ends with a commit. Follow existing commit style; end messages with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

**Exit condition:** Task 6 complete and green → write Plan 1b (org lifecycle & port).

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
| `lib/data/client.ts` | `orgDb()` — the only path to tenant data |
| `__tests__/integration/orgdb.test.ts` | Scoping + role enforcement |
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

This task is **not** TDD. It is a throwaway investigation that produces a GO/NO-GO decision. If it aborts, Tasks 3 and 4 are dropped and register row D-005 is scheduled.

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

const base = new PrismaClient({ datasourceUrl: APP_URL });

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

```ts
import { PrismaClient } from '@prisma/client';

export const testDb = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
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
  projects    Project[]

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

Modify `prisma/schema.prisma`:

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

## Task 3: Restricted app role + RLS policies

**Skip this task entirely if Task 0 returned NO-GO.**

**Files:**
- Create: `prisma/migrations/*/migration.sql` (SQL-only migration)
- Modify: `.env`

**Interfaces:**
- Consumes: tenant tables from Task 2
- Produces: role `makrai_app`; RLS enabled and forced on `projects`, `project_metadata`, `assessments`, `remediation_items`; `APP_DATABASE_URL` connecting as `makrai_app`.

- [ ] **Step 1: Create an empty migration**

```bash
npx prisma migrate dev --create-only --name enable_rls_and_app_role
```

- [ ] **Step 2: Write the RLS migration**

Replace the generated `migration.sql` with:

```sql
-- Restricted runtime role. Migrations continue to run as the owner (makrai).
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

-- Enable AND force RLS on every tenant table. FORCE is what stops the table
-- owner from silently bypassing the policy.
ALTER TABLE "projects"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "assessments"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessments"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" FORCE  ROW LEVEL SECURITY;

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

- [ ] **Step 3: Apply to both databases**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 4: Add the app connection string**

Append to `.env` (gitignored):

```
APP_DATABASE_URL="postgresql://makrai_app:app_dev_password@localhost:5432/makrai"
```

The test-database equivalent is already configured in `vitest.config.ts` from Task 1 Step 3 — no second env file to keep in sync.

- [ ] **Step 5: Verify the role cannot bypass RLS**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai -Atc \
  "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname='makrai_app';"
```

Expected: `makrai_app|f|f`

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/
git commit -m "feat(tenancy): Postgres RLS with a restricted, non-bypassing app role

FORCE ROW LEVEL SECURITY on every tenant table — without it the table owner
bypasses the policy and RLS is decorative. Policy uses NULLIF so an unset
GUC yields zero rows rather than a cast error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Structural guard tests (T1, T2, T4)

**Skip T1 and T2 if Task 0 returned NO-GO; T4 still applies.**

**Files:**
- Create: `__tests__/integration/isolation.test.ts`

**Interfaces:**
- Consumes: RLS from Task 3, composite FKs from Task 2
- Produces: `appDb: PrismaClient` (connects as `makrai_app`) exported from the test file for reuse in Task 6.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/integration/isolation.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';

export const appDb = new PrismaClient({
  datasourceUrl: process.env.APP_DATABASE_URL,
});

describe('T1 — every tenant table has RLS enabled AND forced', () => {
  it('fails if any table with an orgId column is unprotected', async () => {
    const unprotected = await testDb.$queryRaw<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN information_schema.columns col
        ON col.table_name = c.relname AND col.table_schema = 'public'
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND col.column_name = 'orgId'
        AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)
      GROUP BY c.relname
    `;
    expect(unprotected).toEqual([]);
  });
});

describe('T2 — RLS fails closed', () => {
  beforeEach(resetDb);

  it('returns zero rows and does NOT throw when no org context is set', async () => {
    const user = await testDb.user.create({
      data: { email: 't2@example.org', name: 'T2', passwordHash: 'x' },
    });
    const org = await testDb.organization.create({
      data: { name: 'T2 Org', slug: 't2-org' },
    });
    await testDb.project.create({
      data: { orgId: org.id, name: 'hidden', createdById: user.id },
    });

    // As the restricted app role, with no app.current_org_id set:
    const rows = await appDb.project.findMany();
    expect(rows).toEqual([]);          // zero rows ...
  });                                   // ... and no throw: an error here is the bug
});

describe('T4 — composite same-org FK blocks cross-tenant references', () => {
  beforeEach(resetDb);

  it('refuses remediation attached to another org\'s assessment', async () => {
    const mk = async (slug: string) => {
      const u = await testDb.user.create({
        data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
      });
      const o = await testDb.organization.create({ data: { name: slug, slug } });
      const p = await testDb.project.create({
        data: { orgId: o.id, name: slug, createdById: u.id },
      });
      const a = await testDb.assessment.create({
        data: { orgId: o.id, projectId: p.id, userId: u.id, engineState: {} },
      });
      return { o, a };
    };
    const a = await mk('t4-a');
    const b = await mk('t4-b');

    await expect(
      testDb.remediationItem.create({
        data: {
          orgId: b.o.id,            // org B ...
          assessmentId: a.a.id,     // ... referencing org A's assessment
          areaId: 'PO-03',
          areaName: 'Accountability Gap',
          tier: 'gap',
          description: 'cross-tenant',
        },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm current state**

Run: `npx vitest run __tests__/integration/isolation.test.ts`
Expected after Task 3: all PASS. If T1 fails it names the unprotected table — add its `ENABLE`/`FORCE`/policy to a new migration and re-run.

- [ ] **Step 3: Prove T1 actually catches a regression**

Temporarily create an unprotected tenant table and confirm T1 goes red:

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c \
  'CREATE TABLE "leaky" (id uuid PRIMARY KEY, "orgId" uuid NOT NULL);'
npx vitest run __tests__/integration/isolation.test.ts
```

Expected: T1 **FAILS**, listing `leaky`. This proves the guard is live rather than vacuously passing.

- [ ] **Step 4: Remove the probe table and re-run**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c 'DROP TABLE "leaky";'
npx vitest run __tests__/integration/isolation.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add __tests__/integration/isolation.test.ts
git commit -m "test(tenancy): structural guards T1, T2, T4

T1 enumerates pg_class and fails if any table with an orgId column lacks
enabled+forced RLS — adding a tenant table without a policy is now a red
build, not a discovered leak. Verified non-vacuous against a probe table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: RBAC policy module

**Files:**
- Create: `lib/authz/policy.ts`, `__tests__/authz/policy.test.ts`

**Interfaces:**
- Consumes: `OrgRole` from Task 1
- Produces: `type Action`, `can(role: OrgRole, action: Action): boolean`, `ACTIONS: readonly Action[]`, `ROLES: readonly OrgRole[]` from `lib/authz/policy.ts`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/authz/policy.test.ts`. The matrix is the fixture, so every cell is asserted and adding an action without deciding all five roles fails:

```ts
import { describe, expect, it } from 'vitest';
import { can, ACTIONS, ROLES, type Action } from '../../lib/authz/policy';
import type { OrgRole } from '@prisma/client';

// Expected matrix — spec §3.4. '.' = denied, 'x' = allowed.
//                                        owner admin assessor reviewer viewer
const MATRIX: Record<Action, string> = {
  'org:read':             'xxxxx',
  'member:list':          'xxxxx',
  'project:read':         'xxxxx',
  'assessment:read':      'xxxxx',
  'org:update':           'xx...',
  'member:invite':        'xx...',
  'member:remove':        'xx...',
  'project:delete':       'xx...',
  'assessment:delete':    'xx...',
  'org:delete':           'x....',
  'member:grant_owner':   'x....',
  'project:create':       'xxx..',
  'project:update':       'xxx..',
  'assessment:create':    'xxx..',
  'assessment:respond':   'xxx..',
  'assessment:complete':  'xxx..',
  'remediation:update':   'xxx..',
};

describe('can(role, action)', () => {
  it('covers every action exactly once', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
  });

  it('matches the specified matrix in every cell', () => {
    for (const action of ACTIONS) {
      const expected = MATRIX[action];
      expect(expected, `no matrix row for ${action}`).toBeDefined();
      ROLES.forEach((role: OrgRole, i: number) => {
        expect(can(role, action), `${role} → ${action}`).toBe(expected[i] === 'x');
      });
    }
  });

  it('never lets an admin grant ownership', () => {
    expect(can('admin', 'member:grant_owner')).toBe(false);
  });

  it('never lets a viewer or reviewer mutate', () => {
    for (const role of ['viewer', 'reviewer'] as OrgRole[]) {
      expect(can(role, 'assessment:respond')).toBe(false);
      expect(can(role, 'project:create')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run __tests__/authz/policy.test.ts`
Expected: FAIL — cannot resolve `lib/authz/policy`.

- [ ] **Step 3: Implement the policy module**

Create `lib/authz/policy.ts`:

```ts
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

const WRITE: Action[] = [
  'project:create', 'project:update',
  'assessment:create', 'assessment:respond', 'assessment:complete',
  'remediation:update',
];

const MANAGE: Action[] = [
  'org:update', 'member:invite', 'member:remove',
  'project:delete', 'assessment:delete',
];

const OWNER_ONLY: Action[] = ['org:delete', 'member:grant_owner'];

const GRANTS: Record<OrgRole, Action[]> = {
  owner:    [...READ_ALL, ...WRITE, ...MANAGE, ...OWNER_ONLY],
  admin:    [...READ_ALL, ...WRITE, ...MANAGE],
  assessor: [...READ_ALL, ...WRITE],
  reviewer: [...READ_ALL],   // inert until the review spec lands (register D-004)
  viewer:   [...READ_ALL],
};

/** Pure: no I/O, no database. Isolation is RLS's job; authorization is this. */
export function can(role: OrgRole, action: Action): boolean {
  return GRANTS[role].includes(action);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run __tests__/authz/policy.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/authz/policy.ts __tests__/authz/policy.test.ts
git commit -m "feat(authz): can(role, action) policy module with matrix-generated tests

The RBAC matrix is a test fixture, not prose — adding an action without
deciding all five roles fails the build. Pure function, no I/O: RLS does
isolation, this does authorization.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Scoped data-access layer + bypass ban

**Files:**
- Create: `lib/data/client.ts`, `__tests__/integration/orgdb.test.ts`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: `can`/`Action` from Task 5; RLS from Task 3
- Produces: `orgDb(ctx: OrgContext)` returning a scoped Prisma client, and `type OrgContext = { orgId: string; role: OrgRole }`, plus `assertCan(ctx, action)` which throws `ForbiddenError`.

- [ ] **Step 1: Write the failing test**

Create `__tests__/integration/orgdb.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { orgDb, assertCan, ForbiddenError } from '../../lib/data/client';

async function seed(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  return { org, user };
}

describe('orgDb', () => {
  beforeEach(resetDb);

  it('returns only the active org\'s rows', async () => {
    const a = await seed('od-a');
    await seed('od-b');

    const db = orgDb({ orgId: a.org.id, role: 'admin' });
    const projects = await db.project.findMany();

    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('od-a project');
  });

  it('cannot read another org even when asked by id', async () => {
    const a = await seed('od-c');
    const b = await seed('od-d');
    const [foreign] = await testDb.project.findMany({ where: { orgId: b.org.id } });

    const db = orgDb({ orgId: a.org.id, role: 'admin' });
    const found = await db.project.findUnique({ where: { id: foreign.id } });

    expect(found).toBeNull();
  });

  it('refuses a write the role does not permit', () => {
    expect(() => assertCan({ orgId: 'x', role: 'viewer' }, 'project:create'))
      .toThrow(ForbiddenError);
    expect(() => assertCan({ orgId: 'x', role: 'assessor' }, 'project:create'))
      .not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run __tests__/integration/orgdb.test.ts`
Expected: FAIL — cannot resolve `lib/data/client`.

- [ ] **Step 3: Implement the scoped client**

Create `lib/data/client.ts`:

```ts
import { PrismaClient, type OrgRole } from '@prisma/client';
import { can, type Action } from '../authz/policy';

export type OrgContext = { orgId: string; role: OrgRole };

export class ForbiddenError extends Error {
  constructor(action: Action, role: OrgRole) {
    super(`role ${role} may not ${action}`);
    this.name = 'ForbiddenError';
  }
}

/** Throw unless the context's role permits the action. */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/**
 * The app-role client. Connects as makrai_app, which cannot bypass RLS —
 * so a missed scope returns nothing rather than another tenant's rows.
 */
const appClient = new PrismaClient({
  datasourceUrl: process.env.APP_DATABASE_URL,
});

/**
 * The ONLY path to tenant data. Wraps every operation in a transaction that
 * sets app.current_org_id, which the RLS policy reads.
 *
 * set_config(..., true) is transaction-local and parameterised — never
 * interpolate the org id into a SET LOCAL string.
 */
export function orgDb(ctx: OrgContext) {
  return appClient.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return appClient.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ctx.orgId}, true)`;
            return query(args);
          });
        },
      },
    },
  });
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `npx vitest run __tests__/integration/orgdb.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add the bypass ban (T3)**

Modify `eslint.config.mjs` — append to the exported config array:

```js
  {
    files: ['app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/lib/db', '@/lib/db'],
          message:
            'Routes must not use the unscoped Prisma client. Use orgDb() from lib/data/client.',
        }],
      }],
    },
  },
```

- [ ] **Step 6: Verify the ban is live**

```bash
printf "import { prisma } from '@/lib/db';\nexport const x = prisma;\n" > app/__banprobe.ts
npx eslint app/__banprobe.ts
```

Expected: **error** — `Routes must not use the unscoped Prisma client.`

```bash
rm app/__banprobe.ts
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit && npx eslint .`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add lib/data/client.ts __tests__/integration/orgdb.test.ts eslint.config.mjs
git commit -m "feat(tenancy): orgDb scoped data-access layer + lint bypass ban

orgDb is the only path to tenant data: it wraps every operation in a
transaction that sets app.current_org_id via parameterised set_config, and
connects as the non-bypassing app role. ESLint forbids importing lib/db
under app/, making the discipline mechanical rather than remembered.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

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
