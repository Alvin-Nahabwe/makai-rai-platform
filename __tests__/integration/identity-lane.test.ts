import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { testDb, resetDb } from '../helpers/db';
import { adrGrants } from '../helpers/adr-grants';
import * as connection from '../../lib/data/connection';
import { acceptInvitation, createOrgForUser, invitationByToken, membershipsForUser } from '../../lib/data/preauth';
import { hashInvitationToken } from '../../lib/data/invitationToken';

/**
 * The identity lane is what `lib/data/identity.ts` and `lib/data/preauth.ts` connect
 * with: `IDENTITY_DATABASE_URL`, the role `makrai_identity` (ADR-0009). Until ADR-0009
 * these two modules connected as the schema owner, a superuser that ignores row-level
 * security entirely.
 *
 * The first three tests use a raw `pg` Pool on the same URL, so they observe what the
 * ROLE can do, independent of every guard the two modules put in front of it.
 */

let pool: Pool;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL, max: 2, options: '' });
});

afterAll(async () => {
  await pool.end();
});

describe('the identity lane role', () => {
  it('connects as makrai_identity, neither superuser nor BYPASSRLS', async () => {
    const { rows } = await pool.query(
      `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]).toEqual({ current_user: 'makrai_identity', rolsuper: false, rolbypassrls: false });
  });

  it('is refused every tenant record table', async () => {
    // Generated, not hand-listed (F-03): every table in public that carries a policy,
    // minus the tables ADR-0009 grants this role. A tenant table added later is covered
    // the moment it gets its org_isolation policy.
    const granted = new Set(Object.keys(adrGrants('makrai_identity')));
    const policyTables = await testDb.$queryRaw<{ tablename: string }[]>`
      SELECT DISTINCT tablename::text AS tablename FROM pg_policies WHERE schemaname = 'public' ORDER BY 1`;
    const tenantTables = policyTables.map((r) => r.tablename).filter((t) => !granted.has(t));

    expect(tenantTables.length).toBeGreaterThan(0);
    expect(tenantTables).toContain('projects');
    for (const t of tenantTables) {
      await expect(pool.query(`SELECT 1 FROM "${t}" LIMIT 1`), t).rejects.toThrow(/permission denied for table/);
    }
  });

  it('cannot create objects', async () => {
    try {
      await expect(pool.query('CREATE TABLE zz_probe(id int)')).rejects.toThrow(/permission denied for schema public/);
      await expect(pool.query('CREATE SCHEMA zz_probe')).rejects.toThrow(/permission denied for database/);
    } finally {
      // Only does anything when the test is failing: a probe that SUCCEEDED leaves an
      // object owned by makrai_identity, which would then fail role-grants.test.ts on
      // every later run for a reason that has nothing to do with its own check.
      await testDb.$executeRawUnsafe('DROP TABLE IF EXISTS public.zz_probe');
      await testDb.$executeRawUnsafe('DROP SCHEMA IF EXISTS zz_probe');
    }
  });
});

describe('pre-organisation lookups on the identity lane', () => {
  beforeEach(resetDb);

  it('serves pre-organisation lookups with no org context', async () => {
    // Review Focus 1. U is active in orgs A and B and holds a pending invitation to C.
    // Fixtures go in through the superuser testDb so that only the calls under test run
    // on the identity lane, and none of them is given an organisation context.
    const u = await testDb.user.create({ data: { email: 'lane-u@x.org', name: 'U', passwordHash: 'x' } });
    const inviter = await testDb.user.create({ data: { email: 'lane-inviter@x.org', name: 'I', passwordHash: 'x' } });
    const [a, b, c] = await Promise.all(
      ['lane-a', 'lane-b', 'lane-c'].map((slug) => testDb.organization.create({ data: { name: slug, slug } })),
    );
    await testDb.membership.createMany({
      data: [
        { orgId: a.id, userId: u.id, role: 'owner' },
        { orgId: b.id, userId: u.id, role: 'viewer' },
        { orgId: c.id, userId: inviter.id, role: 'owner' },
      ],
    });
    const token = randomBytes(32).toString('hex');
    await testDb.invitation.create({
      data: {
        orgId: c.id, email: u.email, role: 'assessor', tokenHash: hashInvitationToken(token),
        invitedById: inviter.id, expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    expect((await membershipsForUser(u.id)).map((m) => m.org.slug).sort()).toEqual([a.slug, b.slug].sort());
    expect(await invitationByToken(token)).not.toBeNull();
    await acceptInvitation({ rawToken: token, userId: u.id, userEmail: u.email });
    expect(await membershipsForUser(u.id)).toHaveLength(3);
    await expect(createOrgForUser({ userId: u.id, orgName: 'Fourth' })).resolves.toMatchObject({
      orgId: expect.any(String),
    });
  });
});

describe('the boot check', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a superuser identity URL on every path', async () => {
    // IDENTITY_DATABASE_URL = the superuser test URL.
    const env = { ...process.env, IDENTITY_DATABASE_URL: process.env.DATABASE_URL };
    await expect(connection.verifyDatabaseRoles(env)).rejects.toThrow(
      /refuses to run.*rolsuper=true.*IDENTITY_DATABASE_URL/,
    );
  });

  it('refuses a superuser app URL too, naming that lane', async () => {
    const env = { ...process.env, APP_DATABASE_URL: process.env.DATABASE_URL };
    await expect(connection.verifyDatabaseRoles(env)).rejects.toThrow(
      /refuses to run.*rolsuper=true.*APP_DATABASE_URL/,
    );
  });

  /**
   * Both lanes are unprivileged, so the superuser check alone cannot tell them apart.
   * Swapped or reused URLs would put withOrg on makrai_identity, whose identity_lane
   * policy is USING (true): tenant reads of memberships and invitations would stop
   * being scoped to the organisation, silently.
   */
  it('refuses lanes that are swapped or reused, naming the lane and both roles', async () => {
    const appAsIdentity = { ...process.env, APP_DATABASE_URL: process.env.IDENTITY_DATABASE_URL };
    await expect(connection.verifyDatabaseRoles(appAsIdentity)).rejects.toThrow(
      /APP_DATABASE_URL connects as 'makrai_identity'.*must connect as 'makrai_app'/,
    );
    const identityAsApp = { ...process.env, IDENTITY_DATABASE_URL: process.env.APP_DATABASE_URL };
    await expect(connection.verifyDatabaseRoles(identityAsApp)).rejects.toThrow(
      /IDENTITY_DATABASE_URL connects as 'makrai_app'.*must connect as 'makrai_identity'/,
    );
  });

  it('refuses an unset identity URL before connecting anywhere', async () => {
    const env = { ...process.env, IDENTITY_DATABASE_URL: undefined };
    await expect(connection.verifyDatabaseRoles(env)).rejects.toThrow(/IDENTITY_DATABASE_URL is not set/);
  });

  it('refuses an identity role with REPLICATION', async () => {
    // A REPLICATION login can take a base backup of the whole cluster wherever pg_hba
    // allows replication connections, whatever its table grants say.
    await testDb.$executeRawUnsafe('ALTER ROLE makrai_identity REPLICATION');
    try {
      await expect(connection.verifyDatabaseRoles(process.env)).rejects.toThrow(
        /refuses to run.*rolreplication=true.*IDENTITY_DATABASE_URL/,
      );
    } finally {
      await testDb.$executeRawUnsafe('ALTER ROLE makrai_identity NOREPLICATION');
    }
  });

  it('accepts the two unprivileged lanes', async () => {
    await expect(connection.verifyDatabaseRoles(process.env)).resolves.toBeUndefined();
  });

  /**
   * register() EXITS on a refusal rather than rejecting: Next 16 keeps serving (every
   * request a 500) after a rejected register(), and never retries it. process.exit is
   * stubbed to throw so the test process survives and the call can be observed.
   */
  function stubExit() {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { exit, logged };
  }

  it('runs from register() in the Node.js runtime, so a privileged URL stops the server starting', async () => {
    const { register } = await import('../../instrumentation');
    const { exit, logged } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('IDENTITY_DATABASE_URL', process.env.DATABASE_URL as string);
    try {
      await expect(register()).rejects.toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
      expect(String(logged.mock.calls[0]?.[1])).toMatch(/refuses to run.*rolsuper=true.*IDENTITY_DATABASE_URL/);
    } finally {
      exit.mockRestore();
      logged.mockRestore();
    }
  });

  it('lets the server start when both lanes are unprivileged', async () => {
    const { register } = await import('../../instrumentation');
    const { exit, logged } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    try {
      await expect(register()).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      logged.mockRestore();
    }
  });

  it('does not run in the edge runtime, where there is no database driver to check with', async () => {
    const { register } = await import('../../instrumentation');
    const { exit, logged } = stubExit();
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    // A URL that could not possibly connect: if register() tried, it would exit.
    vi.stubEnv('IDENTITY_DATABASE_URL', 'postgresql://nobody:x@127.0.0.1:1/none');
    try {
      await expect(register()).resolves.toBeUndefined();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      logged.mockRestore();
    }
  });
});
