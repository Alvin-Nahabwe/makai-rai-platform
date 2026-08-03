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
describe('identityDb refuses to traverse into tenant data', () => {
  beforeEach(resetDb);

  it('rejects an include that reaches memberships', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ include: { memberships: true } } as never),
    ).rejects.toThrow(/tenant data and this client bypasses RLS/);
  });

  it('rejects an include that reaches projects or invitation tokens', async () => {
    await seedTwoOrgs();
    await expect(
      identityDb.user.findMany({ include: { projects: true } } as never),
    ).rejects.toThrow(/tenant data/);
    await expect(
      identityDb.user.findMany({ include: { sentInvitations: true } } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('rejects a nested write that would change roles across tenants', async () => {
    const { user } = await seedTwoOrgs();
    await expect(
      identityDb.user.update({
        where: { id: user.id },
        data: { memberships: { updateMany: { where: {}, data: { role: 'viewer' } } } },
      } as never),
    ).rejects.toThrow(/tenant data/);
  });

  it('still serves plain identity reads — the guard is not a blanket deny', async () => {
    await seedTwoOrgs();
    const users = await identityDb.user.findMany({ where: { email: 'victim@x.org' } });
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('victim@x.org');
  });
});
