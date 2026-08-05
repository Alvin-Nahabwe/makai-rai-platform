import { hash } from 'bcryptjs';
import type { OrgRole } from '@prisma/client';
import { bootstrapOrgWithOwner, createUserFromInvitation, acceptInvitation } from '../../lib/data/preauth';
import { createInvitation } from '../../lib/data/members';
import type { OrgContext } from '../../lib/data/tenant';

/**
 * Task 10: the shared 2-org x 5-role x 2-member fixture the exhaustive
 * role-vs-ownership matrix (the next task) runs against, in BOTH the
 * vitest integration suite and the Playwright e2e suite
 * (e2e/fixtures/auth.setup.ts imports this same module) — see that file's
 * doc comment for why one module has to serve both processes.
 *
 * Every role gets exactly 2 members, and that is the experiment, not
 * redundant coverage: with 1 member per role a surviving ownership check
 * (`assessment.userId !== user.id`) passes silently, because the sole
 * member always created whatever they act on — role-based and
 * creator-based access become indistinguishable. With 2, member `index 0`
 * creates a resource and member `index 1` acts on it; if ownership residue
 * survived the port, index 1 is wrongly denied where index 0 succeeds.
 *
 * BUILT THROUGH THE REAL PATHS ONLY (brief constraint): the two `index: 0`
 * owners come from `bootstrapOrgWithOwner` — the same function
 * `/api/auth/register` calls. Every other one of the 18 remaining seats is
 * produced by `createInvitation` (mints the same one-time token the
 * `POST /members` route returns as `acceptUrl`) followed by
 * `createUserFromInvitation` + `acceptInvitation` — the same two calls
 * `POST /invitations/[token]/register` and `POST /invitations/[token]`
 * make. No `Membership` row is ever created directly; see
 * `__tests__/integration/fixture.test.ts` for the proof (every non-
 * bootstrap seat traces back to an `accepted` Invitation row).
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
 * `OrgContext` is branded (D-089) precisely so a plain object literal
 * cannot satisfy it by accident; only `createOrgContext`, called solely by
 * `requireOrgContext`, may mint one in production. This fixture is not a
 * request handler — it already knows (because it just created) the owner's
 * `orgId` and role — so it uses the same documented escape hatch every
 * integration test in `__tests__/integration/` uses (e.g.
 * `tenant-layer.test.ts`'s `ctx()`): a deliberate `as OrgContext` cast.
 */
function ownerContext(orgId: string): OrgContext {
  return { orgId, role: 'owner' } as OrgContext;
}

/** One naming formula for every seat — the bootstrap owner (index 0) and
 * every invited seat both call this, so the two paths cannot drift apart
 * the way a hand-written owner-only literal could (`simplify` finding). */
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

async function buildOrg(
  label: 'a' | 'b',
  runId: string,
  passwordHash: string,
): Promise<{ org: FixtureOrg; users: FixtureUser[] }> {
  const owner = seatIdentity(label, 'owner', 0, runId);
  const boot = await bootstrapOrgWithOwner({
    email: owner.email,
    name: owner.name,
    passwordHash,
    orgName: `Fixture Org ${label.toUpperCase()} ${runId}`,
    researchConsent: false,
    ipAddress: 'fixture-build',
  });

  const org: FixtureOrg = { id: boot.orgId, slug: boot.slug };
  const users: FixtureUser[] = [
    {
      userId: boot.userId,
      email: owner.email,
      password: FIXTURE_PASSWORD,
      orgSlug: org.slug,
      role: 'owner',
      index: 0,
    },
  ];

  const ctx = ownerContext(org.id);

  for (const role of FIXTURE_ROLES) {
    for (const index of [0, 1] as const) {
      if (role === 'owner' && index === 0) continue; // already the bootstrap owner above

      const { email, name } = seatIdentity(label, role, index, runId);

      const invitation = await createInvitation({
        ctx,
        email,
        role,
        invitedById: boot.userId,
      });
      const created = await createUserFromInvitation({
        email,
        name,
        passwordHash,
        researchConsent: false,
        ipAddress: 'fixture-build',
      });
      // `invitation.role`/`role` (the value just requested and proven
      // accepted below) is the source of truth — `acceptInvitation`'s own
      // return value is a derivable round-trip of the same field, not a
      // second independent fact, so it is deliberately not re-read here.
      await acceptInvitation({
        rawToken: invitation.rawToken,
        userId: created.userId,
        userEmail: email,
      });

      users.push({
        userId: created.userId,
        email,
        password: FIXTURE_PASSWORD,
        orgSlug: org.slug,
        role,
        index,
      });
    }
  }

  return { org, users };
}

/**
 * Builds a fresh 2-org x 5-role x 2-member fixture on every call — emails
 * and org names are suffixed with a run id (timestamp + random) so repeated
 * calls against the SAME database (the e2e suite never truncates the dev
 * database `auth.setup.ts` runs against, unlike `resetDb()` in the vitest
 * suite) never collide with a previous run's rows.
 *
 * The two orgs build concurrently (`Promise.all`), not sequentially: they
 * share no mutable state — distinct `label`s give every email/org name a
 * disjoint namespace, `passwordHash` is computed once up front and only
 * ever read, and `createInvitation`'s token comes from `randomBytes(32)`
 * (lib/data/members.ts), not a shared counter. Verified independent by the
 * `simplify` efficiency pass; halves this function's own wall time.
 */
export async function buildTwoOrgFixture(): Promise<TwoOrgFixture> {
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const passwordHash = await hash(FIXTURE_PASSWORD, 12);

  const [a, b] = await Promise.all([
    buildOrg('a', runId, passwordHash),
    buildOrg('b', runId, passwordHash),
  ]);

  return { orgs: [a.org, b.org], users: [...a.users, ...b.users] };
}
