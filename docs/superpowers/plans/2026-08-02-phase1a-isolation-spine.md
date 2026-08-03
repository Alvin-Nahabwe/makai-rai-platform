# Phase 1a — Isolation Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove the multi-tenant isolation foundation — tenant schema, Postgres RLS, a mandatory scoped data-access layer, and the structural tests that make forgetting any of it a build failure.

**Architecture:** Shared Postgres database, `NOT NULL orgId` on every tenant table. Per **ADR-0001**, responsibilities are separated rather than duplicated: composite same-org foreign keys make cross-tenant *references* unrepresentable; `withOrg` establishes tenant context and performs **no filtering**; **Postgres RLS is the authoritative tenant filter**; the application layer owns authorization only. Forgetting `withOrg` fails **closed** (no GUC → zero rows), which is why no second application-level filter is added.

**Tech Stack:** Next.js 16.2.9, Prisma 7.8.0, PostgreSQL (docker `docker-postgres-1`), Vitest 4.1.9, TypeScript.

**Source spec:** `docs/superpowers/specs/2026-08-02-phase1-foundation-design.md` (§3.1 and §3.2 superseded by ADR-0001)

**Decision binding this plan:** ADR-0001. ADR-0002 (identity/account-linking) is deliberately **not** a dependency — see D-066.

**Task 0 is already complete.** The RLS/Prisma-7 spike ran on 2026-08-02 and returned **GO for `withOrg`, NO-GO for `$extends`**; findings in `docs/superpowers/spikes/2026-08-02-rls-prisma7-findings.md`. Do not re-run it. This plan begins at Task 1.

## Global Constraints

- Every tenant table carries `orgId String` **NOT NULL**. No nullable tenant keys.
- `orgId` leads every composite index on tenant tables. Sole exception: `Membership` also carries `@@index([userId])`, because "which orgs am I in" is inherently cross-org.
- Routes never import `lib/db`. Tenant data goes through `withOrg` (`lib/data/tenant.ts`); non-tenant models (`User`, `ConsentRecord`) through `identityDb` (`lib/data/identity.ts`); before-context reads through `lib/data/preauth.ts`.
- **The application never re-filters by `orgId`.** Application code filters for *domain* reasons only (status, date, ownership within a tenant).
- The org GUC is set with `set_config('app.current_org_id', $1, true)` — **parameterised**, and **`true`** (transaction-scoped). A session-scoped setting would leak across a pooled connection.
- RLS policy comparison is exactly: `"orgId" = NULLIF(current_setting('app.current_org_id', true), '')`. The `NULLIF` is mandatory. **No `::uuid` cast** — `orgId` is a `text` column and Postgres has no `text = uuid` operator, so the cast makes `CREATE POLICY` fail outright (D-064).
- Any DDL-introspecting SQL resolves columns by **catalog/OID** (`pg_attribute` on `obj.objid`), never by reconstructing a name from `object_identity` — that string is quoted for mixed-case identifiers (D-064).
- The app connects as a **non-owner, non-superuser, `NOBYPASSRLS`** role. Every tenant table gets `FORCE ROW LEVEL SECURITY`.
- Authorization lives in the app layer, never as JOINs inside RLS policies.
- Unauthorised access to an existing resource returns **404**, never 403 — do not leak existence.
- Every task ends with a commit, ending with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

### Toolchain facts — verified 2026-08-02, do not re-derive by trial and error

- **Prisma 7 takes an `adapter`, not `datasourceUrl`.** Construct: `new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString })) })`. `lib/db.ts` already does this.
- **`datasource.url` is rejected in schema files** (P1012). Connection URLs live in `prisma.config.ts`.
- **`prisma migrate dev --create-only` prompts and cannot run non-interactively.** `CI=true` and a pty wrapper both fail. For a SQL-only migration, create the directory and write `migration.sql` by hand, then apply with `npx prisma migrate deploy`.
- **`prisma migrate deploy` does NOT regenerate the client.** After any schema change run `npx prisma generate`, or `tsc` silently type-checks against a stale client.
- Postgres password for role `makrai` is **`makrai_dev_password`**. Test DB URL: `postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test`.
- `makrai` is a **superuser with BYPASSRLS** and owns every table. `FORCE` does not constrain it. This is contained by connecting the app as `makrai_app`, which is an architectural claim, not an RLS property.

### Baseline state — verified 2026-08-02

- 4 migrations applied to both `makrai` and `makrai_test`; no org tables, no RLS, no event triggers, no `makrai_app` role.
- `Project.orgId` and `Assessment.orgId` already exist as **nullable** `String?` with `@@index([orgId])`, commented "Multi-tenancy prep". `ProjectMetadata` and `RemediationItem` have **no** `orgId`.
- `npx vitest run` → **83/83**. `npx tsc --noEmit` → **0 errors**. `npm run lint` → **0 errors** (1 warning, in `.remember/tmp/`, not project code).
- 22 files import the Prisma client, 50 `prisma.<model>.` call sites, **17 non-tenant** (`user` ×14, `consentRecord` ×3).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Modified — org tables, tenant `orgId`, composite same-org FKs, indexes |
| `prisma/migrations/*/migration.sql` | Generated, then hand-written for roles and RLS |
| `__tests__/helpers/db.ts` | Integration harness: test client + `resetDb()` with a non-test-database guard |
| `__tests__/integration/schema.test.ts` | Org / membership / invitation constraints |
| `__tests__/integration/tenant-schema.test.ts` | `NOT NULL orgId` + composite same-org FK constraints |
| `lib/authz/policy.ts` | `can(role, action)` — pure, no I/O |
| `__tests__/authz/policy.test.ts` | Matrix-generated RBAC coverage |
| `lib/data/tenant.ts` | `withOrg()` + `assertCan()` — the only path to tenant data |
| `lib/data/identity.ts` | `identityDb` — non-tenant models only, type-narrowed |
| `lib/data/preauth.ts` | The few before-context reads, on the owner connection |
| `__tests__/integration/tenant-layer.test.ts` | `withOrg` mechanism + role enforcement |
| `__tests__/integration/preauth-surface.test.ts` | Pins `preauth`'s exported surface so the bypass cannot grow |
| `__tests__/integration/isolation.test.ts` | T1 / T2 / T4 structural guards + end-to-end isolation |
| `eslint.config.mjs` | Modified — ban `lib/db` imports outside `lib/data/` |

## Spec coverage — what this plan does NOT implement

| Spec section | Deferred to Plan 1b |
|---|---|
| §2.5 | Zero-org-unreachable and never-zero-owners invariants — they live in registration and membership mutation logic |
| §3.5 | Narrowing `/admin/assessments` (D-006) and gating `/api/research/export` (D-007) |
| §4 | Registration transaction, invitations, email, `/orgs/[slug]` routing, org switcher, `requireOrgContext` |
| §5 | The gated port of engine / content / report / PDF |
| §6.3 | IDOR matrix over resource *routes*; session-staleness; invitation lifecycle |
| §6.4 | **Live browser verification — the actual definition of done** |

`requireOrgContext` (ADR-0001's context layer) is Plan 1b: it needs `/orgs/[slug]` routing, which does not exist yet. Plan 1a builds the layer it sits on and proves that layer in isolation.

---

## Task 1: Integration-test harness + organization tables

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_organizations_memberships_invitations/migration.sql`
- Create: `__tests__/helpers/db.ts`, `__tests__/integration/schema.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `testDb: PrismaClient` and `resetDb(): Promise<void>` from `__tests__/helpers/db.ts`; models `Organization`, `Membership`, `Invitation`; enums `OrgRole` (`owner|admin|assessor|reviewer|viewer`), `MembershipStatus` (`active|suspended`), `InvitationStatus` (`pending|accepted|expired|revoked`).

- [ ] **Step 1: Point vitest at the test database and serialise test files**

Replace the `test` block in `vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    globals: true,
    /**
     * Integration tests share one Postgres database and call resetDb(), which
     * issues TRUNCATE ... CASCADE. With file-level parallelism one file's
     * truncate deletes rows another file just created. Serialising is the
     * simplest fix — the whole suite runs in ~2s.
     */
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test',
      APP_DATABASE_URL:
        process.env.TEST_APP_DATABASE_URL ??
        'postgresql://makrai_app:app_dev_password@localhost:5432/makrai_test',
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
```

- [ ] **Step 2: Write the test harness**

Create `__tests__/helpers/db.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

export const testDb = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

/**
 * TRUNCATEs every public table. Guarded by the database's OWN name rather than
 * by the URL string: importing this helper outside the vitest runner would
 * otherwise inherit .env's DATABASE_URL and wipe the dev database.
 */
export async function resetDb(): Promise<void> {
  const [{ current_database: db }] =
    await testDb.$queryRaw<{ current_database: string }[]>`SELECT current_database()`;
  if (db !== 'makrai_test') {
    throw new Error(`Refusing to reset database "${db}" — resetDb() only runs against makrai_test`);
  }
  const tables = await testDb.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await testDb.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}
```

- [ ] **Step 3: Write the failing tests**

Create `__tests__/integration/schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function mkUser(email: string) {
  return testDb.user.create({ data: { email, name: email, passwordHash: 'x' } });
}

describe('organization schema', () => {
  beforeEach(resetDb);

  it('enforces a unique org slug', async () => {
    await testDb.organization.create({ data: { name: 'A', slug: 'dup' } });
    await expect(
      testDb.organization.create({ data: { name: 'B', slug: 'dup' } }),
    ).rejects.toThrow();
  });

  it('allows one membership per (org, user) and rejects a second', async () => {
    const u = await mkUser('m@x.org');
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'o' } });
    await testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'owner' } });
    await expect(
      testDb.membership.create({ data: { orgId: o.id, userId: u.id, role: 'viewer' } }),
    ).rejects.toThrow();
  });

  it('lets one user belong to two organizations', async () => {
    const u = await mkUser('multi@x.org');
    const a = await testDb.organization.create({ data: { name: 'A', slug: 'a' } });
    const b = await testDb.organization.create({ data: { name: 'B', slug: 'b' } });
    await testDb.membership.create({ data: { orgId: a.id, userId: u.id, role: 'owner' } });
    await testDb.membership.create({ data: { orgId: b.id, userId: u.id, role: 'viewer' } });
    expect(await testDb.membership.count({ where: { userId: u.id } })).toBe(2);
  });

  it('enforces a unique invitation token', async () => {
    const o = await testDb.organization.create({ data: { name: 'O', slug: 'inv' } });
    const u = await mkUser('inviter@x.org');
    const base = { orgId: o.id, email: 'a@x.org', role: 'viewer' as const,
                   invitedById: u.id, expiresAt: new Date(Date.now() + 86400000) };
    await testDb.invitation.create({ data: { ...base, token: 'tok' } });
    await expect(testDb.invitation.create({ data: { ...base, token: 'tok' } })).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run __tests__/integration/schema.test.ts`
Expected: FAIL — `testDb.organization` is undefined (the model does not exist yet).

> If it instead fails with a Postgres auth error (`28P01`), the password is wrong — it is `makrai_dev_password`. Fix that before continuing; do not work around it.

- [ ] **Step 5: Add the models**

Append to `prisma/schema.prisma`:

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
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?

  memberships Membership[]
  invitations Invitation[]
  // NOTE: `projects Project[]` is deliberately NOT declared here. Prisma
  // requires both sides of a relation to exist, and Project does not gain its
  // back-reference until Task 2. Adding it now makes `prisma validate` fail.

  @@map("organizations")
}

model Membership {
  id     String           @id @default(uuid())
  orgId  String
  org    Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  userId String
  user   User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  role   OrgRole
  status MembershipStatus @default(active)
  createdAt DateTime      @default(now())

  @@unique([orgId, userId])
  @@index([userId])
  @@map("memberships")
}

model Invitation {
  id          String           @id @default(uuid())
  orgId       String
  org         Organization     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  email       String
  role        OrgRole
  token       String           @unique
  status      InvitationStatus @default(pending)
  invitedById String
  invitedBy   User             @relation("InvitedBy", fields: [invitedById], references: [id])
  expiresAt   DateTime
  createdAt   DateTime         @default(now())

  @@index([orgId, email])
  @@map("invitations")
}
```

Add to `model User`:

```prisma
  memberships      Membership[]
  sentInvitations  Invitation[] @relation("InvitedBy")
  lastActiveOrgId  String?      // plain column, NOT a FK — see note below
```

> `lastActiveOrgId` is a plain `String?`, not a foreign key. A real FK would need a *second*, named relation between `User` and `Organization` (Membership is the first) for Prisma to disambiguate. `onDelete: SetNull` would only fire on org deletion, while the real dangling case is membership *revocation* — so the fallback path is needed regardless and the FK buys ceremony, not safety.

- [ ] **Step 6: Create and apply the migration**

```bash
npx prisma migrate dev --name add_organizations_memberships_invitations
npx prisma generate
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run`
Expected: 83 pre-existing + 4 new = **87 passing**.

- [ ] **Step 8: Prove the resetDb guard is real**

```bash
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai" \
  npx tsx -e "import('./__tests__/helpers/db.ts').then(m=>m.resetDb()).catch(e=>console.log('GUARD:',e.message))"
```

Expected: `GUARD: Refusing to reset database "makrai" …`, and the dev database still has its rows. A guard never demonstrated to fire is not a guard.

- [ ] **Step 9: Commit**

```bash
git add prisma/ __tests__/ vitest.config.ts
git commit -m "feat(tenancy): add Organization, Membership, Invitation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Port tenant tables to NOT NULL orgId + composite same-org FKs

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_port_tenant_tables_to_org_id/migration.sql`
- Create: `__tests__/integration/tenant-schema.test.ts`

**Interfaces:**
- Consumes: `Organization` (Task 1)
- Produces: `orgId String` NOT NULL on `Project`, `ProjectMetadata`, `Assessment`, `RemediationItem`; composite same-org FKs; `Organization.projects`.

**Why composite FKs:** a plain `assessment.projectId → projects.id` lets an assessment in org A point at a project in org B. Referencing `(orgId, projectId) → projects(orgId, id)` makes that unrepresentable at the schema level — a constraint, not a check someone must remember.

- [ ] **Step 1: Write the failing tests**

Create `__tests__/integration/tenant-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';

async function seed(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  return { user, org, project };
}

describe('tenant schema', () => {
  beforeEach(resetDb);

  it('refuses a project with no orgId', async () => {
    const u = await testDb.user.create({ data: { email: 'n@x.org', name: 'n', passwordHash: 'x' } });
    await expect(
      // @ts-expect-error orgId is required — this must not compile or run
      testDb.project.create({ data: { name: 'orphan', createdById: u.id } }),
    ).rejects.toThrow();
  });

  it('refuses an assessment attached to another org project', async () => {
    const a = await seed('t2-a');
    const b = await seed('t2-b');
    await expect(
      testDb.assessment.create({
        data: { orgId: a.org.id, projectId: b.project.id, userId: a.user.id, engineState: {} },
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('refuses a remediation item attached to another org assessment', async () => {
    const a = await seed('t2-c');
    const b = await seed('t2-d');
    const asmt = await testDb.assessment.create({
      data: { orgId: b.org.id, projectId: b.project.id, userId: b.user.id, engineState: {} },
    });
    await expect(
      testDb.remediationItem.create({
        data: { orgId: a.org.id, assessmentId: asmt.id, areaId: 'PO-03',
                areaName: 'Accountability', tier: 'gap', description: 'cross-tenant' },
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('accepts a same-org chain', async () => {
    const a = await seed('t2-ok');
    const asmt = await testDb.assessment.create({
      data: { orgId: a.org.id, projectId: a.project.id, userId: a.user.id, engineState: {} },
    });
    const item = await testDb.remediationItem.create({
      data: { orgId: a.org.id, assessmentId: asmt.id, areaId: 'PO-01',
              areaName: 'Governance', tier: 'attention', description: 'ok' },
    });
    expect(item.orgId).toBe(a.org.id);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/integration/tenant-schema.test.ts`
Expected: FAIL — cross-org rows are currently accepted, and `remediationItem.orgId` does not exist.

- [ ] **Step 3: Update the schema**

In `prisma/schema.prisma`:

```prisma
model Organization {
  // ... existing fields ...
  projects    Project[]      // now safe: Project gains its back-reference below
}

model Project {
  id          String   @id @default(uuid())
  orgId       String                                     // was String? — now NOT NULL
  org         Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)
  // ... unchanged fields ...
  @@unique([orgId, id])                                  // target for composite child FKs
  @@index([orgId, createdById])
  @@map("projects")
}

model ProjectMetadata {
  id        String  @id @default(uuid())
  orgId     String
  projectId String
  project   Project @relation(fields: [orgId, projectId], references: [orgId, id], onDelete: Cascade)
  // ... unchanged fields ...
  @@unique([orgId, projectId])   // Prisma requires this for a composite-FK one-to-one
  @@map("project_metadata")
}

model Assessment {
  id        String  @id @default(uuid())
  orgId     String
  projectId String
  project   Project @relation(fields: [orgId, projectId], references: [orgId, id], onDelete: Cascade)
  // ... unchanged fields ...
  @@unique([orgId, id])
  @@index([orgId, projectId])
  @@index([orgId, userId])
  @@map("assessments")
}

model RemediationItem {
  id           String     @id @default(uuid())
  orgId        String
  assessmentId String
  assessment   Assessment @relation(fields: [orgId, assessmentId], references: [orgId, id], onDelete: Cascade)
  // ... unchanged fields ...
  @@index([orgId, assessmentId])
  @@map("remediation_items")
}
```

> Drop the now-redundant single-column `@@index([orgId])` on `Project` and `Assessment` — the composite indexes lead with `orgId`, so a leftmost-prefix scan already covers those queries.

- [ ] **Step 4: Validate before generating a migration**

Run: `npx prisma validate`
Expected: exit 0. If it reports a missing opposite relation field, fix the schema — do not hand-edit around it.

- [ ] **Step 5: Create the migration and add the backfill**

```bash
npx prisma migrate dev --create-only --name port_tenant_tables_to_org_id
```

> If this prompts and hangs, it is the known non-interactive limitation. Instead create the directory by hand and generate the SQL:
> ```bash
> D=prisma/migrations/$(date -u +%Y%m%d%H%M%S)_port_tenant_tables_to_org_id
> mkdir -p $D
> npx prisma migrate diff --from-config-datasource \
>   --to-schema prisma/schema.prisma --script > $D/migration.sql
> ```

The generated SQL sets `NOT NULL` on columns that may hold NULLs. **Prepend a backfill.**

> **Corrected 2026-08-03.** This step previously asserted "the dev database has existing rows".
> That was stale — both databases were dropped and recreated during the rollback, so they are
> empty. The backfill is still **required**, not optional: it must be correct for any environment
> that *does* hold rows, and an `ALTER ... SET NOT NULL` against a populated column fails
> outright. Write and apply it regardless of what the local database happens to contain.
> Flags also corrected: Prisma 7.8 takes `--from-config-datasource` and `--to-schema`, not
> `--from-schema-datasource`/`--to-schema-datamodel` (verified via `prisma migrate diff --help`).


```sql
-- Existing single-tenant rows predate organizations. Give them a home org so
-- the NOT NULL constraints below can be applied without data loss.
INSERT INTO "organizations" ("id","name","slug","createdAt","updatedAt")
  VALUES ('00000000-0000-0000-0000-000000000001','Legacy','legacy', now(), now())
  ON CONFLICT ("slug") DO NOTHING;

UPDATE "projects"    SET "orgId" = '00000000-0000-0000-0000-000000000001' WHERE "orgId" IS NULL;
UPDATE "assessments" SET "orgId" = '00000000-0000-0000-0000-000000000001' WHERE "orgId" IS NULL;

ALTER TABLE "project_metadata"  ADD COLUMN IF NOT EXISTS "orgId" TEXT;
UPDATE "project_metadata" m SET "orgId" = p."orgId" FROM "projects" p WHERE m."projectId" = p."id";

ALTER TABLE "remediation_items" ADD COLUMN IF NOT EXISTS "orgId" TEXT;
UPDATE "remediation_items" r SET "orgId" = a."orgId" FROM "assessments" a WHERE r."assessmentId" = a."id";
```

- [ ] **Step 6: Apply to both databases and regenerate**

```bash
npx prisma migrate deploy
npx prisma generate
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 7: Verify the constraints landed — query the catalog, not the exit code**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -Atc \
  "SELECT table_name||'.'||column_name||' nullable='||is_nullable
   FROM information_schema.columns
   WHERE table_schema='public' AND column_name='orgId' ORDER BY 1;"
docker exec docker-postgres-1 psql -U makrai -d makrai_test -Atc \
  "SELECT conname FROM pg_constraint WHERE contype='f' AND array_length(conkey,1)=2 ORDER BY 1;"
```

Expected: six `orgId` columns, all `nullable=NO`; three two-column foreign keys.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run`
Expected: **91 passing** (87 + 4 new in `tenant-schema.test.ts`).

- [ ] **Step 9: Record the intended type breakage**

`npx tsc --noEmit` now reports **exactly 3 errors** — `orgId` missing on create in `app/api/projects/route.ts`, `app/api/assessments/route.ts`, and `app/api/assessments/[id]/remediation/route.ts`. These are the *correct* consequence of `NOT NULL orgId` on routes that predate tenancy. **Do not suppress them.** Add a register row recording them, targeted at the Plan 1b route port. From here on the gate is "exactly these 3 errors and no others" — a fourth is a failure.

- [ ] **Step 10: Commit**

```bash
git add prisma/ __tests__/ docs/DEFERRED_REGISTER.md
git commit -m "feat(tenancy): NOT NULL orgId + composite same-org foreign keys

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: RBAC policy module

**Files:**
- Create: `lib/authz/policy.ts`, `__tests__/authz/policy.test.ts`

**Interfaces:**
- Consumes: `OrgRole` from `@prisma/client`
- Produces: `type Action`, `can(role: OrgRole, action: Action): boolean`

Pure functions, no I/O, no database. Isolation is RLS's job; this module answers only "may this role do this?".

- [ ] **Step 1: Write the failing test**

Create `__tests__/authz/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { can, type Action } from '../../lib/authz/policy';
import type { OrgRole } from '@prisma/client';

const ROLES: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];

// The full intended matrix, written out. A generated expectation that mirrors
// the implementation would assert nothing.
const MATRIX: Record<Action, OrgRole[]> = {
  'project:read':      ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'project:create':    ['owner', 'admin', 'assessor'],
  'project:update':    ['owner', 'admin', 'assessor'],
  'project:delete':    ['owner', 'admin'],
  'assessment:read':   ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'assessment:create': ['owner', 'admin', 'assessor'],
  'assessment:update': ['owner', 'admin', 'assessor'],
  'assessment:delete': ['owner', 'admin'],
  'member:read':       ['owner', 'admin', 'assessor', 'reviewer', 'viewer'],
  'member:invite':     ['owner', 'admin'],
  'member:remove':     ['owner', 'admin'],
  'member:grant_owner':['owner'],
  'org:update':        ['owner', 'admin'],
  'org:delete':        ['owner'],
};

describe('can(role, action)', () => {
  for (const [action, allowed] of Object.entries(MATRIX) as [Action, OrgRole[]][]) {
    for (const role of ROLES) {
      const expected = allowed.includes(role);
      it(`${role} ${expected ? 'may' : 'may NOT'} ${action}`, () => {
        expect(can(role, action)).toBe(expected);
      });
    }
  }

  it('never lets a non-owner grant ownership', () => {
    for (const role of ROLES.filter((r) => r !== 'owner')) {
      expect(can(role, 'member:grant_owner')).toBe(false);
    }
  });

  it('gives viewer no mutating capability at all', () => {
    const mutations = (Object.keys(MATRIX) as Action[]).filter((a) => !a.endsWith(':read'));
    for (const a of mutations) expect(can('viewer', a)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run __tests__/authz/policy.test.ts`
Expected: FAIL — cannot resolve `../../lib/authz/policy`.

- [ ] **Step 3: Implement**

Create `lib/authz/policy.ts`:

```ts
import type { OrgRole } from '@prisma/client';

export type Action =
  | 'project:read' | 'project:create' | 'project:update' | 'project:delete'
  | 'assessment:read' | 'assessment:create' | 'assessment:update' | 'assessment:delete'
  | 'member:read' | 'member:invite' | 'member:remove' | 'member:grant_owner'
  | 'org:update' | 'org:delete';

/**
 * Capability grants per role. Authorization only — this module performs no
 * tenant filtering, because RLS owns that (ADR-0001).
 *
 * `reviewer` intentionally ships with viewer-equivalent capabilities; its
 * distinguishing powers belong to the review/sign-off workflow (register D-002,
 * D-004). Inventing them here would be speculative.
 */
const GRANTS: Record<OrgRole, readonly Action[]> = {
  owner: ['project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'member:read','member:invite','member:remove','member:grant_owner',
          'org:update','org:delete'],
  admin: ['project:read','project:create','project:update','project:delete',
          'assessment:read','assessment:create','assessment:update','assessment:delete',
          'member:read','member:invite','member:remove','org:update'],
  assessor: ['project:read','project:create','project:update',
             'assessment:read','assessment:create','assessment:update','member:read'],
  reviewer: ['project:read','assessment:read','member:read'],
  viewer:   ['project:read','assessment:read','member:read'],
};

export function can(role: OrgRole, action: Action): boolean {
  return GRANTS[role].includes(action);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run`
Expected: **91 + 72 = 163 passing** (14 actions × 5 roles = 70 matrix cases, + 2 guard tests).

- [ ] **Step 5: Prove the matrix test is non-vacuous**

Temporarily add `'member:grant_owner'` to the `admin` grant list and re-run. Expect **2 failures** (the matrix assertion and the escalation guard). Revert, re-run, expect green. A matrix test that cannot go red is decoration.

- [ ] **Step 6: Commit**

```bash
git add lib/authz/ __tests__/authz/
git commit -m "feat(authz): can(role, action) policy module with matrix-generated tests

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Data-access layer — `withOrg`, `identityDb`, `preauth`, restricted role

**Files:**
- Create: `prisma/migrations/<ts>_add_restricted_app_role/migration.sql`
- Create: `lib/data/tenant.ts`, `lib/data/identity.ts`, `lib/data/preauth.ts`
- Create: `__tests__/integration/tenant-layer.test.ts`, `__tests__/integration/preauth-surface.test.ts`
- Modify: `eslint.config.mjs`, `.env`, `.env.example`

**Interfaces:**
- Consumes: `can`/`Action` (Task 3); tenant tables (Task 2)
- Produces: `type OrgContext = { orgId: string; role: OrgRole }`; `withOrg<T>(ctx, cb)`; `assertCan(ctx, action)`; `ForbiddenError`; `identityDb`; `membershipsForUser`, `orgBySlug`, `invitationByToken`.

- [ ] **Step 1: Create the restricted role**

Hand-write `prisma/migrations/<ts>_add_restricted_app_role/migration.sql`:

```sql
-- The application connects as this role. It is NOT the table owner and has
-- NOBYPASSRLS, so Task 5's policies actually constrain it. Containing the
-- superuser owner (makrai) is role separation, not something RLS can do.
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

Apply to both databases with `npx prisma migrate deploy`, then add to `.env` and `.env.example`:

```
APP_DATABASE_URL="postgresql://makrai_app:app_dev_password@localhost:5432/makrai"
```

Verify: `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='makrai_app';` → `f|f`.

- [ ] **Step 2: Write the failing tests**

Create `__tests__/integration/tenant-layer.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { withOrg, assertCan, ForbiddenError } from '../../lib/data/tenant';

async function seed(slug: string) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  return { user, org, project };
}

describe('withOrg', () => {
  beforeEach(resetDb);

  it('sets the org GUC inside the transaction', async () => {
    const a = await seed('tl-a');
    const got = await withOrg({ orgId: a.org.id, role: 'admin' }, async (tx) => {
      const r = await tx.$queryRaw<{ v: string }[]>`
        SELECT current_setting('app.current_org_id', true) AS v`;
      return r[0].v;
    });
    expect(got).toBe(a.org.id);
  });

  it('leaves no GUC residue after the transaction ends', async () => {
    const a = await seed('tl-b');
    await withOrg({ orgId: a.org.id, role: 'admin' }, (tx) => tx.project.findMany());
    const { appClient } = await import('../../lib/data/tenant');
    const r = await appClient.$queryRaw<{ v: string }[]>`
      SELECT COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), '<unset>') AS v`;
    expect(r[0].v).toBe('<unset>');
  });
});

describe('assertCan', () => {
  it('throws ForbiddenError for a role without the capability', () => {
    expect(() => assertCan({ orgId: 'x', role: 'viewer' }, 'project:create'))
      .toThrow(ForbiddenError);
  });

  it('does not throw for a role with it', () => {
    expect(() => assertCan({ orgId: 'x', role: 'admin' }, 'project:create')).not.toThrow();
  });
});
```

Create `__tests__/integration/preauth-surface.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as preauth from '../../lib/data/preauth';

/**
 * preauth runs on the OWNER connection and is therefore not constrained by RLS.
 * That bypass is deliberate (ADR-0001) but must stay small and enumerable, so
 * this test pins the exported surface. Adding a function here is a decision,
 * not an accident — if this test fails, that is the point.
 */
describe('preauth exported surface', () => {
  it('exports exactly the three sanctioned before-context reads', () => {
    expect(Object.keys(preauth).sort())
      .toEqual(['invitationByToken', 'membershipsForUser', 'orgBySlug']);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run __tests__/integration/tenant-layer.test.ts __tests__/integration/preauth-surface.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 4: Implement the three modules**

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

/** Authorization only. Isolation is RLS's job (ADR-0001). */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/** Connects as makrai_app, which is NOBYPASSRLS — so an escaped query returns nothing. */
export const appClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.APP_DATABASE_URL })),
});

/**
 * The ONLY path to tenant data.
 *
 * Opens one interactive transaction, sets the org GUC that RLS reads, and hands
 * the caller the transaction handle. It performs NO filtering — RLS is the
 * authoritative tenant filter. Forgetting to use it fails CLOSED: with no GUC
 * set the policy matches nothing and queries return zero rows.
 *
 * set_config(..., true) is transaction-scoped AND parameterised. Never
 * interpolate an org id into a SET LOCAL string, and never pass `false` — a
 * session-scoped setting would survive on a pooled connection into the next
 * request.
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
 * Non-tenant data only: User and ConsentRecord (17 of 50 call sites). Login
 * reads User before any organization is known, so withOrg structurally cannot
 * serve these.
 *
 * This client connects as `makrai`, the schema owner — a SUPERUSER with
 * BYPASSRLS. Superusers bypass RLS unconditionally and FORCE does not apply to
 * them, so a tenant query through this client would silently return every
 * organization's rows and no database control could stop it. The type below is
 * the enforcement point: every orgId-bearing model is removed, so
 * `identityDb.project` fails to compile rather than compiling and leaking.
 */
type NonTenantClient = Omit<
  PrismaClient,
  'project' | 'projectMetadata' | 'assessment' | 'remediationItem'
        | 'organization' | 'membership' | 'invitation'
>;

export const identityDb: NonTenantClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});
```

Create `lib/data/preauth.ts`:

```ts
import { PrismaClient, type Membership, type Organization, type Invitation } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

/**
 * The before-context reads — and ONLY these.
 *
 * Some reads must happen before any org context exists: resolving which orgs a
 * user belongs to at login, mapping a URL slug to an organization, and looking
 * up an invitation by token. These are inherently cross-org ("which orgs am I
 * in" cannot be org-scoped), so no RLS policy can serve them; they run on the
 * owner connection, which bypasses RLS.
 *
 * That bypass is deliberate (ADR-0001) and must stay small. Do not add a
 * function here without deciding it is genuinely a before-context read —
 * __tests__/integration/preauth-surface.test.ts pins this module's exports and
 * will fail if the surface grows.
 */
const ownerClient = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL })),
});

export function membershipsForUser(userId: string): Promise<(Membership & { org: Organization })[]> {
  return ownerClient.membership.findMany({
    where: { userId, status: 'active', org: { deletedAt: null } },
    include: { org: true },
  });
}

export function orgBySlug(slug: string): Promise<Organization | null> {
  return ownerClient.organization.findFirst({ where: { slug, deletedAt: null } });
}

export function invitationByToken(token: string): Promise<Invitation | null> {
  return ownerClient.invitation.findUnique({ where: { token } });
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run`
Expected: **168 passing** (163 + 4 in `tenant-layer.test.ts` + 1 in `preauth-surface.test.ts`).

- [ ] **Step 6: Prove the identityDb type boundary is real**

Create a scratch file containing `import { identityDb } from './lib/data/identity'; identityDb.project.findMany();` and run `npx tsc --noEmit`. Expected: `Property 'project' does not exist on type 'NonTenantClient'`. **Delete the scratch file**, then confirm `git status --porcelain --untracked-files=all` is clean — an untracked file never reaches a reviewer.

- [ ] **Step 7: Ban raw client imports outside `lib/data/`**

Add to `eslint.config.mjs`:

```js
{
  files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
  ignores: ['lib/data/**', 'lib/db.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      paths: [{
        name: '@/lib/db',
        message: 'Tenant data goes through withOrg (lib/data/tenant.ts); non-tenant through identityDb (lib/data/identity.ts). See ADR-0001.',
      }],
    }],
  },
},
```

This immediately flags **22 pre-existing imports** (20 files under `app/`, plus `lib/auth.ts` and `lib/authz.ts`), enumerated 2026-08-02. **`npm run lint` is currently clean and `npm run verify` chains lint → test → build**, so enabling the rule bare would leave `verify` red for the whole of Plan 1b — and a permanently-red gate trains people to ignore it.

Instead add an **explicit, shrinking allowlist** immediately after the rule:

```js
{
  // Unported call sites still on the raw client, enumerated 2026-08-02.
  // Plan 1b deletes these entries one at a time as each moves to
  // withOrg/identityDb; when the list is empty, delete this block entirely.
  // Adding a NEW path here is a review failure, not a workaround.
  files: [
    'app/api/admin/users/[id]/role/route.ts',
    'app/api/assessments/[id]/complete/route.ts',
    'app/api/assessments/[id]/remediation/route.ts',
    'app/api/assessments/[id]/route.ts',
    'app/api/assessments/route.ts',
    'app/api/auth/register/route.ts',
    'app/api/projects/[id]/route.ts',
    'app/api/projects/route.ts',
    'app/api/reports/[id]/pdf/route.ts',
    'app/api/research/export/route.ts',
    'app/api/users/me/export/route.ts',
    'app/api/users/me/password/route.ts',
    'app/api/users/me/route.ts',
    'app/(authenticated)/admin/assessments/page.tsx',
    'app/(authenticated)/admin/settings/page.tsx',
    'app/(authenticated)/admin/users/page.tsx',
    'app/(authenticated)/dashboard/page.tsx',
    'app/(authenticated)/projects/[id]/compare/page.tsx',
    'app/(authenticated)/projects/[id]/page.tsx',
    'app/(authenticated)/projects/page.tsx',
    'lib/auth.ts',   // reads User at login — moves to identityDb in Plan 1b
    'lib/authz.ts',  // deleted in Plan 1b: its ownership premise is wrong under tenancy
  ],
  rules: { 'no-restricted-imports': 'off' },
},
```

Verify the list is still accurate before pasting it, since the tree may have moved:

```bash
grep -rl "from '@/lib/db'" app lib --include=*.ts --include=*.tsx | sort
```

Record the allowlist as a register row targeted at the Plan 1b port. This keeps the ban live for new code, keeps `verify` green, and turns the remaining debt into a visible countdown rather than a wall of noise.

- [ ] **Step 8: Verify lint and the ban together**

```bash
npm run lint                      # expect 0 errors
```

Then temporarily add `import { prisma } from '@/lib/db';` to a **new** file under `app/api/` and re-run — expect the ban to fire. Delete the probe file and confirm the tree is clean.

- [ ] **Step 9: Commit**

```bash
git add lib/data/ __tests__/integration/ eslint.config.mjs prisma/migrations/ .env.example docs/DEFERRED_REGISTER.md
git commit -m "feat(tenancy): withOrg data layer, identity and preauth paths, restricted role

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: RLS policies, FORCE, and the DDL event trigger

**Files:**
- Create: `prisma/migrations/<ts>_enable_rls_and_guard_trigger/migration.sql`

**Interfaces:**
- Consumes: tenant tables (Task 2), `makrai_app` (Task 4)
- Produces: RLS enabled and forced on all **six** `orgId`-bearing tables; an event trigger that makes shipping an unprotected tenant table structurally impossible.

This migration changes no Prisma schema, so there is nothing to diff. Create the directory and write `migration.sql` by hand; do not run `migrate dev --create-only`.

- [ ] **Step 1: Write the migration**

```sql
-- Six tables, not four: memberships and invitations also carry orgId, and
-- makrai_app holds SELECT on both. Task 6's T1 test enumerates every table with
-- an orgId column, and the event trigger below encodes the same rule -- protect
-- only four and the guard permanently contradicts the migration that installed it.
--
-- FORCE removes the owner exemption for a NON-SUPERUSER owner. It does nothing
-- to a superuser: `makrai` owns these tables and has BYPASSRLS, so it still sees
-- every row. Containing it is role separation -- the app connects as makrai_app
-- (ADR-0001 control 2) -- not something FORCE achieves.
ALTER TABLE "projects"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects"          FORCE  ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_metadata"  FORCE  ROW LEVEL SECURITY;
ALTER TABLE "assessments"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "assessments"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "remediation_items" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "memberships"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships"       FORCE  ROW LEVEL SECURITY;
ALTER TABLE "invitations"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations"       FORCE  ROW LEVEL SECURITY;

-- NULLIF is mandatory: after a transaction-scoped set_config the GUC reads as
-- '' rather than being absent, and '' would otherwise be compared literally.
-- NULLIF turns it into NULL, which matches no row -- failing closed.
--
-- No ::uuid cast. "orgId" is a text column and Postgres has no text = uuid
-- operator, so the cast makes CREATE POLICY fail outright (D-064).
DROP POLICY IF EXISTS org_isolation ON "projects";
CREATE POLICY org_isolation ON "projects"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "project_metadata";
CREATE POLICY org_isolation ON "project_metadata"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "assessments";
CREATE POLICY org_isolation ON "assessments"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "remediation_items";
CREATE POLICY org_isolation ON "remediation_items"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "memberships";
CREATE POLICY org_isolation ON "memberships"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));

DROP POLICY IF EXISTS org_isolation ON "invitations";
CREATE POLICY org_isolation ON "invitations"
  USING      ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("orgId" = NULLIF(current_setting('app.current_org_id', true), ''));
```

> `organizations` is deliberately excluded: it has no `orgId` column (it *is* the tenant), so neither the trigger nor T1 can cover it, and slug→org resolution is a before-context read. Record it as a register row rather than protecting it here (D-062).

- [ ] **Step 2: Append the DDL event trigger**

```sql
-- ADR-0001 control 4: auto-enable RLS on any new public table carrying an
-- orgId column, so a forgotten policy is structurally impossible rather than
-- merely tested.
--
-- Column lookup goes through pg_attribute keyed on obj.objid. It must NOT
-- reconstruct the table name from object_identity: that string is QUOTED for
-- mixed-case identifiers, so a table like "ProjectTag" yields '"ProjectTag"'
-- (with quotes), matches nothing in information_schema, and ships with RLS
-- silently off -- no error, no notice (D-064).
--
-- This enables RLS but does NOT create a policy. RLS with no policy denies all
-- rows to makrai_app, which is the safe direction, but the new table will read
-- empty with no visible cause -- and `prisma migrate deploy` does not surface
-- server NOTICEs. Add an org_isolation policy for any new tenant table.
--
-- Documented limits: binds only tables created AFTER installation, and does not
-- fire on ALTER TABLE ... ADD COLUMN "orgId" (which is exactly how the existing
-- tables were ported). Task 6's T1 enumeration test is the backstop for both.
CREATE OR REPLACE FUNCTION enforce_rls_on_tenant_tables()
RETURNS event_trigger LANGUAGE plpgsql AS $$
DECLARE
  obj record;
  has_org_id boolean;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
  WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public' AND object_type = 'table'
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = obj.objid AND attname = 'orgId'
        AND attnum > 0 AND NOT attisdropped
    ) INTO has_org_id;

    IF has_org_id THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
      EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',  obj.object_identity);
      RAISE NOTICE 'RLS auto-enabled on tenant table % (no policy created — add org_isolation)',
        obj.object_identity;
    END IF;
  END LOOP;
END $$;

DROP EVENT TRIGGER IF EXISTS trg_enforce_rls_on_tenant_tables;
CREATE EVENT TRIGGER trg_enforce_rls_on_tenant_tables
  ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
  EXECUTE FUNCTION enforce_rls_on_tenant_tables();
```

- [ ] **Step 3: Apply to both databases**

```bash
npx prisma migrate deploy
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" npx prisma migrate deploy
```

- [ ] **Step 4: Confirm the state landed — query the catalog, not the exit code**

```bash
for DB in makrai makrai_test; do
  echo "--- $DB"
  docker exec docker-postgres-1 psql -U makrai -d $DB -Atc \
    "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attname='orgId'
                     AND a.attnum > 0 AND NOT a.attisdropped)
     ORDER BY 1;"
done
```

Expected: **six** rows per database, each `t|t|1`.

- [ ] **Step 5: Prove the event trigger fires — and use a mixed-case name**

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c \
  'CREATE TABLE "ProjectTag" (id text PRIMARY KEY, "orgId" text NOT NULL);'
docker exec docker-postgres-1 psql -U makrai -d makrai_test -Atc \
  "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='ProjectTag';"
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c 'DROP TABLE "ProjectTag";'
```

Expected: `t|t`. The name is mixed-case **on purpose** — a `split_part`-based lookup silently fails on exactly this input, so a lowercase probe would pass while the guard was broken.

- [ ] **Step 6: Prove the policy isolates, as the restricted role**

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test <<'SQL'
BEGIN;
INSERT INTO users (id,email,name,"passwordHash","updatedAt") VALUES ('u1','a@x.org','a','x',now());
INSERT INTO organizations (id,name,slug,"updatedAt") VALUES ('orgA','A','a',now()),('orgB','B','b',now());
INSERT INTO projects (id,"orgId",name,"createdById","updatedAt") VALUES
  ('pA','orgA','A proj','u1',now()), ('pB','orgB','B proj','u1',now());
SET ROLE makrai_app;
SELECT 'no-guc (expect 0): '||count(*) FROM projects;
SELECT set_config('app.current_org_id','orgA',true);
SELECT 'scoped (expect pA): '||string_agg(id,',') FROM projects;
SELECT 'cross-org by pk (expect 0): '||count(*) FROM projects WHERE id='pB';
ROLLBACK;
SQL
```

Expected: `0`, `pA`, `0`. Run in a rolled-back transaction so the test database is left untouched.

- [ ] **Step 7: Commit**

```bash
git add prisma/migrations/ docs/DEFERRED_REGISTER.md
git commit -m "feat(tenancy): RLS policies, FORCE, and a DDL event trigger

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Structural guard tests and the isolation proof

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
  return { user, org, project };
}

describe('T1 — every table with an orgId column has RLS enabled AND forced', () => {
  it('finds no unprotected tenant table', async () => {
    const unprotected = await testDb.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'orgId'
                      AND a.attnum > 0 AND NOT a.attisdropped)
        AND (c.relrowsecurity = false OR c.relforcerowsecurity = false)`;
    expect(unprotected).toEqual([]);
  });
});

describe('T2 — RLS fails closed', () => {
  beforeEach(resetDb);
  it('returns zero rows, without throwing, when no org context is set', async () => {
    const a = await seed('t2-fc');
    expect(a.project.id).toBeTruthy();
    const { appClient } = await import('../../lib/data/tenant');
    const rows = await appClient.project.findMany();   // no withOrg wrapper
    expect(rows).toEqual([]);
  });
});

describe('isolation through withOrg, end to end', () => {
  beforeEach(resetDb);

  it('sees only the active org', async () => {
    const a = await seed('iso-a');
    await seed('iso-b');
    const rows = await withOrg({ orgId: a.org.id, role: 'admin' }, (tx) => tx.project.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('iso-a project');
  });

  it('cannot read another org even by primary key', async () => {
    const a = await seed('iso-c');
    const b = await seed('iso-d');
    const found = await withOrg({ orgId: a.org.id, role: 'admin' },
      (tx) => tx.project.findUnique({ where: { id: b.project.id } }));
    expect(found).toBeNull();
  });

  it('refuses a cross-org write via WITH CHECK', async () => {
    const a = await seed('iso-e');
    const b = await seed('iso-f');
    await expect(
      withOrg({ orgId: a.org.id, role: 'admin' }, (tx) =>
        tx.project.create({
          data: { orgId: b.org.id, name: 'smuggled', createdById: a.user.id },
        })),
    ).rejects.toThrow(/row-level security/i);
  });

  it('hides a membership belonging to another org', async () => {
    const a = await seed('iso-g');
    const b = await seed('iso-h');
    await testDb.membership.create({ data: { orgId: a.org.id, userId: a.user.id, role: 'owner' } });
    await testDb.membership.create({ data: { orgId: b.org.id, userId: a.user.id, role: 'viewer' } });
    const rows = await withOrg({ orgId: a.org.id, role: 'admin' },
      (tx) => tx.membership.findMany({ where: { userId: a.user.id } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(a.org.id);
  });
});

describe('T4 — composite same-org FK blocks cross-tenant references', () => {
  beforeEach(resetDb);
  it('refuses a remediation item attached to another org assessment', async () => {
    const a = await seed('t4-a');
    const b = await seed('t4-b');
    const asmt = await testDb.assessment.create({
      data: { orgId: b.org.id, projectId: b.project.id, userId: b.user.id, engineState: {} },
    });
    await expect(
      testDb.remediationItem.create({
        data: { orgId: a.org.id, assessmentId: asmt.id, areaId: 'PO-03',
                areaName: 'Accountability', tier: 'gap', description: 'cross-tenant' },
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});
```

> Both rejection tests assert on the **specific** error. A bare `.rejects.toThrow()` passes on any error — including one thrown for entirely the wrong reason — and a guard test that can pass for the wrong reason is the failure mode these tests exist to prevent.

- [ ] **Step 2: Run — expect all pass**

Run: `npx vitest run __tests__/integration/isolation.test.ts`

- [ ] **Step 3: Prove T1 is non-vacuous**

The event trigger now auto-protects new tables, so bypass it deliberately:

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c \
  'CREATE TABLE "leaky" (id text PRIMARY KEY, "orgId" text NOT NULL);
   ALTER TABLE "leaky" NO FORCE ROW LEVEL SECURITY;
   ALTER TABLE "leaky" DISABLE ROW LEVEL SECURITY;'
npx vitest run __tests__/integration/isolation.test.ts
```

Expected: **T1 FAILS**, naming `leaky`. Then clean up and re-run:

```bash
docker exec docker-postgres-1 psql -U makrai -d makrai_test -c 'DROP TABLE "leaky";'
npx vitest run
```

Expected: full suite green at **175 passing** (168 + 7 in `isolation.test.ts`: T1, T2, four end-to-end isolation cases, and T4).

- [ ] **Step 4: Commit**

```bash
git add __tests__/integration/isolation.test.ts
git commit -m "test(tenancy): structural guards T1/T2/T4 and end-to-end isolation proof

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Reconcile the register

**Files:**
- Modify: `docs/DEFERRED_REGISTER.md`

- [ ] **Step 1: Close what this plan discharged, re-target what it did not**

Set **D-005** (RLS fallback) to `Closed-done`, citing the spike and the Task 5/6 commits. Re-evaluate **D-055 through D-062**: each was opened by the rolled-back attempt and describes a consequence of an implementation that no longer exists. For each, either re-open it against the new commits or close it noting the redo did not reproduce the condition. Do **not** carry them forward unexamined — that is the transcription error rule 8 forbids.

Confirm **D-063**'s pick-up condition is satisfied: every task entry in the SDD ledger names the skills invoked before implementation. If any task names none, say so plainly rather than closing the row.

State plainly in the closure log that verification is **integration-level, not live in a browser** — AGENTS.md rule 2 is satisfied only by Plan 1b's E2E task.

- [ ] **Step 2: Commit**

```bash
git add docs/DEFERRED_REGISTER.md
git commit -m "docs(register): reconcile rows after the Phase 1a redo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Definition of done for Plan 1a

- `npx vitest run` green, including T1/T2/T4, the RBAC matrix, and the preauth surface pin.
- T1 demonstrated non-vacuous (Task 6 Step 3 went red against `leaky`).
- The event trigger demonstrated against a **mixed-case** table name (Task 5 Step 5).
- The `resetDb` guard demonstrated firing against a non-test database (Task 1 Step 8).
- The ESLint ban demonstrated firing on a new file (Task 4 Step 8), with `npm run lint` at **0 errors**.
- `npx tsc --noEmit` reports **exactly 3 errors, and only these** — `orgId` missing on create in `app/api/projects/route.ts`, `app/api/assessments/route.ts`, `app/api/assessments/[id]/remediation/route.ts`. Intended consequence of `NOT NULL orgId`; ported in Plan 1b; **must not be suppressed**. A fourth error is a failure of this plan.
- `git status --porcelain --untracked-files=all` is empty. Untracked files never reach a reviewer (AGENTS.md rule 9c).
- Every task entry in the SDD ledger names the skills invoked before implementation (rule 1; audited by D-063).
- **Not done:** nothing here has been driven through a browser. Isolation is proven at the database and data-layer level only. Plan 1b carries the live-verification bar (AGENTS.md rule 2).
