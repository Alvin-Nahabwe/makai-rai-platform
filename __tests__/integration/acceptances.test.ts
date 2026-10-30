import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * Acceptance rows and the missing and offered sets (FR-ACC-03, FR-ACC-04, SRS call 4 at line 5711).
 *
 * The registry is this file's own mock (the vi.hoisted pattern of contract E-6): by default the
 * three stub texts of legalStub.ts, which buildOrg's default accounts accept (fixtureLegalTexts()
 * reads the registry in force), with any kind replaced by the versions a case names through
 * `useRegistry`; `useActualRegistry` switches to the shipped files of data/legal.
 */
const registry = vi.hoisted(() => ({ texts: null as null | Partial<Record<string, LegalTextVersion[]>> }));

vi.mock('@/lib/legal/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/legal/registry')>();
  const history = (k: LegalTextKind): LegalTextVersion[] => registry.texts?.[k] ?? real.legalTextHistory(k);
  return {
    ...real,
    legalTextHistory: (k: LegalTextKind) => [...history(k)],
    currentLegalText: (k: LegalTextKind) => {
      const h = history(k);
      if (h.length === 0) throw new Error(`no legal text of kind ${k}`);
      return h[h.length - 1];
    },
    legalTextVersion: (k: LegalTextKind, v: string) => history(k).find((t) => t.version === v) ?? null,
  };
});

const { currentLegalText, loadLegalRegistry } = await import('@/lib/legal/registry');
const { missingAcceptances, offeredAcceptances, recordAcceptances, myAcceptances, acceptanceRows } =
  await import('@/lib/data/acceptances');

const stub = (k: string) => STUB_LEGAL_TEXTS.find((t) => t.kind === k)!;
/** What buildOrg's default accounts accepted: the stub version 1 of each kind. */
const PRIVACY_V1 = stub('privacy');
/** Task 1's fixture privacy version 2 (published 2026-12-01), loaded by the real loader. */
const PRIVACY_V2 = loadLegalRegistry('__tests__/fixtures/legal').get('privacy')!.find((t) => t.version === '2')!;

function useRegistry(overrides: Partial<Record<LegalTextKind, LegalTextVersion[]>>): void {
  registry.texts = { terms: [stub('terms')], privacy: [PRIVACY_V1], 'cross-border-consent': [stub('cross-border-consent')], ...overrides };
}
function useActualRegistry(): void {
  registry.texts = null;
}

beforeEach(async () => {
  await resetDb();
  useRegistry({});
});
afterEach(() => {
  useActualRegistry();
});

describe('acceptance rows (FR-ACC-03, FR-ACC-04)', () => {
  it('FR-ACC-04: pre-v1 1.0 rows are not acceptances', async () => {
    const fx = await buildOrg({ acceptances: 'pre-v1' });
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual(['terms', 'privacy', 'cross-border-consent']);
  });

  it('FR-ACC-03: recorded rows carry the current registry version and hash, one row per kind, no IP address', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    useActualRegistry();
    await recordAcceptances(fx.members.owner.userId, ['terms', 'privacy', 'cross-border-consent']);
    const rows = await testDb.consentRecord.findMany({ where: { userId: fx.members.owner.userId } });
    expect(rows.map((r) => [r.consentType, r.version, r.textHash, r.ipAddress]).sort()).toEqual([
      ['cross_border_storage', '1', currentLegalText('cross-border-consent').sha256, null],
      ['privacy_policy', '1', currentLegalText('privacy').sha256, null],
      ['terms_of_service', '1', currentLegalText('terms').sha256, null]].sort());
    expect(rows.every((r) => r.granted)).toBe(true);
    await recordAcceptances(fx.members.owner.userId, ['terms']);
    expect(await testDb.consentRecord.count({ where: { userId: fx.members.owner.userId } })).toBe(3);
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual([]);
  });

  it('FR-ACC-04: a newer offered version is offered, not missing; a newer required version is missing', async () => {
    const fx = await buildOrg();                       // accepted privacy v1
    useRegistry({ privacy: [PRIVACY_V1, { ...PRIVACY_V2, acceptance: 'offered' }] });
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual([]);
    expect((await offeredAcceptances(fx.members.owner.userId)).map((t) => [t.kind, t.version])).toEqual([['privacy', '2']]);
    useRegistry({ privacy: [PRIVACY_V1, { ...PRIVACY_V2, acceptance: 'required' }] });
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual(['privacy']);
    expect(await offeredAcceptances(fx.members.owner.userId)).toEqual([]);
  });

  it('FR-ACC-03 (S-21 data): myAcceptances lists the latest row of each kind', async () => {
    const fx = await buildOrg();
    expect((await myAcceptances(fx.members.owner.userId)).map((a) => [a.kind, a.version])).toEqual([
      ['terms', '1'], ['privacy', '1'], ['cross-border-consent', '1']]);
  });

  it('FR-ACC-04: a row of the right version whose hash is not the registry\'s is not an acceptance', async () => {
    // buildOrg's rows carry the stub texts' hashes; the actual registry's version 1 files hash differently.
    const fx = await buildOrg();
    useActualRegistry();
    expect(currentLegalText('privacy').sha256).not.toBe(PRIVACY_V1.sha256);
    expect(await missingAcceptances(fx.members.owner.userId)).toEqual(['terms', 'privacy', 'cross-border-consent']);
    expect(await offeredAcceptances(fx.members.owner.userId)).toEqual([]);
  });

  it('FR-ACC-04: a refused (granted false) row and a row of another consent type do not count', async () => {
    const fx = await buildOrg({ acceptances: 'none' });
    const userId = fx.members.owner.userId;
    await testDb.consentRecord.createMany({ data: [
      { userId, consentType: 'terms_of_service', version: '1', textHash: stub('terms').sha256, granted: false },
      { userId, consentType: 'privacy_policy', version: '1', textHash: stub('cross-border-consent').sha256, granted: true },
      { userId, consentType: 'research_data_usage', version: '1', textHash: stub('cross-border-consent').sha256, granted: false, voidedAt: new Date(), voidReason: 'test' },
    ] });
    expect(await missingAcceptances(userId)).toEqual(['terms', 'privacy', 'cross-border-consent']);
    expect(await myAcceptances(userId)).toEqual([expect.objectContaining({ kind: 'privacy' })]);
  });

  it('FR-ACC-03 FR-ACC-04: accepting an offered version records it once, and it is then neither missing nor offered', async () => {
    const fx = await buildOrg();
    const userId = fx.members.owner.userId;
    useRegistry({ privacy: [PRIVACY_V1, { ...PRIVACY_V2, acceptance: 'offered' }] });
    await recordAcceptances(userId, ['privacy', 'privacy', 'terms']);
    const privacyRows = await testDb.consentRecord.findMany({ where: { userId, consentType: 'privacy_policy' }, orderBy: { grantedAt: 'asc' } });
    expect(privacyRows.map((r) => [r.version, r.textHash])).toEqual([['1', PRIVACY_V1.sha256], ['2', PRIVACY_V2.sha256]]);
    expect(await testDb.consentRecord.count({ where: { userId } })).toBe(4);   // terms already counted: no second row
    expect(await missingAcceptances(userId)).toEqual([]);
    expect(await offeredAcceptances(userId)).toEqual([]);
    expect((await myAcceptances(userId)).find((a) => a.kind === 'privacy')).toMatchObject({ version: '2', sha256: PRIVACY_V2.sha256 });
  });

  it('FR-ACC-03: acceptanceRows writes the current version and hash per kind and no address', () => {
    useActualRegistry();
    expect(acceptanceRows('u1', ['terms', 'cross-border-consent'])).toEqual([
      { userId: 'u1', consentType: 'terms_of_service', version: currentLegalText('terms').version, textHash: currentLegalText('terms').sha256, granted: true },
      { userId: 'u1', consentType: 'cross_border_storage', version: currentLegalText('cross-border-consent').version, textHash: currentLegalText('cross-border-consent').sha256, granted: true },
    ]);
  });
});
