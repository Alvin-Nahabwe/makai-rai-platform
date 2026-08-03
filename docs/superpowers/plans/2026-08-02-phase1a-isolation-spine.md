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

-- Projects are the root of the same-org chain and take the legacy org directly.
-- Everything below DERIVES from its parent rather than repeating the constant:
-- the composite FKs require child.orgId = parent.orgId, and a flat default
-- cannot guarantee that for a row already carrying a different non-NULL orgId
-- from the earlier "multi-tenancy prep" columns. Derivation is unconditional so
-- it repairs such divergence instead of letting the FK abort the migration.
UPDATE "projects" SET "orgId" = '00000000-0000-0000-0000-000000000001' WHERE "orgId" IS NULL;
UPDATE "assessments" a SET "orgId" = p."orgId" FROM "projects" p WHERE a."projectId" = p."id";

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
- Create: `scripts/provision-app-db-role.sh`
- Create: `lib/data/tenant.ts`, `lib/data/identity.ts`, `lib/data/preauth.ts`
- Create: `__tests__/integration/tenant-layer.test.ts`, `__tests__/integration/preauth-surface.test.ts`
- Modify: `eslint.config.mjs`, `.env`, `.env.example`, `package.json`

**Interfaces:**
- Consumes: `can`/`Action` (Task 3); tenant tables (Task 2)
- Produces: `type OrgContext = { orgId: string; role: OrgRole }`; `withOrg<T>(ctx, cb)`; `assertCan(ctx, action)`; `ForbiddenError`; `appClient`; `identityDb`; `membershipsForUser`, `orgBySlug`, `invitationByToken`.

### Corrections applied 2026-08-03 at the C1 threat pass — read before executing

The first draft of this task carried nine defects. They are fixed in the steps below; this
table exists so the *reasons* survive, and so nobody "simplifies" a fix back into a defect.

| # | Defect in the first draft | Fix | Evidence |
|---|---|---|---|
| P4-1 | `ALTER ROLE … WITH PASSWORD 'app_dev_password'` in a **committed migration**. Migrations run in every environment, so production's app-role password would be a value published in git | Migration creates the role and grants **without** a password; `scripts/provision-app-db-role.sh` sets it per environment | The rolled-back attempt did exactly this (§7.4 harvest); `.env` still references the script it deleted |
| P4-2 | ESLint ban used `paths: [{name:'@/lib/db'}]`, which matches the **literal specifier only**. `import … from '../../lib/db'` and `'./db'` bypass it silently — so the structural guard had a one-keystroke escape | Use `patterns.group` covering `@/lib/db`, `**/lib/db`, `./db`, `../db` | Proven live 2026-08-03: alias flagged, both relative forms **not** flagged; after the fix all three flagged, decoys `@/lib/data/tenant` and `./dbutils` correctly ignored |
| P4-3 | Allowlist claimed 22 entries; `grep -rl "from '@/lib/db'"` returns **20**. `lib/auth.ts` and `lib/authz.ts` import `'./db'`, which the old rule could never have flagged | 22 is correct only *after* P4-2. Enumerate live before pasting | Live grep 2026-08-03 |
| P4-4 | `Omit<PrismaClient, …7 models>` does not close the identity boundary: `$queryRaw*`/`$executeRaw*` survive it, and `$transaction`'s handle is typed with the **full** model set, so `identityDb.$transaction(tx => tx.project.findMany())` compiles and leaks on the SUPERUSER connection | Invert to an allowlist: `Pick<PrismaClient, 'user' \| 'consentRecord'>`. Also fails **closed** for models Plan 1b adds | tsc probes required in Step 6 |
| P4-5 | The GUC-residue test queried `appClient` post-transaction on a default pool, so it could land on a different backend and **pass trivially** — passing even if `is_local` were `false`, the one thing it exists to disprove | Assert `pg_backend_pid()` equality first, then `<unset>`. Prove non-vacuous by flipping `true`→`false` and observing failure | Red-green evidence required in the report |
| P4-6 | No test that `set_config` is parameterised | Hostile-orgId test asserting the GUC holds the literal string | — |
| P4-7 | `GRANT … ON ALL TABLES` handed `makrai_app` full DML on `_prisma_migrations` (rewrite migration history) and on `users` (read/write **every** `passwordHash`, with no RLS to stop it) | `REVOKE ALL` on `_prisma_migrations`, `users`, `consent_records`. Nothing in Plan 1a uses them via the app role | Verified: `identityDb` and `preauth` both use the owner connection |
| P4-8 | Brief re-introduced the exact ungarded clients that **D-060 is already open about** — deferring a 4-line fix while authoring the file is the D-068 laundering pattern | `globalForPrisma` HMR guard on all three clients now; close D-060 | `lib/db.ts:5-17` is the existing pattern |
| P4-9 | `invitationByToken` returned invitations regardless of `status`/`expiresAt`, both of which exist in the schema | Filter to pending + unexpired — fail closed | `prisma/schema.prisma` Invitation model |

**Checked and found NOT to be a problem — recorded so nobody later "fixes" it:** no
`GRANT USAGE ON SEQUENCES` is needed. `SELECT count(*) FROM information_schema.sequences
WHERE sequence_schema='public'` returns **0** (all ids are app-side uuid). Queried live,
not assumed.

**Already present, do not re-add:** `vitest.config.ts` already sets `APP_DATABASE_URL` to
`postgresql://makrai_app:app_dev_password@localhost:5432/makrai_test`, and `.env` already
has an `APP_DATABASE_URL` line. `.env.example` does **not**. `.env` also carries two stale
lines from the rolled-back attempt (`APP_DB_PASSWORD`, and a comment citing migration
`20260802154119_add_restricted_app_role`) that reference files which no longer exist —
Step 1 cleans them.

- [ ] **Step 1: Create the restricted role (no password in the migration)**

Hand-write `prisma/migrations/<ts>_add_restricted_app_role/migration.sql`:

```sql
-- The application connects as this role. It is NOT the table owner and has
-- NOBYPASSRLS, so Task 5's policies actually constrain it. Containing the
-- superuser owner (makrai) is role separation, not something RLS can do:
-- superusers bypass RLS unconditionally and FORCE does not apply to them.
--
-- NO PASSWORD IS SET HERE. Migrations run in every environment, so a literal
-- here would publish production's app-role credential in git. The password is
-- provisioned per environment by scripts/provision-app-db-role.sh.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'makrai_app') THEN
    CREATE ROLE makrai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

-- Idempotent even if the role pre-existed from an earlier attempt.
ALTER ROLE makrai_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO makrai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO makrai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO makrai_app;

-- Least privilege. The blanket grant above is convenient but over-broad:
--   _prisma_migrations : an app-role compromise could rewrite migration history
--   users              : holds passwordHash, and will carry NO RLS policy, so
--                        the app role could read or overwrite every credential
--   consent_records    : non-tenant identity data, served by identityDb (owner)
-- Nothing in Plan 1a reaches these through makrai_app. Plan 1b grants back
-- deliberately, column-by-column, if the identity path moves to this role.
REVOKE ALL ON "_prisma_migrations" FROM makrai_app;
REVOKE ALL ON "users"              FROM makrai_app;
REVOKE ALL ON "consent_records"    FROM makrai_app;
```

Create `scripts/provision-app-db-role.sh` (mark executable):

```bash
#!/usr/bin/env bash
# Sets the makrai_app password. Deliberately NOT a migration: migrations are
# committed and run in every environment, so a password in one would publish
# production's app credential. Run this after `prisma migrate deploy`.
#
#   APP_DB_PASSWORD=<secret> scripts/provision-app-db-role.sh <database>
#
# Local dev/test default is the well-known 'app_dev_password', which matches
# vitest.config.ts. That default is refused when NODE_ENV=production.
set -euo pipefail

DB="${1:?usage: provision-app-db-role.sh <database>}"

if [ -z "${APP_DB_PASSWORD:-}" ]; then
  if [ "${NODE_ENV:-development}" = "production" ]; then
    echo "refusing to use the dev default password in production; set APP_DB_PASSWORD" >&2
    exit 1
  fi
  APP_DB_PASSWORD='app_dev_password'
  echo "APP_DB_PASSWORD unset — using the local dev default for '$DB'" >&2
fi

docker exec -i docker-postgres-1 psql -v ON_ERROR_STOP=1 -U makrai -d "$DB" \
  -v pw="$APP_DB_PASSWORD" \
  -c "ALTER ROLE makrai_app WITH PASSWORD :'pw';"

echo "makrai_app password provisioned on '$DB'"
```

Note `-v pw=… :'pw'` — psql quotes the variable, so a password containing a quote cannot
break out of the statement. Do not build the SQL by string interpolation.

Apply to both databases, then provision:

```bash
npx prisma migrate deploy                              # dev db (DATABASE_URL)
DATABASE_URL="postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test" \
  npx prisma migrate deploy                            # test db
chmod +x scripts/provision-app-db-role.sh
scripts/provision-app-db-role.sh makrai
scripts/provision-app-db-role.sh makrai_test
```

Add a convenience entry to `package.json` scripts so the two-step is discoverable:

```json
"db:provision": "scripts/provision-app-db-role.sh makrai && scripts/provision-app-db-role.sh makrai_test"
```

Clean `.env`: delete the stale `APP_DB_PASSWORD` line and the comment citing
`prisma/migrations/20260802154119_add_restricted_app_role` (that directory does not exist —
rollback residue). Keep the existing `APP_DATABASE_URL`. Add to `.env.example`, which
currently lacks it:

```
# Restricted app role. Create with `prisma migrate deploy`, then `npm run db:provision`.
APP_DATABASE_URL="postgresql://makrai_app:app_dev_password@localhost:5432/makrai"
```

Verify — **all four must hold**:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test \
  -c "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname='makrai_app';" \
  -c "SELECT has_table_privilege('makrai_app','users','SELECT')          AS users_select;" \
  -c "SELECT has_table_privilege('makrai_app','_prisma_migrations','UPDATE') AS mig_update;" \
  -c "SELECT has_table_privilege('makrai_app','projects','INSERT')       AS projects_insert;"
```

Expected: `f | f | t`, `users_select = f`, `mig_update = f`, `projects_insert = t`.

Then prove the revoke does **not** break referential integrity — `projects.createdById`
references `users(id)`, and PostgreSQL runs RI checks with the constraint owner's
privileges, but that is a claim, so test it rather than trusting it:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test -c \
  "INSERT INTO users (id,email,name,\"passwordHash\",\"updatedAt\") VALUES ('u1','ri@x.org','ri','x',now());
   INSERT INTO organizations (id,name,slug,\"updatedAt\") VALUES ('o1','ri','ri-org',now());"
docker exec -e PGPASSWORD=app_dev_password -i docker-postgres-1 \
  psql -U makrai_app -d makrai_test -c \
  "INSERT INTO projects (id,\"orgId\",name,\"createdById\",\"updatedAt\") VALUES ('p1','o1','ri proj','u1',now());"
```

Expected: the INSERT **succeeds** despite `makrai_app` having no privilege on `users`. If
it fails, stop and report — the REVOKE on `users` must then be narrowed to a column-level
grant excluding `passwordHash` instead. Clean up the three rows afterwards.

- [ ] **Step 2: Write the failing tests**

Create `__tests__/integration/tenant-layer.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { withOrg, assertCan, appClient, ForbiddenError } from '../../lib/data/tenant';

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

  /**
   * The pid assertion is not decoration. Without it this test can be handed a
   * DIFFERENT pooled backend than the transaction used, in which case
   * '<unset>' is trivially true and the test passes even when set_config's
   * third argument is `false` — the single failure it exists to catch.
   */
  it('leaves no GUC residue on the same backend after the transaction ends', async () => {
    const a = await seed('tl-b');
    const inside = await withOrg({ orgId: a.org.id, role: 'admin' }, async (tx) => {
      const r = await tx.$queryRaw<{ pid: number; v: string }[]>`
        SELECT pg_backend_pid() AS pid, current_setting('app.current_org_id', true) AS v`;
      return r[0];
    });
    expect(inside.v).toBe(a.org.id);

    const [outside] = await appClient.$queryRaw<{ pid: number; v: string }[]>`
      SELECT pg_backend_pid() AS pid,
             COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), '<unset>') AS v`;
    expect(outside.pid).toBe(inside.pid);   // else the next assertion proves nothing
    expect(outside.v).toBe('<unset>');
  });

  it('stores a hostile orgId literally — set_config is parameterised', async () => {
    const hostile = "x', false); SELECT set_config('app.current_org_id', 'evil', false); --";
    const got = await withOrg({ orgId: hostile, role: 'admin' }, async (tx) => {
      const r = await tx.$queryRaw<{ v: string }[]>`
        SELECT current_setting('app.current_org_id', true) AS v`;
      return r[0].v;
    });
    expect(got).toBe(hostile);
  });

  it('writes tenant rows as makrai_app despite the REVOKE on users', async () => {
    const a = await seed('tl-c');
    const created = await withOrg({ orgId: a.org.id, role: 'admin' }, (tx) =>
      tx.project.create({
        data: { orgId: a.org.id, name: 'via withOrg', createdById: a.user.id },
      }),
    );
    expect(created.orgId).toBe(a.org.id);
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
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import * as preauth from '../../lib/data/preauth';

/**
 * preauth runs on the OWNER connection and is therefore not constrained by RLS.
 * That bypass is deliberate (ADR-0001) but must stay small and enumerable, so
 * this test pins the exported surface. Adding a function here is a decision,
 * not an accident — if this test fails, that is the point.
 *
 * Note the limit of the pin: it constrains the SURFACE, not the semantics. A
 * body can still be widened (an added `include:`) without failing this test.
 */
describe('preauth exported surface', () => {
  it('exports exactly the three sanctioned before-context reads', () => {
    expect(Object.keys(preauth).sort())
      .toEqual(['invitationByToken', 'membershipsForUser', 'orgBySlug']);
  });
});

describe('invitationByToken fails closed', () => {
  beforeEach(resetDb);

  async function makeInvite(token: string, over: Record<string, unknown>) {
    const inviter = await testDb.user.create({
      data: { email: `${token}@x.org`, name: token, passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: token, slug: token } });
    return testDb.invitation.create({
      data: {
        orgId: org.id, email: 'invitee@x.org', role: 'member', token,
        invitedById: inviter.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      },
    });
  }

  it('returns a pending, unexpired invitation', async () => {
    await makeInvite('good-token', {});
    expect(await preauth.invitationByToken('good-token')).not.toBeNull();
  });

  it('returns null for an expired invitation', async () => {
    await makeInvite('expired-token', { expiresAt: new Date(Date.now() - 1000) });
    expect(await preauth.invitationByToken('expired-token')).toBeNull();
  });

  it('returns null for an already-accepted invitation', async () => {
    await makeInvite('used-token', { status: 'accepted' });
    expect(await preauth.invitationByToken('used-token')).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run __tests__/integration/tenant-layer.test.ts __tests__/integration/preauth-surface.test.ts`
Expected: FAIL — the modules do not exist. Confirm the failure reason is the missing module,
not a typo: a test that fails for the wrong reason proves nothing.

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

/** Authorization only. Isolation is RLS's job (ADR-0001). Advisory: withOrg does
 *  not call this, so a caller that skips it gets full DML within its org. */
export function assertCan(ctx: OrgContext, action: Action): void {
  if (!can(ctx.role, action)) throw new ForbiddenError(action, ctx.role);
}

/**
 * Connects as makrai_app, which is NOBYPASSRLS — so an escaped query returns
 * nothing once Task 5's policies land.
 *
 * `max` is explicit: this process already runs a pool for lib/db.ts, and Plan 1b
 * adds identity and preauth pools. Four default pools would reserve 40 of the
 * server's 100 connections (max_connections verified live 2026-08-03).
 *
 * The globalThis guard mirrors lib/db.ts:5-17. Next.js dev HMR re-evaluates
 * modules, and without it every hot reload leaks a Pool until the server runs
 * out of connections. This closes D-060 rather than re-opening it.
 */
const globalForData = globalThis as unknown as { appClient?: PrismaClient };

function createAppClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.APP_DATABASE_URL, max: 10 }),
    ),
  });
}

export const appClient = globalForData.appClient ?? createAppClient();
if (process.env.NODE_ENV !== 'production') globalForData.appClient = appClient;

/**
 * The ONLY path to tenant data.
 *
 * Opens one interactive transaction, sets the org GUC that RLS reads, and hands
 * the caller the transaction handle. It performs NO filtering — RLS is the
 * authoritative tenant filter. Forgetting to use it fails CLOSED: with no GUC
 * set the policy matches nothing and queries return zero rows.
 *
 * WHAT THIS DOES NOT DO: it does not check that the caller may use ctx.orgId.
 * RLS gives isolation, not authorization — hand it an org the user does not
 * belong to and it will scope faithfully to that org. Establishing that the
 * orgId is legitimately the caller's is requireOrgContext's job (Plan 1b), and
 * D-069 records the specific trap: users.lastActiveOrgId is unconstrained and
 * may name an org the user was removed from.
 *
 * set_config(..., true) is transaction-scoped AND parameterised. Never
 * interpolate an org id into a SET LOCAL string (SET LOCAL cannot be
 * parameterised at all), and never pass `false` — a session-scoped setting
 * would survive on a pooled connection into the next request.
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
 * the enforcement point.
 *
 * It is an ALLOWLIST, not a denylist, and that is deliberate. `Omit<...>` of
 * the seven orgId-bearing models leaves three holes: $queryRaw* and
 * $executeRaw* survive it and reach any table; $transaction's handle is typed
 * with the FULL model set, so identityDb.$transaction(tx => tx.project...)
 * compiles; and any tenant model Plan 1b adds is admitted by default. Pick
 * closes all three, and fails CLOSED on models that do not exist yet — the
 * same reasoning ADR-0001 used to choose RLS over app-layer filtering.
 *
 * Adding a name here is a security decision. $transaction is withheld on
 * purpose: registration spans User and Membership, which straddles this
 * boundary, and Plan 1b must design that crossing rather than inherit it (D-061).
 */
type NonTenantClient = Pick<PrismaClient, 'user' | 'consentRecord'>;

const globalForIdentity = globalThis as unknown as { identityDb?: NonTenantClient };

function createIdentityClient(): NonTenantClient {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
    ),
  });
}

export const identityDb: NonTenantClient = globalForIdentity.identityDb ?? createIdentityClient();
if (process.env.NODE_ENV !== 'production') globalForIdentity.identityDb = identityDb;
```

Create `lib/data/preauth.ts`:

```ts
import {
  PrismaClient,
  type Membership,
  type Organization,
  type Invitation,
} from '@prisma/client';
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
 * will fail if the surface grows. The pin does not constrain what the existing
 * bodies return, so widening one (an added `include:`) is on the reviewer.
 */
const globalForPreauth = globalThis as unknown as { preauthClient?: PrismaClient };

function createOwnerClient() {
  return new PrismaClient({
    adapter: new PrismaPg(
      new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }),
    ),
  });
}

const ownerClient = globalForPreauth.preauthClient ?? createOwnerClient();
if (process.env.NODE_ENV !== 'production') globalForPreauth.preauthClient = ownerClient;

export function membershipsForUser(
  userId: string,
): Promise<(Membership & { org: Organization })[]> {
  return ownerClient.membership.findMany({
    where: { userId, status: 'active', org: { deletedAt: null } },
    include: { org: true },
  });
}

export function orgBySlug(slug: string): Promise<Organization | null> {
  return ownerClient.organization.findFirst({ where: { slug, deletedAt: null } });
}

/**
 * Fails closed: an expired or already-actioned invitation is indistinguishable
 * from a nonexistent one. The trade-off is deliberate — the caller cannot render
 * "your invitation expired" from this alone. Plan 1b adds a separate, explicitly
 * named lookup if that message is wanted, rather than every caller having to
 * remember the two checks.
 */
export function invitationByToken(token: string): Promise<Invitation | null> {
  return ownerClient.invitation.findFirst({
    where: { token, status: 'pending', expiresAt: { gt: new Date() } },
  });
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run`
Expected: **182 passing** — the 172 verified at baseline on 2026-08-03, plus 6 in
`tenant-layer.test.ts` (4 `withOrg` + 2 `assertCan`) and 4 in `preauth-surface.test.ts`
(1 surface pin + 3 fail-closed). If the count differs,
reconcile it before proceeding; do not adjust the expectation to match the output.

- [ ] **Step 6: Prove the identityDb boundary is real — four probes, not one**

For each line below, create a scratch file at the repo root containing it plus
`import { identityDb } from './lib/data/identity';`, run `npx tsc --noEmit`, and record the
exact error text. A boundary claimed but unproven is the failure mode this step exists for.

| Probe | Expected |
|---|---|
| `identityDb.project.findMany();` | `Property 'project' does not exist on type 'NonTenantClient'` |
| `identityDb.$queryRaw\`SELECT 1\`;` | `Property '$queryRaw' does not exist` |
| `identityDb.$transaction(async (tx) => tx.project.findMany());` | `Property '$transaction' does not exist` |
| `identityDb.user.findMany();` | **no error** — the allowlist must still permit what it exists to serve |

**Delete every scratch file**, then confirm `git status --porcelain --untracked-files=all`
is clean. An untracked file never reaches a reviewer, and this project has shipped that
exact residue before.

- [ ] **Step 7: Prove the residue test is non-vacuous (red-green)**

Change `set_config(..., true)` to `false` in `lib/data/tenant.ts`. Run
`npx vitest run __tests__/integration/tenant-layer.test.ts`. The residue test **must fail**.
Restore `true` and confirm it passes again. Quote both outputs in the report — a
guard test that has never been seen to fail is not evidence.

- [ ] **Step 8: Ban raw client imports outside `lib/data/`**

Enumerate the current call sites first — the tree may have moved, and the count below is
only correct for the pattern-based rule:

```bash
grep -rlE "from '(@/lib/db|\.\./+lib/db|\./db)'" app lib --include=*.ts --include=*.tsx | sort
```

Add to `eslint.config.mjs`:

```js
{
  files: ['app/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
  ignores: ['lib/data/**', 'lib/db.ts'],
  rules: {
    'no-restricted-imports': ['error', {
      // `patterns`, not `paths`. `paths` matches the literal specifier only, so
      // `../../lib/db` and `./db` walk straight through it — which is how
      // lib/auth.ts and lib/authz.ts evaded the first draft of this rule.
      patterns: [{
        group: ['@/lib/db', '**/lib/db', './db', '../db'],
        message: 'Tenant data goes through withOrg (lib/data/tenant.ts); non-tenant through identityDb (lib/data/identity.ts). See ADR-0001.',
      }],
    }],
  },
},
```

This flags **22 pre-existing imports** (20 files under `app/` using `@/lib/db`, plus
`lib/auth.ts` and `lib/authz.ts` using `./db`). **`npm run lint` is currently clean and
`npm run verify` chains lint → test → build**, so enabling the rule bare would leave
`verify` red for the whole of Plan 1b — and a permanently-red gate trains people to ignore it.

Add an **explicit, shrinking allowlist** immediately after the rule:

```js
{
  // Unported call sites still on the raw client, re-enumerated 2026-08-03.
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

Record the allowlist as a register row targeted at the Plan 1b port.

- [ ] **Step 9: Verify lint and the ban together — all three specifier forms**

```bash
npm run lint                      # expect 0 errors
```

Then prove the ban actually fires, for each form it must catch. Create one **new** file
under `app/api/` at a path not on the allowlist, containing in turn:

1. `import { prisma } from '@/lib/db';`
2. `import { prisma } from '../../lib/db';`

and one **new** file under `lib/` containing:

3. `import { prisma } from './db';`

Re-run `npm run lint` after each and confirm the error fires every time. Testing only form 1
would pass while the guard's real hole stayed open. Delete the probe files and confirm
`git status --porcelain --untracked-files=all` is clean.

- [ ] **Step 10: Register rows, then commit**

Add to `docs/DEFERRED_REGISTER.md`, **in this same commit** (§6):

- **Close D-060** — the HMR singleton guard is implemented on all three clients; cite the
  commit and state that it was verified by reading `lib/db.ts:5-17` and mirroring it.
- **New row** — the 22-entry ESLint allowlist, targeted at the Plan 1b port, with
  "the list reaches zero" as the pick-up condition.
- **New row** — `makrai_app` has no privilege on `users`/`consent_records`; Plan 1b must
  grant back deliberately (column-level, excluding `passwordHash`) if the identity path
  moves to the app role.
- **New row** — the app-role password is provisioned by a script with a well-known local
  default; production must set `APP_DB_PASSWORD`, and nothing yet enforces that it did.
- **Re-evaluate D-061** — `preauth.membershipsForUser` may already discharge it, since the
  before-context membership read now has a sanctioned home. Do not close it silently:
  state whether it is discharged or still open, and why.

```bash
git add lib/data/ __tests__/integration/ eslint.config.mjs prisma/migrations/ \
        scripts/provision-app-db-role.sh package.json .env.example docs/DEFERRED_REGISTER.md
git commit -m "feat(tenancy): withOrg data layer, identity and preauth paths, restricted role

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

Note `.env` is gitignored, so its cleanup is not committed — say so in the report rather
than letting a reviewer assume the stale lines are still there.

---

## Task 5: RLS policies, FORCE, and the DDL event trigger

**Files:**
- Create: `prisma/migrations/<ts>_enable_rls_and_guard_trigger/migration.sql`
- Modify: `docs/DEFERRED_REGISTER.md`

**Interfaces:**
- Consumes: tenant tables (Task 2), `makrai_app` (Task 4)
- Produces: RLS enabled and forced on the six `orgId`-bearing tables **and on `organizations`**; an event trigger that makes shipping an unprotected tenant table structurally impossible.

This migration changes no Prisma schema, so there is nothing to diff. Create the directory and write `migration.sql` by hand; do not run `migrate dev --create-only`.

### Corrections applied 2026-08-03 at the C1 threat pass — read before executing

| # | Defect in the first draft | Fix | Evidence |
|---|---|---|---|
| P5-1 | **The guard misses two of the three ways to create a table.** It fired `WHEN TAG IN ('CREATE TABLE')` and filtered `command_tag = 'CREATE TABLE'` again inside. A tenant table made with `CREATE TABLE … AS SELECT` or `SELECT … INTO` would ship with RLS **silently off** — the same failure class as the D-064 `split_part` fail-open this trigger exists to prevent | Fire on all three tags; filter on `object_type = 'table'` instead of re-checking the tag | Probed live 2026-08-03: the three statements raise `command_tag` = `CREATE TABLE`, `CREATE TABLE AS`, `SELECT INTO`, all with `object_type=table`. `CREATE INDEX` also arrives, with `object_type=index` — so the object_type filter is doing real work |
| P5-2 | **`organizations` was excluded on a rationale that has since expired.** D-062 argued slug→org resolution is "definitionally a before-context read", so no GUC could scope it. True — but Task 4's `preauth.ts` (which did not exist when D-062 was written) runs *every* before-context read on the **owner** connection, which bypasses RLS outright. A policy keyed on `id` therefore breaks nothing and closes a live cross-tenant read | Enable + force RLS on `organizations` with a policy on `id`; close D-062 | Verified live: `has_table_privilege('makrai_app','organizations','SELECT')` = **true** with no policy, so any authenticated user could list every organization through a careless `withOrg` query |
| P5-3 | Step 6 proved isolation via `SET ROLE makrai_app` inside a superuser session. Faithful for policy evaluation, but it is not the connection production uses and it silently skips authentication | Also run the proof over a **real** `makrai_app` connection | — |
| P5-4 | Nothing recorded that **the app role can re-point the GUC itself** | Documented in the migration and as a register row | Verified live: as `makrai_app`, `set_config('app.current_org_id','anything-it-likes',false)` succeeds and reads back |
| P5-5 | Step 4's policy count joined `pg_policies` on `tablename` only, ignoring schema | Add `p.schemaname = 'public'` | — |

**What P5-4 means, stated plainly because it bounds every claim this plan makes:** RLS contains a
*forgotten filter*. It does **not** contain *injected SQL* — `withOrg` must be able to set the GUC,
so any role that can run the app's queries can also re-point it. Parameterised queries remain
load-bearing, and "RLS is the authoritative tenant filter" must never be read as "SQL injection is
contained."

- [ ] **Step 1: Write the migration — seven tables**

```sql
-- Six orgId-bearing tables, not four: memberships and invitations also carry
-- orgId, and makrai_app holds SELECT on both. Task 6's T1 test enumerates every
-- table with an orgId column, and the event trigger below encodes the same rule
-- -- protect only four and the guard permanently contradicts the migration that
-- installed it.
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

-- organizations is the seventh, and it is keyed on "id" because it IS the
-- tenant -- it has no "orgId" column. D-062 originally deferred this on the
-- grounds that slug->org resolution is a before-context read no GUC can scope.
-- That was true when written and is no longer: Task 4's lib/data/preauth.ts
-- runs every before-context read (orgBySlug, membershipsForUser,
-- invitationByToken) on the OWNER connection, which bypasses RLS entirely. So
-- this policy constrains only withOrg/makrai_app, where scoping to the current
-- org is exactly right. Without it, `tx.organization.findMany()` through
-- withOrg lists every organization on the platform.
--
-- CONSEQUENCE, deliberate: creating an organization cannot go through withOrg,
-- because WITH CHECK requires id = the current GUC and a new org is not yet the
-- current org. Org creation is a before-context WRITE and needs a sanctioned
-- path in Plan 1b -- the same kind of forced checkpoint as D-061.
ALTER TABLE "organizations"     ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations"     FORCE  ROW LEVEL SECURITY;

-- NULLIF is mandatory: after a transaction-scoped set_config the GUC reads as
-- '' rather than being absent, and '' would otherwise be compared literally.
-- NULLIF turns it into NULL, which matches no row -- failing closed.
--
-- No ::uuid cast. "orgId" is a text column and Postgres has no text = uuid
-- operator, so the cast makes CREATE POLICY fail outright (D-064).
--
-- LIMIT OF THIS CONTROL, verified live 2026-08-03: makrai_app can call
-- set_config('app.current_org_id', ...) itself -- it must, because that is how
-- withOrg works. RLS therefore contains a FORGOTTEN FILTER, not INJECTED SQL.
-- Parameterised queries stay load-bearing (D-077).
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

-- Keyed on "id", not "orgId" -- see the note above.
DROP POLICY IF EXISTS org_isolation ON "organizations";
CREATE POLICY org_isolation ON "organizations"
  USING      ("id" = NULLIF(current_setting('app.current_org_id', true), ''))
  WITH CHECK ("id" = NULLIF(current_setting('app.current_org_id', true), ''));
```

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
-- THREE TAGS, not one. Verified live 2026-08-03 by an event-trigger probe:
--   CREATE TABLE t (...)            -> command_tag 'CREATE TABLE'
--   CREATE TABLE t AS SELECT ...    -> command_tag 'CREATE TABLE AS'
--   SELECT ... INTO t               -> command_tag 'SELECT INTO'
-- all three with object_type='table'. Firing only on the first would let a
-- tenant table created by the other two ship unprotected and silent -- the same
-- fail-open shape as D-064. We filter on object_type instead of re-checking the
-- tag, because CREATE INDEX also arrives here (object_type='index').
--
-- This enables RLS but does NOT create a policy. RLS with no policy denies all
-- rows to makrai_app, which is the safe direction, but the new table will read
-- empty with no visible cause -- and `prisma migrate deploy` does not surface
-- server NOTICEs. Add an org_isolation policy for any new tenant table.
--
-- The ALTER runs with the DDL executor's privileges, not the function owner's
-- (this is not SECURITY DEFINER). A non-owner creating a tenant table therefore
-- aborts its own CREATE. That is fail-closed, and intended.
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
  WHERE object_type = 'table' AND schema_name = 'public'
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
  ON ddl_command_end
  WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
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
  docker exec -i docker-postgres-1 psql -U makrai -d $DB -Atc \
    "SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
            (SELECT count(*) FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = c.relname)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r'
       AND (c.relname = 'organizations'
            OR EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname='orgId'
                         AND a.attnum > 0 AND NOT a.attisdropped))
     ORDER BY 1;"
done
```

Expected: **seven** rows per database, each `t|t|1` — the six orgId tables plus `organizations`.

- [ ] **Step 5: Prove the event trigger fires — mixed case AND all three creation forms**

A lowercase `CREATE TABLE` probe passes even when the guard is broken in two separate ways, so
probe the ways it actually breaks:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test <<'SQL'
CREATE TABLE "ProjectTag" (id text PRIMARY KEY, "orgId" text NOT NULL);
CREATE TABLE "ProjectTagCtas" AS SELECT 'x'::text AS id, 'o'::text AS "orgId";
SELECT 'y'::text AS id, 'o'::text AS "orgId" INTO "ProjectTagInto";
CREATE TABLE "ZzNoOrg" (id text PRIMARY KEY);
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relname IN ('ProjectTag','ProjectTagCtas','ProjectTagInto','ZzNoOrg')
 ORDER BY 1;
DROP TABLE "ProjectTag", "ProjectTagCtas", "ProjectTagInto", "ZzNoOrg";
SQL
```

Expected: the three `orgId`-bearing tables each `t|t`; **`ZzNoOrg` must be `f|f`** — that is the
negative control proving the guard discriminates rather than blanket-enabling. Mixed-case names
are deliberate: a `split_part`-based lookup fails on exactly this input.

- [ ] **Step 6: Prove the policy isolates — over a real `makrai_app` connection**

Seed as owner, then connect as the app role for real (not `SET ROLE`), because that is the
connection production uses and it also exercises authentication:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test <<'SQL'
INSERT INTO users (id,email,name,"passwordHash","updatedAt") VALUES ('u1','a@x.org','a','x',now());
INSERT INTO organizations (id,name,slug,"updatedAt") VALUES ('orgA','A','a',now()),('orgB','B','b',now());
INSERT INTO projects (id,"orgId",name,"createdById","updatedAt") VALUES
  ('pA','orgA','A proj','u1',now()), ('pB','orgB','B proj','u1',now());
SQL

docker exec -e PGPASSWORD=app_dev_password -i docker-postgres-1 \
  psql -U makrai_app -d makrai_test <<'SQL'
SELECT 'no-guc projects (expect 0): '||count(*) FROM projects;
SELECT 'no-guc organizations (expect 0): '||count(*) FROM organizations;
BEGIN;
SELECT set_config('app.current_org_id','orgA',true);
SELECT 'scoped (expect pA): '||coalesce(string_agg(id,','),'<none>') FROM projects;
SELECT 'cross-org by pk (expect 0): '||count(*) FROM projects WHERE id='pB';
SELECT 'orgs visible (expect orgA): '||coalesce(string_agg(id,','),'<none>') FROM organizations;
SELECT 'cross-org write blocked below';
INSERT INTO projects (id,"orgId",name,"createdById","updatedAt")
  VALUES ('pX','orgB','smuggled','u1',now());
COMMIT;
SQL

# cleanup, as owner
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test -c \
  "DELETE FROM projects WHERE id IN ('pA','pB','pX');
   DELETE FROM organizations WHERE id IN ('orgA','orgB');
   DELETE FROM users WHERE id='u1';"
```

Expected: `0`, `0`, `pA`, `0`, `orgA`, and the final INSERT **rejected** with
`new row violates row-level security policy for table "projects"`. That last one is the WITH CHECK
half — without it the policy would block reads while permitting cross-tenant writes.

Then confirm the owner is still exempt, so the seeding/reset paths keep working:

```bash
docker exec -i docker-postgres-1 psql -U makrai -d makrai_test -Atc \
  "SELECT 'owner sees all (expect >=0 rows, no error): '||count(*) FROM projects;"
```

- [ ] **Step 7: Run the suite — RLS must not break Task 4's tests**

```bash
npx vitest run
```

Expected: **182 passing**, unchanged. This is a real check, not a formality: `withOrg`'s insert
test now passes through `WITH CHECK`, and `resetDb()` truncates as owner. If anything fails,
the policy is wrong — do not adjust the tests to suit it.

- [ ] **Step 8: Register rows, then commit**

- **Close D-062** — `organizations` now carries RLS keyed on `id`; state that the event trigger
  and Task 6's T1 still cannot cover it (it has no `orgId`), so T1 must special-case it.
- **New row D-077** — RLS does not contain SQL injection: `makrai_app` can re-point
  `app.current_org_id` itself (verified live). Pick-up: any review of query construction on the
  tenant path.
- **New row** — org creation cannot go through `withOrg` now that `organizations` has WITH CHECK;
  Plan 1b needs a sanctioned before-context write path.

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
