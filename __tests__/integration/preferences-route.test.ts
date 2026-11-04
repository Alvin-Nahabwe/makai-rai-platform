import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * Route 37, PATCH /api/users/me/preferences (contract Routes row 37; FR-FUP-06): the signed-in
 * account turns reminder emails off or on. It writes `reminderEmails` of the caller's own row
 * and nothing else.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/account' }) }));

const { PATCH } = await import('@/app/api/users/me/preferences/route');

const URL_ = 'http://localhost/api/users/me/preferences';
async function patchPrefs(user: { userId: string }, body: unknown, opts: { origin?: string } = {}) {
  sessionFor(user.userId);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.origin !== undefined) {
    headers.host = new URL(URL_).host;                       // assertSameOrigin refuses an Origin with no Host
    headers.origin = opts.origin === 'own' ? new URL(URL_).origin : opts.origin;
  }
  return PATCH(new NextRequest(URL_, { method: 'PATCH', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}
const reminder = async (userId: string) => (await testDb.user.findUniqueOrThrow({ where: { id: userId } })).reminderEmails;

beforeEach(async () => { await resetDb(); clearSession(); });

describe('route 37, PATCH /api/users/me/preferences', () => {
  it('FR-FUP-06: the preference route changes only the caller\'s reminderEmails', async () => {
    const fx = await buildOrg();
    const alice = fx.members.assessor; const bob = fx.members.admin;
    expect((await patchPrefs(alice, { reminderEmails: false })).status).toBe(204);
    expect(await reminder(alice.userId)).toBe(false);
    expect(await reminder(bob.userId)).toBe(true);
    const res = await patchPrefs(alice, { reminderEmails: true, userId: bob.userId, isActive: false });
    expect(res.status).toBe(422);
    expect(await testDb.user.findUniqueOrThrow({ where: { id: bob.userId } })).toMatchObject({ reminderEmails: true, isActive: true });
    expect(await reminder(alice.userId)).toBe(false);          // the refused body wrote nothing
  });

  it('FR-FUP-06: a non-boolean or missing reminderEmails answers 422 and writes nothing', async () => {
    const fx = await buildOrg();
    const u = fx.members.assessor;
    for (const body of [{ reminderEmails: 'false' }, { reminderEmails: 0 }, {}, 'not json', null, []]) {
      const res = await patchPrefs(u, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'validation', fields: [{ field: 'reminderEmails' }] });
    }
    expect(await reminder(u.userId)).toBe(true);
  });

  it('NFR-SEC-08: a preference change from another origin answers 403', async () => {
    const fx = await buildOrg();
    const alice = fx.members.assessor;
    const before = await reminder(alice.userId);
    expect(await (await patchPrefs(alice, { reminderEmails: !before }, { origin: 'https://evil.example' })).json()).toMatchObject({ code: 'cross_origin' });
    expect(await reminder(alice.userId)).toBe(before);
    expect((await patchPrefs(alice, { reminderEmails: !before }, { origin: 'own' })).status).toBe(204);   // control: the request's own origin passes
  });

  it('FR-FUP-06: without a session the route answers 401 and writes nothing', async () => {
    const fx = await buildOrg();
    clearSession();
    const res = await PATCH(new NextRequest(URL_, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reminderEmails: false }) }));
    expect(res.status).toBe(401);
    expect(await reminder(fx.members.assessor.userId)).toBe(true);
  });

  it('FR-FUP-06 FR-ACC-04: a member who has not yet accepted the current texts can still turn reminders off', async () => {
    const fresh = await buildOrg({ label: 'NoAcc', acceptances: 'none' });
    expect((await patchPrefs(fresh.members.viewer, { reminderEmails: false })).status).toBe(204);
    expect(await reminder(fresh.members.viewer.userId)).toBe(false);
  });
});
