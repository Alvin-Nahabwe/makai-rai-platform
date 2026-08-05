import { describe, expect, it, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { testDb, resetDb } from '../helpers/db';
import { identityDb } from '../../lib/data/identity';
import { bootstrapOrgWithOwner } from '../../lib/data/preauth';
import { requireOrgContextFor } from '../../lib/auth/context';
import { NotFoundError, ForbiddenError } from '../../lib/data/tenant';

/**
 * `requireOrgContextFor(userId, slug, action)` is the userId-explicit, pure
 * form that this suite drives directly — no session/cookie machinery. The
 * production entry point `requireOrgContext(slug, action)` (also exported
 * from lib/auth/context.ts) resolves userId from the authenticated identity
 * and delegates here; it is not separately covered by this suite (no request
 * context to construct one from in vitest's node environment — see
 * lib/auth/identity.ts's own comment on why `auth` is dynamically imported).
 */

describe('requireOrgContextFor — the six facts', () => {
  beforeEach(resetDb);

  it('refuses a slug the caller is not a member of', async () => {
    const a = await bootstrapOrgWithOwner({
      email: 'a@uni.ac.ug', name: 'A', passwordHash: 'x',
      orgName: 'Org A', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const b = await bootstrapOrgWithOwner({
      email: 'b@uni.ac.ug', name: 'B', passwordHash: 'x',
      orgName: 'Org B', researchConsent: false, ipAddress: '127.0.0.1',
    });
    await expect(requireOrgContextFor(a.userId, b.slug, 'project:read')).rejects.toThrow(NotFoundError);
  });

  it('refuses an unknown slug with the SAME error as a non-member slug', async () => {
    const a = await bootstrapOrgWithOwner({
      email: 'c@uni.ac.ug', name: 'C', passwordHash: 'x',
      orgName: 'Org C', researchConsent: false, ipAddress: '127.0.0.1',
    });
    await bootstrapOrgWithOwner({
      email: 'd@uni.ac.ug', name: 'D', passwordHash: 'x',
      orgName: 'Other Org', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const e1 = await requireOrgContextFor(a.userId, 'no-such-org', 'project:read').catch((e) => e);
    const e2 = await requireOrgContextFor(a.userId, 'other-org', 'project:read').catch((e) => e);
    expect(e1.constructor).toBe(e2.constructor); // 404 either way; never confirm existence
    expect(e1).toBeInstanceOf(NotFoundError);
  });

  it('refuses a suspended membership', async () => {
    const a = await bootstrapOrgWithOwner({
      email: 'e@uni.ac.ug', name: 'E', passwordHash: 'x',
      orgName: 'Org E', researchConsent: false, ipAddress: '127.0.0.1',
    });
    await testDb.membership.updateMany({ where: { userId: a.userId }, data: { status: 'suspended' } });
    await expect(requireOrgContextFor(a.userId, a.slug, 'project:read')).rejects.toThrow(NotFoundError);
  });

  it('refuses a soft-deleted organization', async () => { // O-15
    const a = await bootstrapOrgWithOwner({
      email: 'f@uni.ac.ug', name: 'F', passwordHash: 'x',
      orgName: 'Org F', researchConsent: false, ipAddress: '127.0.0.1',
    });
    await testDb.organization.update({ where: { id: a.orgId }, data: { deletedAt: new Date() } });
    await expect(requireOrgContextFor(a.userId, a.slug, 'project:read')).rejects.toThrow(NotFoundError);
  });

  it('403s a member whose role lacks the action, and 404s a non-member', async () => {
    const owner = await bootstrapOrgWithOwner({
      email: 'g@uni.ac.ug', name: 'G', passwordHash: 'x',
      orgName: 'Org G', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const outsider = await bootstrapOrgWithOwner({
      email: 'h@uni.ac.ug', name: 'H', passwordHash: 'x',
      orgName: 'Org H', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const viewerUser = await testDb.user.create({
      data: { email: 'viewer@uni.ac.ug', name: 'Viewer', passwordHash: 'x' },
    });
    await testDb.membership.create({
      data: { orgId: owner.orgId, userId: viewerUser.id, role: 'viewer' },
    });

    // viewer in their OWN org attempting project:create -> ForbiddenError, not NotFoundError
    await expect(requireOrgContextFor(viewerUser.id, owner.slug, 'project:create'))
      .rejects.toThrow(ForbiddenError);
    // outsider (no membership at all) attempting the same action on the same org -> NotFoundError
    await expect(requireOrgContextFor(outsider.userId, owner.slug, 'project:create'))
      .rejects.toThrow(NotFoundError);
  });

  it('ignores lastActiveOrgId entirely', async () => { // O-2
    const a = await bootstrapOrgWithOwner({
      email: 'i@uni.ac.ug', name: 'I', passwordHash: 'x',
      orgName: 'Org I', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const b = await bootstrapOrgWithOwner({
      email: 'j@uni.ac.ug', name: 'J', passwordHash: 'x',
      orgName: 'Org J', researchConsent: false, ipAddress: '127.0.0.1',
    });
    await identityDb.user.update({ where: { id: a.userId }, data: { lastActiveOrgId: b.orgId } });
    await expect(requireOrgContextFor(a.userId, b.slug, 'project:read')).rejects.toThrow(NotFoundError);
  });

  it('returns an OrgContext carrying the DB-read orgId and role on success', async () => {
    const a = await bootstrapOrgWithOwner({
      email: 'k@uni.ac.ug', name: 'K', passwordHash: 'x',
      orgName: 'Org K', researchConsent: false, ipAddress: '127.0.0.1',
    });
    const ctx = await requireOrgContextFor(a.userId, a.slug, 'project:read');
    expect(ctx.orgId).toBe(a.orgId);
    expect(ctx.role).toBe('owner');
  });
});

describe('OrgContext construction is enumerable', () => {
  it('is the only module that constructs an OrgContext', () => {
    const hits = execSync(`grep -rl "createOrgContext" app lib --include=*.ts --include=*.tsx || true`)
      .toString().trim().split('\n').filter(Boolean).sort();
    expect(hits).toEqual(['lib/auth/context.ts', 'lib/data/tenant.ts']);
  });
});
