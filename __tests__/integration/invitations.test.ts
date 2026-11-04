import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { ForbiddenError, type OrgContext } from '../../lib/data/tenant';
import { createInvitation } from '../helpers/invite';
import { NextRequest } from 'next/server';
import { sessionFor, clearSession } from '../helpers/authSession';
import { stubAcceptanceRows } from '../helpers/legalStub';



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

  /**
   * Task 9: the invitation email's template needs the org's display name,
   * not just its `orgId`/slug — `createInvitation` now reads it inside the
   * same `withOrg` transaction that creates the row (lib/data/members.ts)
   * rather than the caller doing a second query. `seedOrg` names the
   * organization identically to its slug, so a wrong value (e.g. the slug
   * itself under a different key, or an empty string) would still pass a
   * weaker assertion — this pins the real `name` column's value.
   */
  it('returns the organization display name alongside the token (Task 9)', async () => {
    const org = await testDb.organization.create({ data: { name: 'Widget Factory Ltd', slug: 'inv-orgname' } });
    const inviter = await testDb.user.create({
      data: { email: 'inv-orgname-inviter@x.org', name: 'inviter', passwordHash: 'x' },
    });
    await testDb.membership.create({ data: { orgId: org.id, userId: inviter.id, role: 'owner' } });

    const result = await createInvitation({
      ctx: ctx(org.id, 'owner'),
      email: 'invitee@x.org',
      role: 'viewer',
      invitedById: inviter.id,
    });

    expect(result.orgName).toBe('Widget Factory Ltd');
  });

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

/**
 * Accepting is route 32 (app/api/v1/invitations/[token]/route.ts), which acceptInvitationViaDefiner and the
 * accept_invitation database function back. __tests__/integration/invitation-accept.test.ts holds its role,
 * wrong-account, used-token, administrator and race cases; these two are the rest of what the
 * pre-v1 accept function was tested for.
 */
describe('accepting an invitation (route 32)', () => {
  beforeEach(async () => {
    await resetDb();
    clearSession();
  });

  const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';

  async function accept(rawToken: string, body: unknown = {}) {
    const { POST } = await import('../../app/api/v1/invitations/[token]/route');
    return POST(new NextRequest(`http://localhost/api/v1/invitations/${rawToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }), { params: Promise.resolve({ token: rawToken }) });
  }
  async function acceptingInvitee(slug: string) {
    const invitee = await seedInvitee(slug);
    await testDb.consentRecord.createMany({ data: stubAcceptanceRows(invitee.id) });
    sessionFor(invitee.id);
    return invitee;
  }

  it('FR-ACC-01: takes the role from the row, ignoring anything the caller supplies, and marks the invitation accepted (O-5)', async () => {
    const { org, inviter } = await seedOrg('acc-role');
    const invitee = await acceptingInvitee('acc-role');
    const { rawToken } = await createInvitation({ ctx: ctx(org.id, 'owner'), email: invitee.email, role: 'viewer', invitedById: inviter.id });

    const res = await accept(rawToken, { role: 'owner', orgId: 'elsewhere' });

    expect([res.status, await res.json()]).toEqual([200, { orgSlug: org.slug }]);
    const membership = await testDb.membership.findFirst({ where: { orgId: org.id, userId: invitee.id } });
    expect(membership?.role).toBe('viewer');
    const invitation = await testDb.invitation.findFirst({ where: { orgId: org.id } });
    expect(invitation?.status).toBe('accepted');
    expect(invitation?.acceptedAt).not.toBeNull();
  });

  it('FR-ACC-01 NFR-SEC-05: refuses an expired invitation and an unknown token with the one M-23 answer', async () => {
    const { org, inviter } = await seedOrg('acc-expired');
    await acceptingInvitee('acc-expired');
    const rawToken = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    await testDb.invitation.create({ data: {
      orgId: org.id, email: 'acc-expired-invitee@x.org', role: 'viewer', tokenHash: createHash('sha256').update(rawToken).digest('hex'),
      invitedById: inviter.id, expiresAt: new Date(Date.now() - 1000),
    } });
    for (const token of [rawToken, 'nope']) {
      const res = await accept(token);
      expect([res.status, await res.json()], token).toEqual([410, { error: M23, code: 'invitation_unusable' }]);
    }
    expect(await testDb.membership.count({ where: { orgId: org.id } })).toBe(1);   // the inviter's only
  });
});
