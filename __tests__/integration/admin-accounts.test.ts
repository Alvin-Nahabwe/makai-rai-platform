import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, buildPlatformAdmin, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { resolveIdentity, SessionError } from '../../lib/auth/identity';
import { authorizeCredentials } from '../../lib/auth/credentials';
import { listOrganisationsForAdmin } from '../../lib/data/admin';

/**
 * Route 47 (`POST /api/admin/users/[id]/role`, a form POST from S-25): deactivation through the definer
 * function `admin_set_account_active` with its FR-ORG-09 row, and one platform administrator (NFR-SEC-19,
 * SRS line 3003). Driven through the real handler with AUTHZ's route driver; only the session is mocked.
 */

const ROUTE = 'app/api/admin/users/[id]/role/route.ts';

let admin: FixtureAccount;
let fx: OrgFixture;
let loner: { id: string };

/** The admin's session, then a same-origin form POST to the real handler. */
async function form47(actor: { userId: string }, id: string, fields: Record<string, string>): Promise<Response> {
  sessionAs(actor.userId);
  return callRoute(ROUTE, 'POST', { slug: '', params: { id }, body: new URLSearchParams(fields) });
}

/** The token a browser holds for `member`, as lib/auth/callbacks.ts writes it at sign-in. */
async function signedInSession(member: { userId: string }) {
  const { sessionEpoch } = await testDb.user.findUniqueOrThrow({ where: { id: member.userId } });
  return { id: member.userId, sessionEpoch, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}
const resolveIdentityFrom = resolveIdentity;
const lastEvent = (orgId: string) => testDb.organisationEvent.findFirstOrThrow({ where: { orgId }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
const location = (r: Response) => r.headers.get('location') ?? '';

beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  fx = await buildOrg();
  loner = await testDb.user.create({ data: { email: 'loner@fixture.test', name: 'Loner', passwordHash: 'x' } });
});

describe('route 47: deactivation', () => {
  it('FR-ORG-07: a deactivated account is signed out, refused at sign-in, keeps its membership, and reactivation needs a new sign-in', async () => {
    const cookie = await signedInSession(fx.members.assessor);
    await expect(resolveIdentityFrom(cookie)).resolves.toMatchObject({ userId: fx.members.assessor.userId });
    const r = await form47(admin, fx.members.assessor.userId, { action: 'deactivate' });
    expect(r.status).toBe(303);
    expect(location(r)).toMatch(/\/admin\/accounts$/);
    await expect(resolveIdentityFrom(cookie)).rejects.toBeInstanceOf(SessionError);
    expect(await authorizeCredentials({ email: fx.members.assessor.email, password: fx.members.assessor.password })).toBeNull();
    expect(await testDb.membership.count({ where: { userId: fx.members.assessor.userId } })).toBe(1);
    expect(await lastEvent(fx.org.id)).toMatchObject({ action: 'account_deactivated', actorId: admin.userId, actorRole: 'platform_admin', targetUserId: fx.members.assessor.userId });

    expect(location(await form47(admin, fx.members.assessor.userId, { action: 'deactivate' }))).toMatch(/\/admin\/accounts$/);   // toggles back on
    expect(await authorizeCredentials({ email: fx.members.assessor.email, password: fx.members.assessor.password })).not.toBeNull();
    await expect(resolveIdentityFrom(cookie)).rejects.toBeInstanceOf(SessionError);
    expect(await lastEvent(fx.org.id)).toMatchObject({ action: 'account_reactivated', targetUserId: fx.members.assessor.userId });
  });

  it('FR-ORG-07: the administrator cannot deactivate their own account', async () => {
    expect(location(await form47(admin, admin.userId, { action: 'deactivate' }))).toMatch(/\/admin\/accounts\?error=self$/);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: admin.userId } })).isActive).toBe(true);
    expect(await testDb.platformEvent.count()).toBe(0);
  });

  it('FR-ORG-07: deactivating the only active owner needs a request reference', async () => {
    const refused = await form47(admin, fx.members.owner.userId, { action: 'deactivate' });
    expect(location(refused)).toMatch(new RegExp(`/admin/accounts\\?error=request_reference_required&user=${fx.members.owner.userId}$`));
    expect((await testDb.user.findUniqueOrThrow({ where: { id: fx.members.owner.userId } })).isActive).toBe(true);
    expect(location(await form47(admin, fx.members.owner.userId, { action: 'deactivate', requestReference: '   ' }))).toMatch(/error=request_reference_required/);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: fx.members.owner.userId } })).isActive).toBe(true);

    expect(location(await form47(admin, fx.members.owner.userId, { action: 'deactivate', requestReference: 'CTRL-7' }))).toMatch(/\/admin\/accounts$/);
    expect((await listOrganisationsForAdmin()).find((r) => r.orgId === fx.org.id)!.hasActiveOwner).toBe(false);
    expect(await lastEvent(fx.org.id)).toMatchObject({ action: 'account_deactivated', requestReference: 'CTRL-7' });
  });

  it('FR-ORG-09: deactivating an account in no organisation writes one platform_events row', async () => {
    await form47(admin, loner.id, { action: 'deactivate' });
    expect(await testDb.platformEvent.count({ where: { targetUserId: loner.id, action: 'account_deactivated' } })).toBe(1);
    expect(await testDb.platformEvent.count()).toBe(1);
  });
});

describe('route 47: one platform administrator', () => {
  it('NFR-SEC-19: route 47 refuses a second administrator', async () => {
    expect(location(await form47(admin, loner.id, { role: 'admin' }))).toMatch(/\/admin\/accounts\?error=single_admin$/);
    expect(await testDb.user.count({ where: { role: 'admin' } })).toBe(1);
  });

  it('NFR-SEC-04 NFR-SEC-19: route 47 refuses the platform role for a member, naming the membership', async () => {
    expect(location(await form47(admin, fx.members.viewer.userId, { role: 'admin' }))).toMatch(/\/admin\/accounts\?error=has_membership$/);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: fx.members.viewer.userId } })).role).toBe('assessor');
  });

  it('FR-ORG-01 NFR-SEC-19: an account without the platform role is sent away and changes nothing', async () => {
    const before = await testDb.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, role: true, isActive: true, sessionEpoch: true } });
    for (const fields of [{ action: 'deactivate' }, { role: 'admin' }, { role: 'assessor' }]) {
      const r = await form47(fx.members.owner, fx.members.viewer.userId, fields);
      expect({ status: r.status, to: new URL(location(r)).pathname }).toEqual({ status: 303, to: '/' });
    }
    expect(await testDb.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, role: true, isActive: true, sessionEpoch: true } })).toEqual(before);
    expect(await testDb.platformEvent.count()).toBe(0);
  });

  it('NFR-SEC-19: role=assessor on an assessor writes nothing, and a role action does not read the request reference', async () => {
    const before = await testDb.user.findUniqueOrThrow({ where: { id: loner.id } });
    expect(location(await form47(admin, loner.id, { role: 'assessor', requestReference: 'x'.repeat(201) }))).toMatch(/\/admin\/accounts$/);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: loner.id } })).updatedAt).toEqual(before.updatedAt);
  });

  it('NFR-SEC-19 NFR-OBS-01: a refused grant of the platform role is logged, with ids only', async () => {
    const { lines } = await captureLogs(() => form47(admin, loner.id, { role: 'admin' }));
    const refused = lines.filter((l) => l.includes('ADMIN_ACTION') && l.includes('role_grant_refused'));
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain(loner.id);
    expect(scanLines(lines, { markers: false, emails: true })).toEqual([]);
  });

  it('NFR-SEC-08: another origin is refused before anything is read or written', async () => {
    sessionAs(admin.userId);
    const r = await callRoute(ROUTE, 'POST', { slug: '', params: { id: loner.id }, origin: 'https://evil.example', body: new URLSearchParams({ action: 'deactivate' }) });
    expect(r.status).toBe(403);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: loner.id } })).isActive).toBe(true);
  });
});
