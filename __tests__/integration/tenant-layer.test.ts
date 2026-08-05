import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { withOrg, assertCan, appClient, ForbiddenError, type OrgContext } from '../../lib/data/tenant';

/**
 * `OrgContext` is branded (Task 5, D-089) so a plain `{ orgId, role }`
 * literal no longer structurally satisfies it — only `createOrgContext`,
 * called solely by `requireOrgContext`, may mint one. This suite exercises
 * `withOrg`/`assertCan` directly, below the authorization layer, so it uses
 * the documented escape hatch instead: a deliberate `as OrgContext` cast,
 * exactly the "honest limit" the brand's own comment names — accidental
 * construction is what branding stops, not a cast a test writes on purpose.
 */
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

describe('withOrg', () => {
  beforeEach(resetDb);

  it('sets the org GUC inside the transaction', async () => {
    const a = await seed('tl-a');
    const got = await withOrg(ctx(a.org.id, 'admin'), async (tx) => {
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
    const inside = await withOrg(ctx(a.org.id, 'admin'), async (tx) => {
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
    const got = await withOrg(ctx(hostile, 'admin'), async (tx) => {
      const r = await tx.$queryRaw<{ v: string }[]>`
        SELECT current_setting('app.current_org_id', true) AS v`;
      return r[0].v;
    });
    expect(got).toBe(hostile);
  });

  it('writes tenant rows as makrai_app despite the REVOKE on users', async () => {
    const a = await seed('tl-c');
    const created = await withOrg(ctx(a.org.id, 'admin'), (tx) =>
      tx.project.create({
        data: { orgId: a.org.id, name: 'via withOrg', createdById: a.user.id },
      }),
    );
    expect(created.orgId).toBe(a.org.id);
  });
});

describe('assertCan', () => {
  it('throws ForbiddenError for a role without the capability', () => {
    expect(() => assertCan(ctx('x', 'viewer'), 'project:create'))
      .toThrow(ForbiddenError);
  });

  it('does not throw for a role with it', () => {
    expect(() => assertCan(ctx('x', 'admin'), 'project:create')).not.toThrow();
  });
});
