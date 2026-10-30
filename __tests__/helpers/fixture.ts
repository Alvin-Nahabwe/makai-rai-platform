import { hash } from 'bcryptjs';
import type { OrgRole } from '@prisma/client';
import { testDb } from './db';
import { stubAcceptanceRows } from './legalStub';
import { buildOrg } from './recordFixture';

/**
 * Task 10: the shared 2-org x 5-role x 2-member fixture the exhaustive role-vs-ownership matrix
 * runs against, in BOTH the vitest integration suite and the Playwright e2e suite
 * (e2e/fixtures/auth.setup.ts imports this same module).
 *
 * Every role gets exactly 2 members, and that is the experiment, not redundant coverage: with 1
 * member per role a surviving ownership check (`assessment.userId !== user.id`) passes silently,
 * because the sole member always created whatever they act on. With 2, member `index 0` creates
 * a resource and member `index 1` acts on it.
 *
 * v0.6.0: built on the record fixture builder's `buildOrg` (./recordFixture) through `testDb`
 * (00-contract.md, Test harness API and revocation table), no longer through
 * the preauth bootstrap, invitation-acceptance and member-invitation writers: ACC-a and ORG
 * remove those, and ORG's step-8 migration revokes the grants they used. Every seat holds the v1
 * acceptances of `fixtureLegalTexts()`, so the accounts pass the acceptance gate (FR-ACC-04).
 * `__tests__/integration/fixture.test.ts` pins the shape.
 */

export const FIXTURE_ROLES: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];

/** Not a secret — every fixture account shares it, purely so the e2e
 * `auth.setup.ts` login step needs one known plaintext, not 20. */
export const FIXTURE_PASSWORD = 'FixturePass123!';

export type FixtureUser = {
  userId: string;
  email: string;
  /** Included beyond the brief's "at minimum" shape: `auth.setup.ts` needs
   * a plaintext to submit through the real /login form. Always
   * `FIXTURE_PASSWORD`. */
  password: string;
  orgSlug: string;
  role: OrgRole;
  index: 0 | 1;
};

export type FixtureOrg = { id: string; slug: string };

export type TwoOrgFixture = {
  orgs: [FixtureOrg, FixtureOrg];
  users: FixtureUser[];
};

/**
 * `OrgContext` is branded (D-089) precisely so a plain object literal cannot satisfy it by
 * accident; only `createOrgContext`, called solely by `requireOrgContext`, may mint one in
 * production. A fixture is not a request handler, so `ctxFor` in ./recordFixture uses the same
 * documented escape hatch every integration test uses: a deliberate `as OrgContext` cast.
 */

/** One naming formula for every seat, so member 0 and member 1 cannot drift apart. */
function seatIdentity(
  label: 'a' | 'b',
  role: OrgRole,
  index: 0 | 1,
  runId: string,
): { email: string; name: string } {
  return {
    email: `fixture-${label}-${role}-${index}-${runId}@fixture.test`,
    name: `Fixture ${label} ${role} ${index}`,
  };
}

/**
 * One organisation's ten seats. Member 0 of each role comes from `buildOrg` (the record fixture
 * builder, ./recordFixture), with its agreement record; member 1 of each role is a second
 * account with a membership of that role and the same acceptances (`stubAcceptanceRows`, the
 * rows of `fixtureLegalTexts()`), written through `testDb` as `buildOrg` writes its own. No
 * platform-role `admin` seat, so the membership lock never fires.
 */
async function buildSeats(
  label: 'a' | 'b',
  runId: string,
  passwordHash: string,
): Promise<{ org: FixtureOrg; users: FixtureUser[] }> {
  const fx = await buildOrg({ label });
  const org: FixtureOrg = { id: fx.org.id, slug: fx.org.slug };
  const users: FixtureUser[] = [];
  for (const role of FIXTURE_ROLES) {
    const first = fx.members[role];
    users.push({ userId: first.userId, email: first.email, password: FIXTURE_PASSWORD, orgSlug: org.slug, role, index: 0 });

    const { email, name } = seatIdentity(label, role, 1, runId);
    const second = await testDb.user.create({ data: { email, name, passwordHash } });
    await testDb.membership.create({ data: { orgId: org.id, userId: second.id, role } });
    await testDb.consentRecord.createMany({ data: stubAcceptanceRows(second.id) });
    users.push({ userId: second.id, email, password: FIXTURE_PASSWORD, orgSlug: org.slug, role, index: 1 });
  }
  return { org, users };
}

/**
 * Builds a fresh 2-org x 5-role x 2-member fixture on every call — emails and org names carry a
 * run id (timestamp + random) so repeated calls against the SAME database (the e2e suite never
 * truncates the database `auth.setup.ts` runs against, unlike `resetDb()` in the vitest suite)
 * never collide with a previous run's rows. The two organisations build concurrently: they share
 * no mutable state.
 */
export async function buildTwoOrgFixture(): Promise<TwoOrgFixture> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const passwordHash = await hash(FIXTURE_PASSWORD, 12);

  const [a, b] = await Promise.all([
    buildSeats('a', runId, passwordHash),
    buildSeats('b', runId, passwordHash),
  ]);

  return { orgs: [a.org, b.org], users: [...a.users, ...b.users] };
}
