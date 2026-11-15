import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextKind, type LegalTextVersion } from '@/types/legal';
import { resetDb } from '../helpers/db';
import { buildOrg } from '../helpers/recordFixture';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';

/**
 * Plan 1B Task 7: `acceptanceChanges`, what S-05 shows for each text a person must or may accept: the current version,
 * the newest version they accepted before (or none), and whether it blocks (missing) or is offered. T7.1: only the caller's
 * own rows. The registry is this file's own mock: version 1 of each accepted kind (the stub texts buildOrg's accounts
 * accept), and, once a case publishes it, a version 2 of each.
 */
const registry = vi.hoisted(() => ({ texts: null as null | Partial<Record<string, LegalTextVersion[]>> }));
vi.mock('@/lib/legal/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/legal/registry')>();
  const history = (k: LegalTextKind): LegalTextVersion[] => registry.texts?.[k] ?? real.legalTextHistory(k);
  return {
    ...real,
    legalTextHistory: (k: LegalTextKind) => [...history(k)],
    currentLegalText: (k: LegalTextKind) => history(k)[history(k).length - 1],
    legalTextVersion: (k: LegalTextKind, v: string) => history(k).find((t) => t.version === v) ?? null,
  };
});

const { acceptanceChanges } = await import('@/lib/data/acceptances');

const v1 = (k: AcceptedKind) => STUB_LEGAL_TEXTS.find((t) => t.kind === k)!;
const v2 = (k: AcceptedKind, acceptance: 'required' | 'offered' = 'required'): LegalTextVersion => {
  const text = `Stub ${k} v2 for tests only.`;
  return { kind: k, version: '2', publishedOn: '2026-12-01', acceptance, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), text };
};
const onlyV1 = () => { registry.texts = Object.fromEntries(ACCEPTED_KINDS.map((k) => [k, [v1(k)]])); };
const withV2 = (acceptance: 'required' | 'offered' = 'required') => {
  registry.texts = Object.fromEntries(ACCEPTED_KINDS.map((k) => [k, [v1(k), v2(k, acceptance)]]));
};

beforeEach(async () => {
  await resetDb();
  onlyV1();
});
afterEach(() => { registry.texts = null; });

describe('acceptanceChanges (plan 1B Task 7)', () => {
  it('T7.1: reports version 1 accepted and version 2 current for a version-1 account; nothing for a current one', async () => {
    const fx = await buildOrg();   // accepts the registry in force: version 1 of each
    expect(await acceptanceChanges(fx.members.owner.userId)).toEqual([]);
    withV2();
    const changes = await acceptanceChanges(fx.members.owner.userId);
    expect(changes.map((c) => [c.kind, c.lastAccepted, c.current.version, c.state])).toEqual([
      ['terms', '1', '2', 'missing'], ['privacy', '1', '2', 'missing'], ['cross-border-consent', '1', '2', 'missing'],
    ]);
    expect(changes.map((c) => c.kind)).toEqual([...ACCEPTED_KINDS]);
  });

  it('an offered version 2 is reported as offered, with version 1 as the last accepted', async () => {
    const fx = await buildOrg();
    withV2('offered');
    expect((await acceptanceChanges(fx.members.owner.userId)).map((c) => [c.kind, c.lastAccepted, c.state])).toEqual([
      ['terms', '1', 'offered'], ['privacy', '1', 'offered'], ['cross-border-consent', '1', 'offered'],
    ]);
  });

  it('a first acceptance has no last accepted version (pre-v1 rows do not count)', async () => {
    const fx = await buildOrg({ acceptances: 'pre-v1' });
    expect((await acceptanceChanges(fx.members.owner.userId)).map((c) => [c.kind, c.lastAccepted, c.state])).toEqual([
      ['terms', null, 'missing'], ['privacy', null, 'missing'], ['cross-border-consent', null, 'missing'],
    ]);
  });

  it('T7.1: another account\'s rows never appear', async () => {
    const fx = await buildOrg({ acceptances: 'pre-v1' });
    const other = await buildOrg();   // accepted version 1 of each
    withV2();
    // The pre-v1 account has no counting row: another account's version-1 rows must not make it "version 1 accepted".
    expect((await acceptanceChanges(fx.members.owner.userId)).every((c) => c.lastAccepted === null)).toBe(true);
    expect((await acceptanceChanges(other.members.owner.userId)).every((c) => c.lastAccepted === '1')).toBe(true);
  });

  it('T7.1: an empty account id is refused, never read as every account', async () => {
    await expect(acceptanceChanges('')).rejects.toThrow(/account id/);
  });
});
