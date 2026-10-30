import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PENDING_ROUTES, REMOVED_METHODS, ROUTE_ACTIONS } from '../../lib/authz/routeActions';
import type { Action } from '../../lib/authz/policy';
import { resetDb, testDb } from '../helpers/db';
import { mutableDigest } from '../helpers/digest';
import { roleWith } from '../helpers/authzCases';
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

const WRITE_METHODS: Method[] = ['POST', 'PATCH', 'PUT', 'DELETE'];
/** Open registration (deleted by ACC-a, FR-ACC-01) answers 403 registration_closed before anything else unless
 * ALLOW_OPEN_REGISTRATION is "true", so its case runs with registration open: the refusal must be the origin's. */
const REGISTER = 'app/api/auth/register/route.ts';

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
  if (action) return a.members[roleWith(action)].userId;
  if (file.startsWith('app/api/admin/')) return platformAdmin.userId;
  if (file === 'app/api/v1/invitations/[token]/route.ts') return b.members.viewer.userId;
  if (file.startsWith('app/api/users/me/') || file === 'app/api/acceptances/route.ts' || file === 'app/api/v1/orgs/route.ts') return a.members.viewer.userId;
  if (file === 'app/api/v1/invitations/[token]/register/route.ts' || file === REGISTER || file.startsWith('app/api/password-reset/')) return null;
  throw new Error(`authz-same-origin: no caller for ${method} ${file}`);
}

/** The parameters, query and body each route would accept from that caller. */
async function requestFor(file: string, method: Method): Promise<{ params: Record<string, string>; query?: Record<string, string>; body?: unknown }> {
  const params = await idsOf(a, file);
  if (ROUTE_ACTIONS[file]?.[method as 'POST']) return { params, ...validRequestFor(file, method, params) };
  switch (file) {
    case 'app/api/users/me/route.ts': return { params, body: { confirmation: 'DELETE MY ACCOUNT' } };
    case 'app/api/users/me/sessions/route.ts': return { params };   // sign out everywhere takes no body
    case 'app/api/users/me/password/route.ts': return { params, body: { currentPassword: a.members.viewer.password, newPassword: 'ProbeNewPassword123!' } };
    case 'app/api/v1/invitations/[token]/route.ts': return { params: { ...params, token: acceptToken } };
    case 'app/api/v1/invitations/[token]/register/route.ts': return { params, body: { name: 'Probe Invitee', password: 'ProbeNewPassword123!', termsAccepted: true } };
    case 'app/api/admin/users/[id]/role/route.ts': return { params, body: new URLSearchParams({ action: 'deactivate' }) };
    case 'app/api/v1/orgs/route.ts': return { params, body: { orgName: 'Probe organisation' } };
    case REGISTER: return { params, body: { name: 'Probe Person', orgName: 'Probe organisation', email: `probe-${randomBytes(4).toString('hex')}@fixture.test`, password: 'ProbeNewPassword123!', termsAccepted: true } };
    default:
      // A pending stub refuses or answers 501 before it reads a body; a route its producer has implemented must be
      // given a body it would accept here, or "changes nothing" proves less than it says.
      if (PENDING_ROUTES.includes(file)) return { params, body: {} };
      throw new Error(`add a body for ${method} ${file} in requestFor, __tests__/integration/authz-same-origin.test.ts`);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every write refuses another origin (NFR-SEC-08)', () => {
  it('NFR-SEC-08: the write handlers are read from disk', () => {
    expect(handlers.length).toBeGreaterThan(40);
    expect(handlers).toContainEqual(['app/api/admin/users/[id]/role/route.ts', 'POST']);
  });

  for (const [file, method] of handlers)
    for (const origin of ['https://evil.example', null])
      it(`NFR-SEC-08: ${method} ${file} refuses another origin and changes nothing (Origin: ${origin})`, async () => {
        if (file === REGISTER) vi.stubEnv('ALLOW_OPEN_REGISTRATION', 'true');
        sessionAs(sessionFor(file, method));
        const req = await requestFor(file, method);
        const [counts, digest] = [await rowCounts(), await mutableDigest()];
        const res = await callRoute(file, method, { slug: a.org.slug, origin, ...req });
        expect({ status: res.status, code: res.headers.get('content-type')?.includes('json') ? (await res.json()).code : null })
          .toEqual({ status: 403, code: 'cross_origin' });
        expect(await rowCounts()).toEqual(counts);
        expect(await mutableDigest()).toEqual(digest);
      });

  it('NFR-SEC-08: an implemented write route with no body here fails naming the file and the table to edit', async () => {
    await expect(requestFor('app/api/no-such-write/route.ts', 'POST')).rejects.toThrow(
      'add a body for POST app/api/no-such-write/route.ts in requestFor, __tests__/integration/authz-same-origin.test.ts');
  });

  it('NFR-OBS-05: an unmapped error in registration answers 500 internal_error with a support reference, as every route does', async () => {
    vi.stubEnv('ALLOW_OPEN_REGISTRATION', 'true');
    sessionAs(null);
    const res = await callRoute(REGISTER, 'POST', { slug: a.org.slug, body: 'not json' });   // same origin; the body cannot be parsed
    const body = await res.json();
    expect({ status: res.status, code: body.code, reference: typeof body.reference }).toEqual({ status: 500, code: 'internal_error', reference: 'string' });
  });

  it('NFR-SEC-08: every exempt route still exists and has a reason', () => {
    for (const [f, reason] of Object.entries(EXEMPT)) expect({ f, exists: existsSync(f), reason: reason.length > 0 }).toEqual({ f, exists: true, reason: true });
  });
});
