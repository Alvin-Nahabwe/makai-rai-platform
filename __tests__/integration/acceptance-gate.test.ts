import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { testDb, resetDb } from '../helpers/db';
import { addProject, buildOrg, buildPlatformAdmin, type FixtureAccount } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';
import { fixtureLegalTexts, STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * Gate 3 of SRS 7.1.2 (line 1539), FR-ACC-04 and UX-01: an account without a first acceptance of
 * each of the three texts reaches only S-05, S-06 and S-21 (and their routes: export, deletion,
 * password, sessions, preferences); every other page redirects to /acceptances and every other API
 * route answers 403 acceptances_required. Under vitest the registry is the stub of
 * __tests__/setup/legal.ts, which buildOrg's default accounts accepted.
 *
 * `pageGate` drives requireIdentity() as the proxy would for a page request: proxy.ts sets
 * x-pathname to the request's own path (proxy.ts:68-71), mocked here through next/headers.
 */

let pathname: string | null = null;
vi.mock('next/headers', () => ({
  headers: async () => new Headers(pathname === null ? {} : { 'x-pathname': pathname }),
}));

vi.mock('@/lib/data/acceptances', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/acceptances')>();
  return { ...real, missingAcceptances: vi.fn(real.missingAcceptances) };
});

const { requireIdentity, requireIdentityForApi } = await import('@/lib/auth/identity');
const { missingAcceptances } = await import('@/lib/data/acceptances');

type Account = Pick<FixtureAccount, 'userId'>;

async function asUser<T>(account: Account, fn: () => Promise<T>): Promise<T> {
  sessionFor(account.userId);
  return fn();
}

/** requireIdentity() for a page request at `path`; resolves to the identity or rejects with Next's redirect error. */
function pageGate(account: Account, path: string) {
  pathname = path;
  sessionFor(account.userId);
  return requireIdentity();
}

const redirectTo = (target: string) => expect.objectContaining({
  message: 'NEXT_REDIRECT', digest: expect.stringMatching(new RegExp(`^NEXT_REDIRECT;[a-z]+;${target.replace(/\//g, '\\/')};30[78];`)),
});

const req = (url: string, init: { method: string; body?: unknown } = { method: 'GET' }) =>
  new NextRequest(`http://localhost${url}`, {
    method: init.method,
    headers: { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

async function POST_DECISION(slug: string, projectId: string) {
  const { POST } = await import('@/app/api/v1/orgs/[slug]/projects/[id]/decisions/route');
  return POST(req(`/api/v1/orgs/${slug}/projects/${projectId}/decisions`, { method: 'POST', body: { questionId: 'Q-1' } }),
    { params: Promise.resolve({ slug, id: projectId }) });
}
async function GET_PROJECTS(slug: string) {
  const { GET } = await import('@/app/api/v1/orgs/[slug]/projects/route');
  return GET(req(`/api/v1/orgs/${slug}/projects`), { params: Promise.resolve({ slug }) });
}

beforeEach(async () => {
  await resetDb();
  pathname = null;
  clearSession();
});
afterEach(() => {
  vi.mocked(missingAcceptances).mockClear();
});

describe('the acceptance gate (FR-ACC-04, UX-01, SRS 7.1.2 gate 3)', () => {
  it('FR-ACC-04: a decision POST without the three acceptances answers 403 acceptances_required and writes nothing', async () => {
    const fx = await buildOrg({ acceptances: 'pre-v1' });
    const { id: projectId } = await addProject(fx);
    const before = await testDb.decisionVersion.count();
    const res = await asUser(fx.members.assessor, () => POST_DECISION(fx.org.slug, projectId));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'acceptances_required', missing: ['terms', 'privacy', 'cross-border-consent'] });
    expect(await testDb.decisionVersion.count()).toBe(before);
  });

  it('FR-ACC-04: export and deletion stay usable without acceptances; the dashboard API does not', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    const { GET: GET_EXPORT } = await import('@/app/api/users/me/export/route');
    expect((await asUser(fx.members.owner, () => GET_EXPORT())).status).not.toBe(403);
    expect((await asUser(fx.members.owner, () => GET_PROJECTS(fx.org.slug))).status).toBe(403);
  });

  it('FR-ACC-04: the password, sessions and deletion routes of S-21 answer something other than acceptances_required', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    const { POST: PASSWORD } = await import('@/app/api/users/me/password/route');
    const { DELETE: SESSIONS } = await import('@/app/api/users/me/sessions/route');
    const { DELETE: DELETE_ME } = await import('@/app/api/users/me/route');
    const answers = [
      await asUser(fx.members.viewer, () => PASSWORD(req('/api/users/me/password', { method: 'POST', body: { currentPassword: 'wrong-password', newPassword: 'NewPassw0rd!2' } }))),
      await asUser(fx.members.viewer, () => DELETE_ME(req('/api/users/me', { method: 'DELETE', body: { confirmation: 'no' } }))),
      await asUser(fx.members.viewer, () => SESSIONS(req('/api/users/me/sessions', { method: 'DELETE' }))),
    ];
    for (const res of answers) expect(await res.clone().text()).not.toContain('acceptances_required');
    expect(answers.map((r) => r.status)).not.toContain(403);
  });

  it('FR-ACC-04: an account holding the three acceptances passes both gates', async () => {
    const fx = await buildOrg();
    await expect(pageGate(fx.members.owner, `/orgs/${fx.org.slug}/dashboard`)).resolves.toMatchObject({ userId: fx.members.owner.userId });
    expect((await asUser(fx.members.owner, () => GET_PROJECTS(fx.org.slug))).status).toBe(200);
  });

  it('UX-01 FR-ACC-04: only /acceptances, /account and /change-password are exempt, by exact path', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    // /change-password (S-29, route 35's page): usable before the acceptances, as route 35 is (C4 ruling RE-5, ACC-b).
    for (const p of ['/acceptances', '/account', '/change-password']) await expect(pageGate(fx.members.owner, p)).resolves.toBeDefined();
    for (const p of ['/orgs/x/dashboard', '/accountx', '/acceptances/x', '/', '/account/', '/ACCOUNT', '/change-password/', '/change-passwordx'])
      await expect(pageGate(fx.members.owner, p), p).rejects.toEqual(redirectTo('/acceptances'));
  });

  it('UX-01 FR-ACC-04: a page request with no x-pathname is not exempt', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    pathname = null;
    sessionFor(fx.members.owner.userId);
    await expect(requireIdentity()).rejects.toEqual(redirectTo('/acceptances'));
  });

  it('UX-01 FR-ACC-08: a flagged account without acceptances is sent to S-29, not S-05', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    await testDb.user.update({ where: { id: fx.members.owner.userId }, data: { mustChangePassword: true } });
    await expect(pageGate(fx.members.owner, '/change-password')).resolves.toBeDefined();
    await expect(pageGate(fx.members.owner, '/acceptances')).rejects.toEqual(redirectTo('/change-password'));
    const res = await asUser(fx.members.owner, () => GET_PROJECTS(fx.org.slug));
    expect([res.status, (await res.json()).code]).toEqual([403, 'must_change_password']);
  });

  it('FR-ACC-04: the platform administrator is gated like any account', async () => {
    const admin = await buildPlatformAdmin({ acceptances: 'none' });
    await expect(pageGate(admin, '/admin/users')).rejects.toEqual(redirectTo('/acceptances'));
    await expect(asUser(admin, () => requireIdentityForApi())).rejects.toMatchObject({ code: 'acceptances_required' });
  });

  it('FR-ACC-04: allowMissingAcceptances lets only the API gate through, and only when passed', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    await expect(asUser(fx.members.owner, () => requireIdentityForApi())).rejects.toMatchObject({
      status: 403, code: 'acceptances_required', extra: { missing: ['terms', 'privacy', 'cross-border-consent'] } });
    await expect(asUser(fx.members.owner, () => requireIdentityForApi({ allowMissingAcceptances: true }))).resolves.toMatchObject({ userId: fx.members.owner.userId });
  });

  it('FR-ACC-04: a failure to read the acceptances refuses the request, on pages and routes alike', async () => {
    const fx = await buildOrg();
    const outage = new Error('simulated: consent_records unreadable');
    vi.mocked(missingAcceptances).mockRejectedValueOnce(outage);
    await expect(asUser(fx.members.owner, () => requireIdentityForApi())).rejects.toBe(outage);
    vi.mocked(missingAcceptances).mockRejectedValueOnce(outage);
    await expect(pageGate(fx.members.owner, `/orgs/${fx.org.slug}/dashboard`)).rejects.toBe(outage);
  });

  it('FR-ACC-04 (harness): under vitest the registry serves STUB_LEGAL_TEXTS and a stub agreement, and fixture accounts accept them', async () => {
    const { currentLegalText, legalTextHistory, legalTextVersion, LEGAL_KINDS } = await import('@/lib/legal/registry');
    expect(fixtureLegalTexts()).toEqual(STUB_LEGAL_TEXTS);
    for (const t of STUB_LEGAL_TEXTS) {
      expect(currentLegalText(t.kind)).toEqual(t);
      expect(legalTextHistory(t.kind)).toEqual([t]);
      expect(legalTextVersion(t.kind, '1')).toEqual(t);
    }
    expect(LEGAL_KINDS.map((k) => currentLegalText(k).version)).toEqual(['1', '1', '1', '1']);
    expect(currentLegalText('organisation-agreement')).toMatchObject({ kind: 'organisation-agreement', acceptance: 'required' });
    expect(legalTextVersion('privacy', '2')).toBeNull();
  });

  it('NFR-SEC-07 (comment): identity.ts says only sign-in and the session endpoint re-sign, not every request', () => {
    const flat = readFileSync('lib/auth/identity.ts', 'utf8').replace(/\s*\n\s*\*\s?/g, ' ');
    expect(flat).not.toMatch(/on every hit|every `auth\(\)` call/);
    expect(flat).toContain('only when it runs through the session endpoint');
    expect(flat).toContain('drops its Set-Cookie');
  });
});
