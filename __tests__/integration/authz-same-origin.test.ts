import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgRole } from '@prisma/client';
import { REMOVED_METHODS, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import { can, type Action } from '../../lib/authz/policy';
import { APPEND_ONLY_TABLES } from '../../lib/data/appendOnly';
import { resetDb, testDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, idsOf, rowCounts, validRequestFor, type Method } from '../helpers/routeDriver';

/**
 * NFR-SEC-08 (SRS lines 2943-2947): a state-changing request that does not come from the platform's own origin
 * is refused with 403 `cross_origin` and changes nothing. Enumerated from disk, not from a list: every
 * `app/api/**\/route.ts` is imported and each exported POST, PATCH, PUT and DELETE is called with
 * `Origin: https://evil.example` and with `Origin: null`, as a caller the route would otherwise serve.
 *
 * Each call carries a body the route would accept, so a handler that wrote before its check would have
 * written: the row counts and a digest of every row of every table that is not append-only must not move.
 */

const EXEMPT: Record<string, string> = {
  'app/api/auth/[...nextauth]/route.ts': 'NextAuth checks its own CSRF token',
  'app/api/internal/reminders/route.ts': 'token only, no cookie; nginx refuses /api/internal/ (contract row 40)',
};

/**
 * One v0.5.0 write route that the contract's list of handlers to fix (00-contract.md, revocation table, row
 * "AUTHZ's generated NFR-SEC-08 test over every write route") does not name, and that is deleted before the
 * release: ACC-a deletes registration (FR-ACC-01). It is not AUTHZ's file to edit, and it needs no session, so a
 * cross-site post gains nothing a direct one would not. Held out only while the file exists; at the release
 * candidate it must be gone. (The organisation-creation route the list also missed, app/api/v1/orgs/route.ts, is
 * checked like every other route: the controller widened AUTHZ's manifest to it.)
 */
const UNGUARDED_UNTIL_REMOVED: Record<string, string> = {
  'app/api/auth/register/route.ts': 'ACC-a deletes it (FR-ACC-01)',
};

const WRITE_METHODS: Method[] = ['POST', 'PATCH', 'PUT', 'DELETE'];

function routeFilesOnDisk(dir = 'app/api'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFilesOnDisk(p);
    return name === 'route.ts' ? [p] : [];
  });
}

/**
 * Every exported write handler of every route file, with the REMOVED_METHODS entries (404 for every caller)
 * dropped. An EXEMPT file is not imported: NextAuth's route re-exports `handlers` from lib/auth, which the
 * session seam replaces.
 */
async function writeHandlersOnDisk(): Promise<Array<[string, Method]>> {
  const out: Array<[string, Method]> = [];
  for (const file of routeFilesOnDisk().sort().filter((f) => !(f in EXEMPT))) {
    const mod = (await import(/* @vite-ignore */ '@/' + file.replace(/\.ts$/, ''))) as Record<string, unknown>;
    for (const m of WRITE_METHODS)
      if (typeof mod[m] === 'function' && !(REMOVED_METHODS[file] ?? []).includes(m as never)) out.push([file, m]);
  }
  return out;
}

const ROLE_ORDER: OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];

/** md5 of every row of every public table that may be updated: projects, memberships, users and the rest. */
async function mutableDigest(): Promise<Record<string, string>> {
  const tables = (await testDb.$queryRaw<{ t: string }[]>`SELECT tablename::text AS t FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT IN ('_prisma_migrations', 'framework_versions') ORDER BY 1`)
    .map((r) => r.t).filter((t) => !APPEND_ONLY_TABLES.includes(t));
  const sql = `SELECT ${tables.map((t) => `(SELECT md5(coalesce(string_agg(x::text, ',' ORDER BY x::text), '')) FROM "${t}" x) AS "${t}"`).join(', ')}`;
  return (await testDb.$queryRawUnsafe<Record<string, string>[]>(sql))[0];
}

const handlers = await writeHandlersOnDisk();
let a: OrgFixture;
let b: OrgFixture;
let platformAdmin: FixtureAccount;
/** An invitation of A addressed to B's viewer, so that viewer's signed-in accept would succeed. */
let acceptToken: string;

beforeAll(async () => {
  await resetDb();
  [a, b] = [await buildOrg({ label: 'origin-a' }), await buildOrg({ label: 'origin-b' })];
  platformAdmin = await buildPlatformAdmin();
  acceptToken = randomBytes(32).toString('hex');
  await testDb.invitation.create({ data: {
    orgId: a.org.id, email: b.members.viewer.email, role: 'viewer', invitedById: a.members.owner.userId,
    tokenHash: createHash('sha256').update(acceptToken).digest('hex'), expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  await idsOf(a, 'app/api/v1/orgs/[slug]/projects/[id]/route.ts');   // build A's objects before any case counts rows
});

/** The caller each route would serve: a member allowed the action, the platform administrator, or nobody. */
function sessionFor(file: string, method: Method): string | null {
  const action = ROUTE_ACTIONS[file]?.[method as 'POST'] as Action | undefined;
  if (action) {
    const role = ROLE_ORDER.find((r) => can(r, action));
    if (!role) throw new Error(`no role may ${action}`);
    return a.members[role].userId;
  }
  if (file.startsWith('app/api/admin/')) return platformAdmin.userId;
  if (file === 'app/api/v1/invitations/[token]/route.ts') return b.members.viewer.userId;
  if (file.startsWith('app/api/users/me/') || file === 'app/api/acceptances/route.ts' || file === 'app/api/v1/orgs/route.ts') return a.members.viewer.userId;
  if (file === 'app/api/v1/invitations/[token]/register/route.ts' || file.startsWith('app/api/password-reset/')) return null;
  throw new Error(`authz-same-origin: no caller for ${method} ${file}`);
}

/** The parameters, query and body each route would accept from that caller. */
async function requestFor(file: string, method: Method): Promise<{ params: Record<string, string>; query?: Record<string, string>; body?: unknown }> {
  const params = await idsOf(a, file);
  if (ROUTE_ACTIONS[file]?.[method as 'POST']) return { params, ...validRequestFor(file, method, params) };
  switch (file) {
    case 'app/api/users/me/route.ts': return { params, body: { confirmation: 'DELETE MY ACCOUNT' } };
    case 'app/api/users/me/password/route.ts': return { params, body: { currentPassword: a.members.viewer.password, newPassword: 'ProbeNewPassword123!' } };
    case 'app/api/v1/invitations/[token]/route.ts': return { params: { ...params, token: acceptToken } };
    case 'app/api/v1/invitations/[token]/register/route.ts': return { params, body: { name: 'Probe Invitee', password: 'ProbeNewPassword123!', termsAccepted: true } };
    case 'app/api/admin/users/[id]/role/route.ts': return { params, body: new URLSearchParams({ action: 'deactivate' }) };
    case 'app/api/v1/orgs/route.ts': return { params, body: { orgName: 'Probe organisation' } };
    default: return { params, body: {} };
  }
}

describe('every write refuses another origin (NFR-SEC-08)', () => {
  it('NFR-SEC-08: the write handlers are read from disk', () => {
    expect(handlers.length).toBeGreaterThan(40);
    expect(handlers).toContainEqual(['app/api/admin/users/[id]/role/route.ts', 'POST']);
  });

  for (const [file, method] of handlers.filter(([f]) => !(f in UNGUARDED_UNTIL_REMOVED)))
    for (const origin of ['https://evil.example', null])
      it(`NFR-SEC-08: ${method} ${file} refuses another origin and changes nothing (Origin: ${origin})`, async () => {
        sessionAs(sessionFor(file, method));
        const req = await requestFor(file, method);
        const [counts, digest] = [await rowCounts(), await mutableDigest()];
        const res = await callRoute(file, method, { slug: a.org.slug, origin, ...req });
        expect({ status: res.status, code: res.headers.get('content-type')?.includes('json') ? (await res.json()).code : null })
          .toEqual({ status: 403, code: 'cross_origin' });
        expect(await rowCounts()).toEqual(counts);
        expect(await mutableDigest()).toEqual(digest);
      });

  it('NFR-SEC-08: every exempt route still exists and has a reason', () => {
    for (const [f, reason] of Object.entries(EXEMPT)) expect({ f, exists: existsSync(f), reason: reason.length > 0 }).toEqual({ f, exists: true, reason: true });
  });

  // Runs only with RELEASE_CANDIDATE=1 (set by V and RC, 00-contract.md "How to use this contract" rule 6), so an
  // ordinary run reports it skipped, not passed, as __tests__/lint/no-contract-stubs.test.ts does.
  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-SEC-08: every route held out until its removal is gone at the release candidate', () => {
    expect(Object.keys(UNGUARDED_UNTIL_REMOVED).filter((f) => existsSync(f))).toEqual([]);
  });

  it('NFR-SEC-08: a route held out until its removal is a write route while it exists', () => {
    for (const f of Object.keys(UNGUARDED_UNTIL_REMOVED).filter((x) => existsSync(x)))
      expect({ f, write: handlers.some(([h]) => h === f) }).toEqual({ f, write: true });
  });
});
