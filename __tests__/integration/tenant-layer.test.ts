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
