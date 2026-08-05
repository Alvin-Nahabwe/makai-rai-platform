import { beforeAll, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { buildTwoOrgFixture, FIXTURE_ROLES, type TwoOrgFixture } from '../helpers/fixture';

/**
 * Task 10: the shared fixture the next task's exhaustive role-vs-ownership
 * matrix runs against. These tests prove the three properties the brief
 * names explicitly:
 *
 * 1. Exactly 2 orgs x 5 roles x 2 members = 20 users, with `index` (0|1)
 *    separating "who created" from "who acts" per (org, role) cell.
 * 2. Every user really has the Membership the fixture claims — not just an
 *    in-memory return value.
 * 3. Every non-bootstrap-owner seat was produced by an ACCEPTED Invitation
 *    row, proving the fixture went through createInvitation + acceptInvitation
 *    rather than inserting Membership rows directly (the defect already
 *    fixed once in prisma/seed.ts).
 *
 * Built ONCE in `beforeAll`, not per-`it` — all three tests are read-only
 * against the fixture (none mutates a Membership/Invitation/User row after
 * the build), so rebuilding a fresh 20-user fixture (and re-hashing the
 * shared password, and re-truncating the database) three times bought
 * nothing but 3x the setup cost (`simplify` efficiency + simplification
 * passes, same finding from two angles).
 */
describe('buildTwoOrgFixture', () => {
  let fixture: TwoOrgFixture;

  beforeAll(async () => {
    await resetDb();
    fixture = await buildTwoOrgFixture();
  });

  it('creates exactly 2 orgs and 20 users, with a distinct member 0 and member 1 per role per org', () => {
    expect(fixture.orgs).toHaveLength(2);
    expect(fixture.orgs[0].slug).not.toBe(fixture.orgs[1].slug);
    expect(fixture.users).toHaveLength(20);
    expect(FIXTURE_ROLES).toHaveLength(5);

    for (const org of fixture.orgs) {
      for (const role of FIXTURE_ROLES) {
        const cell = fixture.users.filter((u) => u.orgSlug === org.slug && u.role === role);
        expect(cell.map((u) => u.index).sort()).toEqual([0, 1]);
        expect(cell[0].userId).not.toBe(cell[1].userId);
        expect(cell[0].email).not.toBe(cell[1].email);
      }
    }
  });

  it('gives every fixture user a real, active Membership at the recorded role', async () => {
    for (const user of fixture.users) {
      const org = fixture.orgs.find((o) => o.slug === user.orgSlug);
      expect(org).toBeDefined();
      const membership = await testDb.membership.findFirst({
        where: { userId: user.userId, orgId: org!.id, status: 'active' },
      });
      expect(membership?.role).toBe(user.role);
    }
  });

  it('builds every non-bootstrap seat through an accepted Invitation row, never a direct Membership insert', async () => {
    // Only the two org-bootstrap owners (role owner, index 0) skip
    // invitation entirely — bootstrapOrgWithOwner creates them directly,
    // exactly as /register does for a real first user.
    const bootstrapOwners = fixture.users.filter((u) => u.role === 'owner' && u.index === 0);
    expect(bootstrapOwners).toHaveLength(2);

    const invited = fixture.users.filter((u) => !(u.role === 'owner' && u.index === 0));
    expect(invited).toHaveLength(18);

    for (const user of invited) {
      const org = fixture.orgs.find((o) => o.slug === user.orgSlug);
      const invitation = await testDb.invitation.findFirst({
        where: { orgId: org!.id, email: user.email, role: user.role, status: 'accepted' },
      });
      expect(invitation).not.toBeNull();
      expect(invitation?.acceptedAt).not.toBeNull();
    }

    // Exactly one accepted Invitation per invited seat — nothing extra, no
    // membership that arrived by some other, unaccounted-for path.
    expect(await testDb.invitation.count()).toBe(18);
    expect(await testDb.membership.count()).toBe(20);
  });
});
