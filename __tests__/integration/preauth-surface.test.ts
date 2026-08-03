import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import * as preauth from '../../lib/data/preauth';

/**
 * preauth runs on the OWNER connection and is therefore not constrained by RLS.
 * That bypass is deliberate (ADR-0001) but must stay small and enumerable, so
 * this test pins the exported surface. Adding a function here is a decision,
 * not an accident — if this test fails, that is the point.
 *
 * Note the limit of the pin: it constrains the SURFACE, not the semantics. A
 * body can still be widened (an added `include:`) without failing this test.
 */
describe('preauth exported surface', () => {
  it('exports exactly the three sanctioned before-context reads', () => {
    expect(Object.keys(preauth).sort())
      .toEqual(['invitationByToken', 'membershipsForUser', 'orgBySlug']);
  });
});

describe('invitationByToken fails closed', () => {
  beforeEach(resetDb);

  async function makeInvite(token: string, over: Record<string, unknown>) {
    const inviter = await testDb.user.create({
      data: { email: `${token}@x.org`, name: token, passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: token, slug: token } });
    return testDb.invitation.create({
      data: {
        // 'viewer', not the brief's 'member': OrgRole is
        // owner|admin|assessor|reviewer|viewer and has no 'member' value.
        orgId: org.id, email: 'invitee@x.org', role: 'viewer', token,
        invitedById: inviter.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        ...over,
      },
    });
  }

  it('returns a pending, unexpired invitation', async () => {
    await makeInvite('good-token', {});
    expect(await preauth.invitationByToken('good-token')).not.toBeNull();
  });

  it('returns null for an expired invitation', async () => {
    await makeInvite('expired-token', { expiresAt: new Date(Date.now() - 1000) });
    expect(await preauth.invitationByToken('expired-token')).toBeNull();
  });

  it('returns null for an already-accepted invitation', async () => {
    await makeInvite('used-token', { status: 'accepted' });
    expect(await preauth.invitationByToken('used-token')).toBeNull();
  });
});
