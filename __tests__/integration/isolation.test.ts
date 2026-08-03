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

describe('T1 — every tenant table has RLS enabled AND forced', () => {
  it('finds no unprotected table carrying an orgId column', async () => {
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

  /**
   * The behavioural half of D-062's closure. Before Task 5, organizations had no
   * policy, so this query returned every organization on the platform.
   */
  it('shows only the active organization, not every tenant on the platform', async () => {
    const a = await seed('iso-i');
    await seed('iso-j');
    const orgs = await withOrg({ orgId: a.org.id, role: 'admin' },
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
