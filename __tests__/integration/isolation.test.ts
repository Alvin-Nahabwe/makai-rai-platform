import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { withOrg, type OrgContext } from '../../lib/data/tenant';

// See tenant-layer.test.ts's identical helper for why this cast, not
// createOrgContext, is the right escape hatch here (Task 5, D-089).
function ctx(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

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

describe('T1 — every tenant table has RLS enabled AND forced', () => {
  /**
   * The policy predicate is not decoration. Enabling RLS without creating a
   * policy denies all rows — safe, but it is the exact state the DDL event
   * trigger produces for a new tenant table, and the previous version of this
   * test could not see it: the trigger sets relrowsecurity AND
   * relforcerowsecurity to true, so both original disjuncts were satisfied and
   * T1 returned green while the table read empty for every user in every org,
   * with the trigger's RAISE NOTICE surfaced nowhere.
   *
   * It also could not see a DROPPED policy. `org_isolation` exists on seven
   * tables but only two (`projects`, `memberships`) are covered behaviourally
   * elsewhere; dropping it from `assessments` left the whole suite green while
   * every assessment read through withOrg silently returned zero rows.
   */
  it('finds no orgId table that is unprotected OR missing its org_isolation policy', async () => {
    const unprotected = await testDb.$queryRaw<{ relname: string; why: string }[]>`
      SELECT c.relname,
             CASE WHEN NOT c.relrowsecurity      THEN 'rls not enabled'
                  WHEN NOT c.relforcerowsecurity THEN 'rls not forced'
                  ELSE 'no org_isolation policy' END AS why
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'orgId'
                      AND a.attnum > 0 AND NOT a.attisdropped)
        AND (c.relrowsecurity = false
             OR c.relforcerowsecurity = false
             OR NOT EXISTS (SELECT 1 FROM pg_policies p
                            WHERE p.schemaname = 'public'
                              AND p.tablename = c.relname
                              AND p.policyname = 'org_isolation'))`;
    expect(unprotected).toEqual([]);
  });

  /**
   * `expect(unprotected).toEqual([])` above is also satisfied by a query that
   * matches nothing at all — an unmigrated or empty schema passes it happily.
   * This asserts the population is the one we expect, so T1 cannot be green by
   * virtue of finding no tables to check.
   */
  /**
   * Existence is not isolation. An adversarial review replaced
   * `invitations.org_isolation` with `FOR ALL USING (true) WITH CHECK (true)` —
   * every assertion above still passed, the full suite went green, and a live
   * invitation token was readable from another organization. A policy that is
   * `FOR SELECT` only, or scoped `TO` a role that is not the app role, or whose
   * predicate is simply wrong, was equally invisible.
   *
   * So assert the predicate itself. All seven policies are byte-identical today
   * apart from the keyed column (`"orgId"` on the six tenant tables, `id` on
   * `organizations`, which IS the tenant), which makes this cheap and exact.
   */
  it('requires every org_isolation policy to actually isolate, not merely exist', async () => {
    const policies = await testDb.$queryRaw<
      { tablename: string; cmd: string; roles: string; qual: string; with_check: string }[]
    >`
      SELECT tablename, cmd, roles::text AS roles,
             coalesce(qual, 'NULL') AS qual,
             coalesce(with_check, 'NULL') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND policyname = 'org_isolation'
      ORDER BY tablename`;

    expect(policies).toHaveLength(7);
    const guc = `NULLIF(current_setting('app.current_org_id'::text, true), ''::text)`;
    for (const p of policies) {
      const column = p.tablename === 'organizations' ? 'id' : '"orgId"';
      const expected = `(${column} = ${guc})`;
      expect(`${p.tablename}:${p.cmd}`).toBe(`${p.tablename}:ALL`);
      expect(`${p.tablename}:${p.roles}`).toBe(`${p.tablename}:{public}`);
      expect(`${p.tablename}:${p.qual}`).toBe(`${p.tablename}:${expected}`);
      expect(`${p.tablename}:${p.with_check}`).toBe(`${p.tablename}:${expected}`);
    }
  });

  it('protects exactly the six orgId-bearing tables, so T1 cannot pass vacuously', async () => {
    const rows = await testDb.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
        AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'orgId'
                      AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY 1`;
    expect(rows.map((r) => r.relname)).toEqual([
      'assessments',
      'invitations',
      'memberships',
      'project_metadata',
      'projects',
      'remediation_items',
    ]);
  });

  /**
   * organizations is invisible to the query above and always will be: it has no
   * orgId column because it IS the tenant. Task 5 protected it with a policy
   * keyed on "id" (closing D-062) and named this test as the carried-forward
   * obligation. Without it, dropping that policy leaves the whole suite green.
   */
  it('protects organizations, which no orgId enumeration can ever reach', async () => {
    const [row] = await testDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean; policies: bigint }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policies p
               WHERE p.schemaname = 'public' AND p.tablename = 'organizations') AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'organizations'`;
    expect(row.relrowsecurity).toBe(true);
    expect(row.relforcerowsecurity).toBe(true);
    expect(Number(row.policies)).toBe(1);
  });

  /**
   * T1 above is a snapshot of tables that exist NOW. The event trigger is what
   * protects tables created LATER, and nothing else in this suite would notice
   * if it were dropped. All three tags are load-bearing: CREATE TABLE AS and
   * SELECT INTO raise different command_tags from CREATE TABLE, and a trigger
   * bound to only the first lets a tenant table ship with RLS silently off.
   *
   * evtenabled is pinned too, and is an addition to the plan's Step 1 code:
   * `ALTER EVENT TRIGGER ... DISABLE` leaves the pg_event_trigger row (and its
   * tags) fully intact while the guard stops firing, so existence + tags alone
   * is a check that passes while the thing it guards is off. evtenabled is
   * cast to text because it is Postgres's internal "char" type.
   */
  /**
   * A VIEW over a tenant table bypassed RLS completely, and every control on
   * this branch missed it. The table guard filters `object_type = 'table'`, so
   * `CREATE VIEW` skipped it; `ALTER DEFAULT PRIVILEGES ... ON TABLES` covers
   * views, so `makrai_app` was auto-granted; and because the view is owned by
   * the superuser and `security_invoker` defaults to false, the base table's RLS
   * was evaluated with the OWNER's rights. Verified before the fix: as
   * `makrai_app` with no org context, `SELECT count(*) FROM projects` returned 0
   * while the same query through a view returned 2 rows across two orgs —
   * inverting the fail-closed property the whole architecture rests on.
   */
  it('refuses a view that would run with its owner rights, and permits a safe one', async () => {
    await expect(
      testDb.$executeRawUnsafe('CREATE VIEW zz_unsafe AS SELECT id FROM projects'),
    ).rejects.toThrow(/security_invoker/);

    await testDb.$executeRawUnsafe(
      'CREATE VIEW zz_safe WITH (security_invoker = true) AS SELECT id FROM projects',
    );
    const [{ ok }] = await testDb.$queryRaw<{ ok: boolean }[]>`
      SELECT 'security_invoker=true' = ANY(reloptions) AS ok
      FROM pg_class WHERE relname = 'zz_safe'`;
    expect(ok).toBe(true);
    await testDb.$executeRawUnsafe('DROP VIEW zz_safe');
  });

  it('no longer auto-grants makrai_app rights on relations nobody reviewed', async () => {
    const [{ has_default }] = await testDb.$queryRaw<{ has_default: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_default_acl d
        JOIN pg_namespace n ON n.oid = d.defaclnamespace
        WHERE n.nspname = 'public' AND d.defaclobjtype = 'r'
          AND array_to_string(d.defaclacl, ',') LIKE '%makrai_app%'
      ) AS has_default`;
    expect(has_default).toBe(false);
  });

  it('keeps the DDL guard installed and enabled, for all three table-creating tags', async () => {
    const [trg] = await testDb.$queryRaw<
      { evtname: string; evtenabled: string; evttags: string[] }[]
    >`
      SELECT evtname, evtenabled::text AS evtenabled, evttags FROM pg_event_trigger
      WHERE evtname = 'trg_enforce_rls_on_tenant_tables'`;
    expect(trg).toBeDefined();
    expect(trg.evtenabled).toBe('O');
    expect([...trg.evttags].sort()).toEqual(['CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO']);
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
    const rows = await withOrg(ctx(a.org.id, 'admin'), (tx) => tx.project.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('iso-a project');
  });

  it('cannot read another org even by primary key', async () => {
    const a = await seed('iso-c');
    const b = await seed('iso-d');
    const found = await withOrg(ctx(a.org.id, 'admin'),
      (tx) => tx.project.findUnique({ where: { id: b.project.id } }));
    expect(found).toBeNull();
  });

  it('refuses a cross-org write via WITH CHECK', async () => {
    const a = await seed('iso-e');
    const b = await seed('iso-f');
    await expect(
      withOrg(ctx(a.org.id, 'admin'), (tx) =>
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
    const rows = await withOrg(ctx(a.org.id, 'admin'),
      (tx) => tx.membership.findMany({ where: { userId: a.user.id } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(a.org.id);
  });

  /**
   * The behavioural half of D-062's closure. Before Task 5, organizations had no
   * policy, so this query returned every organization on the platform.
   */
  it('shows only the active organization, not every tenant on the platform', async () => {
    const a = await seed('iso-i');
    await seed('iso-j');
    const orgs = await withOrg(ctx(a.org.id, 'admin'),
      (tx) => tx.organization.findMany());
    expect(orgs).toHaveLength(1);
    expect(orgs[0].id).toBe(a.org.id);
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
    ).rejects.toThrow(/foreign key/i);
  });
});
