import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError, type OrgContext } from '../../lib/data/tenant';
import { ConflictError } from '../../lib/http/errors';
import { requestDigest } from '../../lib/data/idempotency';
import { removeMember } from '../../lib/data/members';

/**
 * Fix round 1, Important finding 1: `member:remove` is granted to BOTH
 * `owner` and `admin` (lib/authz/policy.ts), so `requireOrgContext(slug,
 * 'member:remove')` alone does not prove the caller may remove an OWNER
 * specifically — before this fix, an org `admin` could call `DELETE
 * .../members/[ownerId]` and succeed, and no one could undo it
 * (`member:grant_owner` is owner-only). `removeMember` now requires
 * `member:revoke_owner` (owner-only) additionally, whenever the target is
 * an owner — composed with, not replacing, the existing last-owner guard.
 */

function ctx(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

async function seedOrgWith(slug: string, memberRoles: OrgRole[]) {
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const users = [];
  for (let i = 0; i < memberRoles.length; i++) {
    const user = await testDb.user.create({
      data: { email: `${slug}-${i}@x.org`, name: `${slug}-${i}`, passwordHash: 'x' },
    });
    await testDb.membership.create({
      data: { orgId: org.id, userId: user.id, role: memberRoles[i] },
    });
    users.push(user);
  }
  return { org, users };
}

/** The service call with a fresh request id and its digest, as route 26 DELETE makes it. */
async function removeVia(c: OrgContext, actor: { userId: string; role: OrgRole }, userId: string) {
  const body = { requestId: randomUUID() };
  return removeMember(c, actor, { ...body, userId }, requestDigest({ path: { userId }, body }));
}

describe('removeMember', () => {
  beforeEach(resetDb);

  it('refuses an admin removing an owner — 403-shaped ForbiddenError, not a silent 200', async () => {
    // org has owners O1, O2, and admin A
    const { org, users } = await seedOrgWith('mem-a', ['owner', 'owner', 'admin']);
    const [o1, , admin] = users;

    await expect(removeVia(ctx(org.id, 'admin'), { userId: admin.id, role: 'admin' }, o1.id)).rejects.toBeInstanceOf(ForbiddenError);

    // O1's membership must still exist — the attempt must not have partially applied.
    const stillActive = await testDb.membership.findFirst({
      where: { orgId: org.id, userId: o1.id, status: 'active' },
    });
    expect(stillActive).not.toBeNull();
    void admin;
  });

  it('allows an owner removing a co-owner', async () => {
    // org has owners O1, O2
    const { org, users } = await seedOrgWith('mem-b', ['owner', 'owner']);
    const [o1, o2] = users;

    await removeVia(ctx(org.id, 'owner'), { userId: o1.id, role: 'owner' }, o2.id);

    const stillActive = await testDb.membership.findFirst({
      where: { orgId: org.id, userId: o2.id, status: 'active' },
    });
    expect(stillActive).toBeNull();
    void o1;
  });

  it('refuses an owner removing the last owner', async () => {
    // org has a single owner O1
    const { org, users } = await seedOrgWith('mem-c', ['owner']);
    const [o1] = users;

    await expect(removeVia(ctx(org.id, 'owner'), { userId: o1.id, role: 'owner' }, o1.id)).rejects.toMatchObject({ code: 'last_active_owner' });
    await expect(removeVia(ctx(org.id, 'owner'), { userId: o1.id, role: 'owner' }, o1.id)).rejects.toBeInstanceOf(ConflictError);

    const stillActive = await testDb.membership.findFirst({
      where: { orgId: org.id, userId: o1.id, status: 'active' },
    });
    expect(stillActive).not.toBeNull(); // refused, so nothing was deleted
  });

  it('allows an owner or admin removing a non-owner member', async () => {
    const { org, users } = await seedOrgWith('mem-d', ['owner', 'admin', 'assessor']);
    const [, admin, assessor] = users;

    await removeVia(ctx(org.id, 'admin'), { userId: admin.id, role: 'admin' }, assessor.id);
    expect(await testDb.membership.count({ where: { orgId: org.id, userId: assessor.id } })).toBe(0);
  });

  it('returns not_found for a userId with no active membership in this org', async () => {
    const { org, users } = await seedOrgWith('mem-e', ['owner']);
    await expect(removeVia(ctx(org.id, 'owner'), { userId: users[0].id, role: 'owner' }, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(NotFoundError);
  });
});
