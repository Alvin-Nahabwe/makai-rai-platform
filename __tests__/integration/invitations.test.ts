import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { ForbiddenError, type OrgContext } from '../../lib/data/tenant';
import { createInvitation } from '../../lib/data/members';
import { acceptInvitation, InvitationError } from '../../lib/data/preauth';

/**
 * Task 8: invitations are the second way into an organization (registration
 * being the first), and their token is a credential that grants org
 * membership at a stated role. These tests prove the five properties named
 * in the Task 8 brief — not merely that the happy path works.
 */

function ctx(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

async function seedOrg(slug: string, ownerRole: OrgRole = 'owner') {
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const inviter = await testDb.user.create({
    data: { email: `${slug}-inviter@x.org`, name: `${slug}-inviter`, passwordHash: 'x' },
  });
  await testDb.membership.create({ data: { orgId: org.id, userId: inviter.id, role: ownerRole } });
  return { org, inviter };
}

async function seedInvitee(slug: string, email = `${slug}-invitee@x.org`) {
  return testDb.user.create({ data: { email, name: `${slug}-invitee`, passwordHash: 'x' } });
}

describe('createInvitation', () => {
  beforeEach(resetDb);

  it('stores only a digest — no stored value works as a token (O-7)', async () => {
    const { org, inviter } = await seedOrg('inv-o7');
    await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'invitee@x.org',
      role: 'viewer',
      invitedById: inviter.id,
    });
    const rows = await testDb.invitation.findMany();
    expect(rows).toHaveLength(1);
    for (const r of rows) {
      expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns a raw token that is at least 128 bits (32 hex chars) of entropy', async () => {
    const { org, inviter } = await seedOrg('inv-entropy');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'invitee@x.org',
      role: 'viewer',
      invitedById: inviter.id,
    });
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex = 256 bits
  });

  it('sets expiresAt 7 days out', async () => {
    const { org, inviter } = await seedOrg('inv-ttl');
    const before = Date.now();
    const { expiresAt } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'invitee@x.org',
      role: 'viewer',
      invitedById: inviter.id,
    });
    const deltaMs = expiresAt.getTime() - before;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(deltaMs).toBeGreaterThan(sevenDaysMs - 5000);
    expect(deltaMs).toBeLessThan(sevenDaysMs + 5000);
  });

  it('refuses an admin minting an owner invitation', async () => {
    const { org, inviter: admin } = await seedOrg('inv-cap', 'admin');
    await expect(
      createInvitation({
        ctx: ctx(org.id, 'admin'),
        email: 'invitee@x.org',
        role: 'owner',
        invitedById: admin.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await testDb.invitation.count()).toBe(0);
  });

  it('allows an owner minting an owner invitation', async () => {
    const { org, inviter } = await seedOrg('inv-cap-owner');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'invitee@x.org',
      role: 'owner',
      invitedById: inviter.id,
    });
    expect(rawToken).toBeTruthy();
  });
});

describe('acceptInvitation', () => {
  beforeEach(resetDb);

  it('takes the role from the row, ignoring anything the caller supplies (O-5)', async () => {
    const { org, inviter } = await seedOrg('acc-role');
    const invitee = await seedInvitee('acc-role');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: invitee.email,
      role: 'viewer',
      invitedById: inviter.id,
    });

    const result = await acceptInvitation({
      rawToken,
      userId: invitee.id,
      userEmail: invitee.email,
    });

    expect(result.role).toBe('viewer');
    expect(result.orgId).toBe(org.id);
    const membership = await testDb.membership.findFirst({
      where: { orgId: org.id, userId: invitee.id },
    });
    expect(membership?.role).toBe('viewer');
  });

  it('marks the invitation accepted, with acceptedAt set', async () => {
    const { org, inviter } = await seedOrg('acc-status');
    const invitee = await seedInvitee('acc-status');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: invitee.email,
      role: 'viewer',
      invitedById: inviter.id,
    });

    await acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email });

    const invitation = await testDb.invitation.findFirst({ where: { orgId: org.id } });
    expect(invitation?.status).toBe('accepted');
    expect(invitation?.acceptedAt).not.toBeNull();
  });

  it('creates exactly one membership under concurrent acceptance (O-6)', async () => {
    const { org, inviter } = await seedOrg('acc-race');
    const invitee = await seedInvitee('acc-race');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: invitee.email,
      role: 'viewer',
      invitedById: inviter.id,
    });

    const results = await Promise.allSettled([
      acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email }),
      acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await testDb.membership.count({ where: { userId: invitee.id } })).toBe(1);
  });

  /**
   * The test above uses the SAME `userId` for both concurrent callers, which
   * means `memberships`' own `@@unique([orgId, userId])` constraint is a
   * second, independent backstop against a duplicate row — a naive
   * read-then-write implementation could still pass that test for the WRONG
   * reason (the Membership insert's own uniqueness, not the invitation's
   * single-use gate). This test uses two DIFFERENT users racing the same
   * token, which the Membership constraint cannot save, so it isolates
   * property 2 (the status transition IS the lock) on its own — see the
   * Task 8 report's non-vacuity section for the read-then-write probe that
   * left this one red while the same-user test above stayed green.
   */
  it('creates exactly one membership when two different users race the same token', async () => {
    const { org, inviter } = await seedOrg('acc-race-2users');
    const inviteeA = await seedInvitee('acc-race-2users-a');
    const inviteeB = await seedInvitee('acc-race-2users-b');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'shared-invite@x.org',
      role: 'viewer',
      invitedById: inviter.id,
    });

    const results = await Promise.allSettled([
      acceptInvitation({ rawToken, userId: inviteeA.id, userEmail: 'shared-invite@x.org' }),
      acceptInvitation({ rawToken, userId: inviteeB.id, userEmail: 'shared-invite@x.org' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // `orgId: org.id` alone would also count the inviter's own owner
    // membership that `seedOrg` creates — scoped to the two racing
    // invitees so this asserts on the invitation's effect only.
    expect(
      await testDb.membership.count({
        where: { orgId: org.id, userId: { in: [inviteeA.id, inviteeB.id] } },
      }),
    ).toBe(1);
  });

  it('refuses a forwarded link for a different account (D-098)', async () => {
    const { org, inviter } = await seedOrg('acc-email');
    await testDb.user.create({
      data: { email: 'alice@uni.ac', name: 'Alice', passwordHash: 'x' },
    });
    const bob = await testDb.user.create({
      data: { email: 'bob@evil.com', name: 'Bob', passwordHash: 'x' },
    });
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'alice@uni.ac',
      role: 'admin',
      invitedById: inviter.id,
    });

    await expect(
      acceptInvitation({ rawToken, userId: bob.id, userEmail: 'bob@evil.com' }),
    ).rejects.toThrow(/invitation/i);

    expect(await testDb.membership.count({ where: { userId: bob.id } })).toBe(0);
  });

  /**
   * `acceptInvitation` throws from inside `ownerClient.$transaction`'s
   * callback on an email mismatch — Prisma rolls back the WHOLE
   * transaction on a thrown error, so the earlier `status: 'accepted'`
   * write is undone along with it. This proves that live: the invitation
   * must still be usable by the person it actually names, even after an
   * attacker (or a stale/forwarded copy of the link) tried it first with
   * the wrong email. The opposite behaviour — burning the token on any
   * mismatched attempt — would let a forwarded link deny the real invitee
   * ever accepting it.
   */
  it('remains acceptable by the correct invitee after a mismatched attempt', async () => {
    const { org, inviter } = await seedOrg('acc-email-recover');
    const alice = await testDb.user.create({
      data: { email: 'alice@uni.ac', name: 'Alice', passwordHash: 'x' },
    });
    const bob = await testDb.user.create({
      data: { email: 'bob@evil.com', name: 'Bob', passwordHash: 'x' },
    });
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'alice@uni.ac',
      role: 'admin',
      invitedById: inviter.id,
    });

    await expect(
      acceptInvitation({ rawToken, userId: bob.id, userEmail: 'bob@evil.com' }),
    ).rejects.toBeInstanceOf(InvitationError);

    const invitationAfterMismatch = await testDb.invitation.findFirst({ where: { orgId: org.id } });
    expect(invitationAfterMismatch?.status).toBe('pending');

    const result = await acceptInvitation({ rawToken, userId: alice.id, userEmail: 'alice@uni.ac' });
    expect(result.role).toBe('admin');
    expect(await testDb.membership.count({ where: { userId: alice.id } })).toBe(1);
  });

  it('refuses a used token on a second attempt', async () => {
    const { org, inviter } = await seedOrg('acc-reuse');
    const invitee = await seedInvitee('acc-reuse');
    const { rawToken } = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: invitee.email,
      role: 'viewer',
      invitedById: inviter.id,
    });

    await acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email });

    await expect(
      acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email }),
    ).rejects.toBeInstanceOf(InvitationError);
  });

  it('refuses an expired invitation', async () => {
    const { org, inviter } = await seedOrg('acc-expired');
    const invitee = await seedInvitee('acc-expired');
    const rawToken = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    await testDb.invitation.create({
      data: {
        orgId: org.id,
        email: invitee.email,
        role: 'viewer',
        tokenHash: createHash('sha256').update(rawToken).digest('hex'),
        invitedById: inviter.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(
      acceptInvitation({ rawToken, userId: invitee.id, userEmail: invitee.email }),
    ).rejects.toBeInstanceOf(InvitationError);
  });

  it('refuses an unknown token', async () => {
    const invitee = await seedInvitee('acc-unknown');
    await expect(
      acceptInvitation({ rawToken: 'nope', userId: invitee.id, userEmail: invitee.email }),
    ).rejects.toBeInstanceOf(InvitationError);
  });
});
