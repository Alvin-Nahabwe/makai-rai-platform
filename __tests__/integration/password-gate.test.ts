import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { hash } from 'bcryptjs';
import { resetDb } from '../helpers/db';
import { bootstrapOrgWithOwner } from '../../lib/data/preauth';
import { identityDb } from '../../lib/data/identity';
import { resolveIdentity } from '../../lib/auth/identity';

/**
 * Finding 1 (the forced-password-change gate was dead) and Finding 2
 * (session revocation was unwired) from the phase-exit review, both driven
 * through the REAL route handlers — not by calling `requireIdentityForApi`
 * or `bumpSessionEpoch` directly. That distinction matters here specifically
 * because the original defects were both "the primitive works in isolation,
 * nothing wires it up" — an integration test that calls the primitive
 * directly would pass before AND after the fix, exactly as the existing
 * `bumpSessionEpoch` unit coverage did in `identity.test.ts` while the real
 * routes never called it (D-045's original gap).
 *
 * SESSION MOCKING: same seam `permission-matrix.test.ts` uses —
 * `requireIdentityForApi` dynamically imports `lib/auth.ts` and calls its
 * `auth()` export, so mocking that module is the only way to drive a route
 * handler as a specific user without a real browser/cookie jar. Every route
 * handler below is otherwise driven for real (real Prisma, real bcrypt).
 */

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string, sessionEpoch: number): void {
  currentSession = { user: { id: userId }, sessionEpoch, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

async function makeUser(email: string, plaintextPassword: string): Promise<string> {
  const passwordHash = await hash(plaintextPassword, 12);
  const { userId } = await bootstrapOrgWithOwner({
    email,
    name: 'Test User',
    passwordHash,
    orgName: `Org for ${email}`,
    researchConsent: false,
    ipAddress: '127.0.0.1',
  });
  return userId;
}

beforeEach(resetDb);

describe('POST /api/users/me/password (Finding 1 + Finding 2, driven through the real route)', () => {
  it('a mustChangePassword-flagged user CAN reach this route (the one exemption)', async () => {
    const userId = await makeUser('flagged@uni.ac.ug', 'OldPassw0rd!');
    await identityDb.user.update({ where: { id: userId }, data: { mustChangePassword: true } });
    sessionFor(userId, 0);

    const { POST } = await import('../../app/api/users/me/password/route');
    const req = new NextRequest('http://localhost/api/users/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!2' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const updated = await identityDb.user.findUnique({ where: { id: userId }, select: { mustChangePassword: true } });
    expect(updated?.mustChangePassword).toBe(false);
  });

  it('revokes every OTHER outstanding session by bumping sessionEpoch — not by calling bumpSessionEpoch directly', async () => {
    const userId = await makeUser('victim@uni.ac.ug', 'OldPassw0rd!');
    sessionFor(userId, 0); // the token an attacker copied off a shared lab machine

    const { POST } = await import('../../app/api/users/me/password/route');
    const req = new NextRequest('http://localhost/api/users/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!2' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    // The route handler ran for real (real Prisma UPDATE) — resolveIdentity
    // is driven directly here only to OBSERVE the consequence, not to
    // perform the revocation itself. The attacker's captured token still
    // carries `sessionEpoch: 0`; if the route actually bumped the stored
    // value, that token is now stale and must be rejected.
    await expect(
      resolveIdentity({ id: userId, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) }),
    ).rejects.toThrow(/session/i);
  });

  it('a wrong current-password attempt does NOT revoke existing sessions (fails closed on the write, not the read)', async () => {
    const userId = await makeUser('unchanged@uni.ac.ug', 'OldPassw0rd!');
    sessionFor(userId, 0);

    const { POST } = await import('../../app/api/users/me/password/route');
    const req = new NextRequest('http://localhost/api/users/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: 'WrongPassword!', newPassword: 'NewPassw0rd!2' }),
      headers: { 'content-type': 'application/json' },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);

    // The legitimate, still-valid session must still work.
    const identity = await resolveIdentity({
      id: userId,
      sessionEpoch: 0,
      sessionIssuedAt: Math.floor(Date.now() / 1000),
    });
    expect(identity.userId).toBe(userId);
  });
});

describe('requireIdentityForApi 403s a mustChangePassword-flagged caller on every OTHER route (Finding 1, API side)', () => {
  it('GET /api/users/me/export returns 403 with a machine-readable reason', async () => {
    const userId = await makeUser('flagged-export@uni.ac.ug', 'OldPassw0rd!');
    await identityDb.user.update({ where: { id: userId }, data: { mustChangePassword: true } });
    sessionFor(userId, 0);

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('must_change_password');
  });

  it('an un-flagged user reaches the same route normally (200)', async () => {
    const userId = await makeUser('unflagged-export@uni.ac.ug', 'OldPassw0rd!');
    sessionFor(userId, 0);

    const { GET } = await import('../../app/api/users/me/export/route');
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe('administrative deactivation revokes sessions by bumping sessionEpoch (Finding 2)', () => {
  it('bumps the target sessionEpoch in the same statement as isActive — driven through the real route', async () => {
    const adminId = await makeUser('admin-deactivator@uni.ac.ug', 'AdminPassw0rd!');
    await identityDb.user.update({ where: { id: adminId }, data: { role: 'admin' } });
    const targetId = await makeUser('deactivation-target@uni.ac.ug', 'TargetPassw0rd!');
    sessionFor(targetId, 0); // the target's own still-live token, captured before deactivation

    sessionFor(adminId, 0);
    const { POST } = await import('../../app/api/admin/users/[id]/role/route');
    const form = new URLSearchParams({ action: 'deactivate' });
    const req = new NextRequest(`http://localhost/api/admin/users/${targetId}/role`, {
      method: 'POST',
      body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: targetId }) });
    expect(res.status).toBe(303);

    // The target's OLD token must now fail on BOTH grounds — inactive, and
    // (independently, per Finding 2) a stale epoch.
    await expect(
      resolveIdentity({ id: targetId, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) }),
    ).rejects.toThrow(/session/i);

    const target = await identityDb.user.findUnique({
      where: { id: targetId },
      select: { isActive: true, sessionEpoch: true },
    });
    expect(target?.isActive).toBe(false);
    expect(target?.sessionEpoch).toBe(1);
  });
});
