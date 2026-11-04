import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegalTextVersion } from '@/types/legal';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';
import { HOSTILE_STRINGS } from '../helpers/hostile';

/**
 * ACC-a Task 12: the three slots ACC-a fills (contract "Screens and slots": the shell's NewerLegalTextNotice, S-21's
 * MyAcceptances, S-08's WelcomeNotice). vitest runs in `node` with no DOM library installed (G-23; reviews/fix-r12.md
 * R12-15), so this file reads react-dom/server markup and the pure rules of the Not now choice; a click is not driven here.
 */
vi.mock('@/lib/data/acceptances', () => ({ offeredAcceptances: vi.fn(async () => []), myAcceptances: vi.fn(async () => []) }));

const { offeredAcceptances, myAcceptances } = await import('@/lib/data/acceptances');
const { NewerLegalTextNotice } = await import('@/components/legal/NewerLegalTextNotice');
const { notNowKey, isNotNow, rememberNotNow } = await import('@/components/legal/NewerLegalTextOffers');
const { MyAcceptances } = await import('@/components/legal/MyAcceptances');
const { WelcomeNotice } = await import('@/components/account/WelcomeNotice');

const html = (el: React.ReactElement | null) => (el === null ? '' : renderToStaticMarkup(el));
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');
const PRIVACY_V2: LegalTextVersion = { ...STUB_LEGAL_TEXTS[1], version: '2', publishedOn: '2026-12-01', acceptance: 'offered', sha256: 'b'.repeat(64) };

/** A Storage stand-in; `broken` throws on every access, as a blocked or full sessionStorage does. */
function storage(broken = false): Storage {
  const m = new Map<string, string>();
  const guard = <T,>(f: () => T): T => { if (broken) throw new DOMException('blocked', 'SecurityError'); return f(); };
  return {
    get length() { return guard(() => m.size); }, clear: () => guard(() => m.clear()), key: (i) => guard(() => [...m.keys()][i] ?? null),
    getItem: (k) => guard(() => m.get(k) ?? null), setItem: (k, v) => guard(() => { m.set(k, v); }), removeItem: (k) => guard(() => { m.delete(k); }),
  };
}

beforeEach(() => {
  vi.mocked(offeredAcceptances).mockReset().mockResolvedValue([]);
  vi.mocked(myAcceptances).mockReset().mockResolvedValue([]);
});

describe('the newer-text notice (M-39, FR-ACC-04)', () => {
  it('M-39 FR-ACC-04: a newer offered version shows the notice with both actions; nothing offered shows nothing', async () => {
    vi.mocked(offeredAcceptances).mockResolvedValue([PRIVACY_V2]);
    const markup = html(await NewerLegalTextNotice({ userId: 'u1' }));
    expect(offeredAcceptances).toHaveBeenCalledWith('u1');
    expect(markup).toMatch(/<div[^>]*role="status"[^>]*>A new version of the privacy notice was published on 1 Dec 2026\. /);
    expect(markup).toMatch(/<a[^>]*href="\/acceptances"[^>]*>Read and accept<\/a>/);
    expect(markup).toMatch(/<button[^>]*type="button"[^>]*>Not now<\/button>/);
    vi.mocked(offeredAcceptances).mockResolvedValue([]);
    expect(await NewerLegalTextNotice({ userId: 'u1' })).toBeNull();
  });

  it('M-39: one notice per offered text', async () => {
    vi.mocked(offeredAcceptances).mockResolvedValue([{ ...STUB_LEGAL_TEXTS[0], version: '2', publishedOn: '2026-12-02', acceptance: 'offered' }, PRIVACY_V2]);
    const markup = html(await NewerLegalTextNotice({ userId: 'u1' }));
    expect(markup.match(/role="status"/g)).toHaveLength(2);
    expect(text(markup)).toContain('A new version of the terms of service was published on 2 Dec 2026.');
  });

  it('M-39: Not now is kept per account, kind and version in sessionStorage, and a storage that throws only means the notice shows again', () => {
    expect(notNowKey('u1', 'privacy', '2')).toBe('makrai.legal.notNow:u1:privacy:2');
    const s = storage();
    expect(isNotNow(s, 'u1', 'privacy', '2')).toBe(false);
    rememberNotNow(s, 'u1', 'privacy', '2');
    expect(isNotNow(s, 'u1', 'privacy', '2')).toBe(true);
    expect(isNotNow(s, 'u1', 'privacy', '3')).toBe(false);   // a newer version shows again
    expect(isNotNow(s, 'u2', 'privacy', '2')).toBe(false);   // another account on the same browser
    const broken = storage(true);
    expect(() => rememberNotNow(broken, 'u1', 'privacy', '2')).not.toThrow();
    expect(isNotNow(broken, 'u1', 'privacy', '2')).toBe(false);
    expect(isNotNow(null, 'u1', 'privacy', '2')).toBe(false);
  });
});

describe('My acceptances on S-21 (FR-ACC-03, FR-ACC-04)', () => {
  it('FR-ACC-03 FR-ACC-04 (S-21): My acceptances reads its own data from the user id, lists kind, version and date, and links a newer version to S-05', async () => {
    vi.mocked(myAcceptances).mockResolvedValue([{ kind: 'privacy', version: '1', sha256: 'a'.repeat(64), acceptedAt: '2026-10-28T09:00:00.000Z' }]);
    vi.mocked(offeredAcceptances).mockResolvedValue([PRIVACY_V2]);
    const markup = html(await MyAcceptances({ userId: 'u1' }));
    expect(myAcceptances).toHaveBeenCalledWith('u1');
    expect(offeredAcceptances).toHaveBeenCalledWith('u1');
    expect(text(markup)).toMatch(/Privacy notice v1 . accepted 28 Oct 2026/);
    expect(markup).toMatch(/<a[^>]*href="\/legal\/privacy\/1"[^>]*>Read<\/a>/);
    expect(text(markup)).toContain('A newer version (v2) exists');
    expect(markup).toMatch(/<a[^>]*href="\/acceptances"[^>]*>Review<\/a>/);
    expect(markup).not.toMatch(/<(input|button|select|textarea)\b/);   // a read-only record (7.4.2 S-21)
  });

  it('FR-ACC-03 (S-21): each kind accepted is listed in order; an account with none says so', async () => {
    vi.mocked(myAcceptances).mockResolvedValue([
      { kind: 'terms', version: '1', sha256: 'a'.repeat(64), acceptedAt: '2026-10-28T09:00:00.000Z' },
      { kind: 'cross-border-consent', version: '1', sha256: 'c'.repeat(64), acceptedAt: '2026-10-29T09:00:00.000Z' },
    ]);
    const t = text(html(await MyAcceptances({ userId: 'u1' })));
    expect(t.indexOf('Terms of service v1')).toBeLessThan(t.indexOf('Cross-border storage consent v1'));
    expect(t).not.toContain('A newer version');
    vi.mocked(myAcceptances).mockResolvedValue([]);
    expect(text(html(await MyAcceptances({ userId: 'u1' })))).toContain('No acceptance is recorded for this account.');
  });
});

describe('the welcome on S-08 (FR-ACC-01)', () => {
  it('FR-ACC-01 (7.4.2 S-04 / S-05): the welcome names the organisation and the role, as text', () => {
    const markup = html(<WelcomeNotice orgName="Makerere CAI Lab" role="assessor" />);
    expect(markup).toMatch(/<[a-z]+[^>]*role="status"[^>]*>Welcome to Makerere CAI Lab\. Your role is assessor\.<\/[a-z]+>/);
    for (const hostile of HOSTILE_STRINGS) {
      const m = html(<WelcomeNotice orgName={hostile} role="viewer" />);
      expect(m, hostile).not.toMatch(/<script|<img/i);   // the name is escaped text (it may read "onerror=" as words)
    }
  });
});
