import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import * as preauth from '../../lib/data/preauth';
import { identityDb } from '../../lib/data/identity';

/**
 * Both suites below pin defects found by the C6 whole-branch security review on
 * 2026-08-03 and reproduced live before they were fixed. Neither was caught by
 * the per-task threat passes, which is why they are pinned here rather than
 * trusted to review: both are fail-OPEN, and both live on the owner connection
 * where no database control exists to catch them.
 */

async function seedTwoOrgs() {
  const user = await testDb.user.create({
    data: { email: 'victim@x.org', name: 'victim', passwordHash: 'x' },
  });
  const a = await testDb.organization.create({ data: { name: 'A', slug: 'org-a' } });
  const b = await testDb.organization.create({ data: { name: 'B', slug: 'org-b' } });
  await testDb.membership.create({ data: { orgId: a.id, userId: user.id, role: 'owner' } });
  await testDb.membership.create({ data: { orgId: b.id, userId: user.id, role: 'admin' } });
  await testDb.project.create({ data: { orgId: a.id, name: 'A proj', createdById: user.id } });
  await testDb.invitation.create({
    data: {
      orgId: a.id, email: 'invitee@x.org', role: 'owner', token: 'secret-token-a',
      invitedById: user.id, expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return { user, a, b };
}

/**
 * Prisma DROPS a `where` key whose value is `undefined` rather than rejecting it
 * — strictUndefinedChecks is a preview feature and the schema enables no preview
 * features. On preauth, which runs as SUPERUSER/BYPASSRLS, that turned a missing
 * argument into "any row on the platform". Before the fix,
 * invitationByToken(undefined) returned a live pending invitation including its
 * token and an `owner` role.
 *
 * The declared parameter types say `string`, so these casts are not paranoia:
 * they reproduce exactly what a route handler does when it reads
 * `await req.json()` (typed `any`) and the field is absent.
 */
describe('preauth rejects a missing lookup key instead of matching every row', () => {
  beforeEach(resetDb);

  it('invitationByToken(undefined) returns null, not someone else\'s live invitation', async () => {
    await seedTwoOrgs();
    expect(await preauth.invitationByToken(undefined as unknown as string)).toBeNull();
  });

  it('orgBySlug(undefined) returns null, not an arbitrary tenant', async () => {
    await seedTwoOrgs();
    expect(await preauth.orgBySlug(undefined as unknown as string)).toBeNull();
  });

  it('membershipsForUser(undefined) returns [], not the platform membership graph', async () => {
    await seedTwoOrgs();
    expect(await preauth.membershipsForUser(undefined as unknown as string)).toEqual([]);
  });

  it('rejects the empty string too, which Prisma would treat as a real key', async () => {
    await seedTwoOrgs();
    expect(await preauth.invitationByToken('')).toBeNull();
    expect(await preauth.orgBySlug('')).toBeNull();
    expect(await preauth.membershipsForUser('')).toEqual([]);
  });

  it('still returns the real row for a valid key — the guard is not a blanket deny', async () => {
    await seedTwoOrgs();
    const inv = await preauth.invitationByToken('secret-token-a');
    expect(inv).not.toBeNull();
    expect(await preauth.orgBySlug('org-a')).not.toBeNull();
  });
});

/**
 * Pick<PrismaClient,'user'> hands over the WHOLE user delegate, and User has
 * relations to five tenant models. Before the fix, an `include` reached other
 * organizations' projects, the full membership graph and live invitation tokens
 * over the BYPASSRLS owner connection — type-checking cleanly, passing lint, and
 * passing every RLS test, because it never touches makrai_app.
 */
/**
 * These attack the CLASS, not the instances.
 *
 * The previous version of this suite pinned four shapes, all of which named a
 * tenant relation as a direct child of `include`/`data`. It passed — and the
 * guard was bypassed by nested `include`, `where: { OR: [...] }`, `_count`,
 * array `orderBy`, and `upsert`'s `create`/`update` clauses, every one of which
 * was reproduced live against the owner connection. Four independent reviewers
 * found this. The lesson is not "add four more cases": it is that a guard test
 * must probe the shape space, so each case below is a different *traversal*
 * rather than a different relation name.
 */
describe('identityDb refuses to traverse into tenant data, at any depth or shape', () => {
  beforeEach(resetDb);

  it('rejects a direct include', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ include: { memberships: true } } as never),
    ).rejects.toThrow(/tenant data and this client bypasses RLS/);
  });

  it('rejects a relation reached by NESTING through an allowed relation', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.consentRecord.findMany({
        include: { user: { include: { memberships: { include: { org: true } } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation hidden inside a where ARRAY combinator', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({
        where: { OR: [{ memberships: { some: { role: 'owner' } } }] },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation counted through _count', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({
        select: { id: true, _count: { select: { projects: true } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a relation in the ARRAY form of orderBy', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ orderBy: [{ memberships: { _count: 'desc' } }] } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects nested writes via update AND via upsert create/update clauses', async () => {
    const { user, b } = await seedTwoOrgs();
    await expect(
      identityDb.user.update({
        where: { id: user.id },
        data: { memberships: { updateMany: { where: {}, data: { role: 'viewer' } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
    await expect(
      identityDb.user.upsert({
        where: { email: 'attacker@x.org' },
        create: {
          email: 'attacker@x.org', name: 'a', passwordHash: 'x',
          memberships: { create: { orgId: b.id, role: 'owner' } },
        },
        update: { memberships: { updateMany: { where: {}, data: { role: 'viewer' } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('is narrowed at RUNTIME, not only in the type', async () => {
    const escape = identityDb as unknown as Record<string, unknown>;
    expect(() => escape.project).toThrow(/not part of the identity surface/);
    expect(() => escape.$queryRawUnsafe).toThrow(/not part of the identity surface/);
    expect(() => escape.$transaction).toThrow(/not part of the identity surface/);
  });

  it('still serves plain identity reads — the guard is not a blanket deny', async () => {
    await seedTwoOrgs();
    const users = await identityDb.user.findMany({ where: { email: 'victim@x.org' } });
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('victim@x.org');
    const withCounts = await identityDb.user.findMany({
      select: { id: true, _count: { select: { consentRecords: true } } },
    } as never);
    expect(withCounts).toHaveLength(1);
  });
});

describe('withOrg refuses a missing org id instead of silently returning nothing', () => {
  beforeEach(resetDb);

  it('throws on an empty orgId rather than rendering an empty organization', async () => {
    const { withOrg } = await import('../../lib/data/tenant');
    await expect(
      withOrg({ orgId: '', role: 'admin' }, async (tx) => tx.project.findMany()),
    ).rejects.toThrow(/caller bug, not an empty organization/);
    await expect(
      withOrg({ orgId: undefined as unknown as string, role: 'admin' }, async (tx) =>
        tx.project.findMany()),
    ).rejects.toThrow(/caller bug/);
  });
});
