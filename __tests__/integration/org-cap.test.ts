import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { bootstrapOrgWithOwner, createOrgForUser, OrgLimitError, ORG_LIMIT_PER_USER } from '../../lib/data/preauth';

/**
 * One account cannot own unlimited organizations.
 *
 * Register row D-107, escalated by the 2026-08-29 triage when the platform went
 * public. `createOrgForUser` counted nothing, so an account could create
 * organizations indefinitely — and because slugs are derived from the name and
 * awarded first-come, that is the throughput for squatting a real institution's
 * slug before it ever registers (D-201). Squatting is irreversible in a way a
 * rate limit alone does not address: a limit slows the rate, it does not bound
 * the total.
 *
 * So there are two controls and they do different jobs. The rate limit in
 * `lib/rate-limit.ts` bounds the BURST. This bounds the TOTAL. Neither replaces
 * the other: without the cap, an attacker waits; without the limit, they do not
 * have to.
 *
 * The cap is deliberately generous — a researcher genuinely affiliated with
 * several institutions must not hit it — and configurable, so raising it for a
 * real case is a deployment change rather than a release.
 */

beforeEach(resetDb);

async function makeOwner(email: string) {
  const r = await bootstrapOrgWithOwner({
    email, name: 'Owner', passwordHash: 'x',
    orgName: 'First Institution', researchConsent: true, ipAddress: '127.0.0.1',
  });
  return r.userId;
}

describe('organization ownership is capped per user', () => {
  it('allows a user to own several organizations, well past the common case', async () => {
    const userId = await makeOwner('a@uni.ac.ug');
    // bootstrap already made one; add up to the cap.
    for (let i = 1; i < ORG_LIMIT_PER_USER; i++) {
      await createOrgForUser({ userId, orgName: `Institution ${i}` });
    }
    const owned = await testDb.membership.count({ where: { userId, role: 'owner' } });
    expect(owned).toBe(ORG_LIMIT_PER_USER);
  });

  it('refuses the one past the cap, and refuses it as a typed error', async () => {
    const userId = await makeOwner('b@uni.ac.ug');
    for (let i = 1; i < ORG_LIMIT_PER_USER; i++) {
      await createOrgForUser({ userId, orgName: `Institution ${i}` });
    }
    await expect(
      createOrgForUser({ userId, orgName: 'One Too Many' }),
    ).rejects.toBeInstanceOf(OrgLimitError);
  });

  it('writes nothing when it refuses', async () => {
    // A refusal that half-created an organization would be worse than no cap:
    // the slug would be taken and the owner would not have it.
    const userId = await makeOwner('c@uni.ac.ug');
    for (let i = 1; i < ORG_LIMIT_PER_USER; i++) {
      await createOrgForUser({ userId, orgName: `Institution ${i}` });
    }
    const before = await testDb.organization.count();
    await createOrgForUser({ userId, orgName: 'Rejected Institution' }).catch(() => {});
    expect(await testDb.organization.count(), 'a refused creation still wrote a row').toBe(before);
    expect(
      await testDb.organization.findFirst({ where: { name: 'Rejected Institution' } }),
      'the refused organization name was taken anyway — slug squatting by failed request',
    ).toBeNull();
  });

  it('counts only what this user OWNS, so being invited elsewhere does not consume the cap', async () => {
    // Membership as a non-owner is the normal collaborative case and must not
    // count against someone's ability to create their own.
    const owner = await makeOwner('d@uni.ac.ug');
    const other = await makeOwner('e@uni.ac.ug');
    const otherOrg = await testDb.membership.findFirst({ where: { userId: other, role: 'owner' } });
    await testDb.membership.create({
      data: { userId: owner, orgId: otherOrg!.orgId, role: 'viewer', status: 'active' },
    });
    for (let i = 1; i < ORG_LIMIT_PER_USER; i++) {
      await createOrgForUser({ userId: owner, orgName: `Institution ${i}` });
    }
    const owned = await testDb.membership.count({ where: { userId: owner, role: 'owner' } });
    expect(owned, "a viewer membership in another org consumed part of the cap").toBe(ORG_LIMIT_PER_USER);
  });
});
