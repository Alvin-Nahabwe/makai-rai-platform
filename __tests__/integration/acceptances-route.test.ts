import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { sessionFor, clearSession } from '../helpers/authSession';
import { STUB_LEGAL_TEXTS, currentAcceptances } from '../helpers/legalStub';
import type { AcceptancesRequest } from '@/types/api';

/**
 * Route 30, POST /api/acceptances (contract Routes row 30; FR-ACC-03, FR-ACC-04): records the
 * current version of each posted kind for the signed-in account, which is how an account the
 * gate blocks gets through. Under vitest the registry is the stub of __tests__/setup/legal.ts.
 */

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-pathname': '/acceptances' }) }));
// S-05's client part navigates with useRouter, which needs Next's app router outside a request.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

const { POST } = await import('@/app/api/acceptances/route');
const { missingAcceptances } = await import('@/lib/data/acceptances');

function postAcceptances(body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest('http://localhost/api/acceptances', {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}
const rowsOf = (userId: string) => testDb.consentRecord.findMany({ where: { userId }, orderBy: { consentType: 'asc' } });

beforeEach(async () => {
  await resetDb();
  clearSession();
});

describe('route 30, POST /api/acceptances', () => {
  it('FR-ACC-04: route 30 records the posted kinds for an account blocked by the gate, then the gate opens', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    sessionFor(fx.members.owner.userId);
    const body: AcceptancesRequest = { acceptances: currentAcceptances() };   // the contract's request type (types/api.ts)
    const res = await postAcceptances(body, { origin: 'http://localhost' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual([]);
    expect((await rowsOf(fx.members.owner.userId)).map((r) => [r.consentType, r.version, r.textHash, r.ipAddress])).toEqual([
      ['terms_of_service', '1', STUB_LEGAL_TEXTS[0].sha256, null],
      ['privacy_policy', '1', STUB_LEGAL_TEXTS[1].sha256, null],
      ['cross_border_storage', '1', STUB_LEGAL_TEXTS[2].sha256, null]]);   // ConsentType's declaration order
  });

  it('FR-ACC-04: an unknown kind, a pair without its version, or the old list of kinds answers 422 validation and writes nothing', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    sessionFor(fx.members.owner.userId);
    for (const body of [{ acceptances: [{ kind: 'organisation-agreement', version: '1' }] },
      { acceptances: [...currentAcceptances(['terms']), { kind: 'constructor', version: '1' }] }, { acceptances: [] }, { acceptances: 'terms' },
      { acceptances: [{ kind: 'terms' }] }, { acceptances: [{ kind: 'terms', version: 1 }] }, { acceptances: ['terms'] },
      { kinds: ['terms', 'privacy', 'cross-border-consent'] }, {}, 'not json', null]) {
      const res = await postAcceptances(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'validation', fields: [{ field: 'acceptances' }] });
    }
    expect(await testDb.consentRecord.count({ where: { userId: fx.members.owner.userId } })).toBe(0);
  });

  it('FR-ACC-03: a posted hash is ignored; the rows carry the registry\'s', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    sessionFor(fx.members.owner.userId);
    const res = await postAcceptances({ acceptances: [{ kind: 'terms', version: '1', textHash: 'f'.repeat(64), sha256: 'e'.repeat(64) }],
      textHash: 'f'.repeat(64) });
    expect(res.status).toBe(204);
    expect((await rowsOf(fx.members.owner.userId)).map((r) => [r.version, r.textHash])).toEqual([['1', STUB_LEGAL_TEXTS[0].sha256]]);
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual(['privacy', 'cross-border-consent']);
  });

  it('FR-ACC-03 (threat A5): a version that is not the current one answers 409 with M-39 and writes no row', async () => {
    // The page was rendered before a newer text was published: the person never saw the current one.
    const fx = await buildOrg({ acceptances: 'none' });
    sessionFor(fx.members.owner.userId);
    const res = await postAcceptances({ acceptances: [...currentAcceptances(['privacy']), { kind: 'terms', version: '0' }] });
    expect([res.status, await res.json()]).toEqual([409, {
      error: 'A new version of the terms of service was published on 30 Oct 2026.', code: 'legal_text_changed', missing: ['terms'] }]);
    expect(await testDb.consentRecord.count({ where: { userId: fx.members.owner.userId } })).toBe(0);
  });

  it('NFR-SEC-08: cross-origin POST answers 403 cross_origin', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    sessionFor(fx.members.owner.userId);
    const res = await postAcceptances({ acceptances: currentAcceptances() }, { origin: 'https://evil.example' });
    expect([res.status, (await res.json()).code]).toEqual([403, 'cross_origin']);
    expect(await testDb.consentRecord.count({ where: { userId: fx.members.owner.userId } })).toBe(0);
  });

  it('FR-ACC-04: with no session it answers 401 and writes nothing', async () => {
    const before = await testDb.consentRecord.count();
    const res = await postAcceptances({ acceptances: currentAcceptances(['terms']) });
    expect(res.status).toBe(401);
    expect(await testDb.consentRecord.count()).toBe(before);
  });
});

describe('S-05, the acceptances page (FR-ACC-04)', () => {
  const page = async () => (await import('@/app/(authenticated)/acceptances/page')).default();

  it('FR-ACC-04 UX-22: an account missing acceptances gets the required form with exactly the missing texts', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    await testDb.consentRecord.createMany({ data: [{ userId: fx.members.owner.userId, consentType: 'terms_of_service',
      version: '1', textHash: STUB_LEGAL_TEXTS[0].sha256, granted: true }] });
    sessionFor(fx.members.owner.userId);
    const markup = renderToStaticMarkup(await page());
    expect(markup).toContain('Before you continue');
    expect(markup.match(/type="checkbox"/g)).toHaveLength(2);
    expect(markup).toContain('id="accept-privacy"');
    expect(markup).toContain('id="accept-cross-border-consent"');
    expect(markup).not.toContain('id="accept-terms"');
    expect(markup).toContain('delete your account');
  });

  it('FR-ACC-04: an account with nothing missing or offered is sent home', async () => {
    const fx = await buildOrg();
    sessionFor(fx.members.owner.userId);
    await expect(page()).rejects.toMatchObject({ digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/;30[78];/) });
  });
});
