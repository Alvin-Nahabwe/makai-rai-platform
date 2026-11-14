import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegalTextVersion } from '@/types/legal';
import type { OfferedText } from '@/components/legal/NewerLegalTextOffers';
import { STUB_LEGAL_TEXTS } from '../helpers/legalStub';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { escapeRe } from '../helpers/escapeRe';
import { NOTICE_COPY } from '@/lib/legal/notice/copy';
import { MY_ACCEPTANCES_COPY } from '@/lib/legal/copy';
import { roleWithArticle, welcomeLine } from '@/lib/org/copy';

/**
 * ACC-a Task 12: the three slots ACC-a fills (contract "Screens and slots": the shell's NewerLegalTextNotice, S-21's
 * MyAcceptances, S-08's WelcomeNotice). vitest runs in `node` with no DOM library installed (G-23; reviews/fix-r12.md
 * R12-15), so this file reads react-dom/server markup and the pure rules of the Not now choice; a click is not driven here.
 */
vi.mock('@/lib/data/acceptances', () => ({ offeredAcceptances: vi.fn(async () => []), myAcceptances: vi.fn(async () => []) }));

const { offeredAcceptances, myAcceptances } = await import('@/lib/data/acceptances');
const { NewerLegalTextNotice } = await import('@/components/legal/NewerLegalTextNotice');
const { notNowKey, isNotNow, rememberNotNow, NewerLegalTextOffers, NewerLegalTextOffersView } = await import('@/components/legal/NewerLegalTextOffers');
const { MyAcceptances } = await import('@/components/legal/MyAcceptances');
const { WelcomeNotice } = await import('@/components/account/WelcomeNotice');

type OffersProps = { userId: string; offers: OfferedText[] };
/** The props the server half (NewerLegalTextNotice) gives its client half; its return type does not name them. */
const offersOf = async (userId: string): Promise<OffersProps | undefined> =>
  ((await NewerLegalTextNotice({ userId })) as React.ReactElement<OffersProps> | null)?.props;
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
    const props = await offersOf('u1');
    expect(offeredAcceptances).toHaveBeenCalledWith('u1');
    // The server half hands the client half only what the notice shows.
    expect(props).toEqual({ userId: 'u1', offers: [{ kind: 'privacy', name: 'privacy notice', version: '2', publishedOn: '2026-12-01' }] });
    const markup = html(<NewerLegalTextOffersView offers={props?.offers ?? []} hidden={new Set()} onNotNow={vi.fn()} />);
    // Each notice keeps its status wrapper and holds the kit's info Banner, with the two actions in its action slot.
    expect(markup).toMatch(/<div[^>]*role="status"[^>]*><div class="ui-banner ui-banner--info">/);
    expect(text(markup)).toContain(NOTICE_COPY.published('privacy notice', '1 Dec 2026'));
    expect(NOTICE_COPY.published('privacy notice', '1 Dec 2026')).toBe('A new version of the privacy notice was published on 1 Dec 2026.');
    expect(markup).toMatch(/<a[^>]*class="ui-button ui-button--secondary"[^>]*href="\/acceptances"[^>]*>Read and accept<\/a>/);
    expect(markup).toMatch(/<button[^>]*class="ui-button ui-button--quiet"[^>]*type="button"[^>]*>Not now<\/button>/);
    vi.mocked(offeredAcceptances).mockResolvedValue([]);
    expect(await NewerLegalTextNotice({ userId: 'u1' })).toBeNull();
  });

  it('M-39: one notice per offered text, and none for a text turned down', async () => {
    vi.mocked(offeredAcceptances).mockResolvedValue([{ ...STUB_LEGAL_TEXTS[0], version: '2', publishedOn: '2026-12-02', acceptance: 'offered' }, PRIVACY_V2]);
    const offers = (await offersOf('u1'))?.offers ?? [];
    const markup = html(<NewerLegalTextOffersView offers={offers} hidden={new Set()} onNotNow={vi.fn()} />);
    expect(html(<NewerLegalTextOffersView offers={offers} hidden={new Set(['privacy:2'])} onNotNow={vi.fn()} />).match(/role="status"/g)).toHaveLength(1);
    expect(markup.match(/role="status"/g)).toHaveLength(2);
    expect(text(markup)).toContain('A new version of the terms of service was published on 2 Dec 2026.');
  });

  it('M-39: before it has read sessionStorage the notice renders nothing, so a notice turned down never paints', () => {
    expect(html(<NewerLegalTextOffers userId="u1" offers={[{ kind: 'privacy', name: 'privacy notice', version: '2', publishedOn: '2026-12-01' }]} />)).toBe('');
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
    // A counting row: the published version 1 with its hash (the stub registry of __tests__/setup/legal.ts).
    vi.mocked(myAcceptances).mockResolvedValue([{ kind: 'privacy', version: '1', sha256: STUB_LEGAL_TEXTS[1].sha256, acceptedAt: '2026-10-28T09:00:00.000Z' }]);
    vi.mocked(offeredAcceptances).mockResolvedValue([PRIVACY_V2]);
    const markup = html(await MyAcceptances({ userId: 'u1' }));
    expect(myAcceptances).toHaveBeenCalledWith('u1');
    expect(offeredAcceptances).toHaveBeenCalledWith('u1');
    expect(text(markup)).toContain(MY_ACCEPTANCES_COPY.accepted('Privacy notice', '1', '28 Oct 2026'));
    expect(MY_ACCEPTANCES_COPY.accepted('Privacy notice', '1', '28 Oct 2026')).toBe('Privacy notice, version 1. Accepted on 28 Oct 2026.');
    expect(markup).toMatch(/<a[^>]*href="\/legal\/privacy\/1"[^>]*>Read<\/a>/);
    expect(text(markup)).toContain(MY_ACCEPTANCES_COPY.newerAvailable('2'));
    expect(MY_ACCEPTANCES_COPY.newerAvailable('2')).toBe('Version 2 is now available.');
    expect(markup).toMatch(/<a[^>]*href="\/acceptances"[^>]*>Read and accept<\/a>/);
    expect(markup).not.toMatch(/ · |   /);   // no middle dots and no runs of spaces
    expect(markup).not.toMatch(/<(input|button|select|textarea)\b/);   // a read-only record (7.4.2 S-21)
  });

  it('FR-ACC-03 FR-ACC-04 (S-21): a pre-v1 row that does not count is shown as such, with Read and accept and no Read link', async () => {
    // A v0.5.0 row (version '1.0', no hash) is not an acceptance (lib/data/acceptances.ts) and /legal/<kind>/1.0 is a 404.
    vi.mocked(myAcceptances).mockResolvedValue([
      { kind: 'privacy', version: '1.0', sha256: null, acceptedAt: '2026-05-04T09:00:00.000Z' },
      { kind: 'terms', version: '1', sha256: STUB_LEGAL_TEXTS[0].sha256, acceptedAt: '2026-10-28T09:00:00.000Z' },
    ]);
    const markup = html(await MyAcceptances({ userId: 'u1' }));
    expect(markup).not.toMatch(/href="\/legal\/[^"]*\/1\.0"/);
    expect(text(markup)).toContain(`${MY_ACCEPTANCES_COPY.accepted('Privacy notice', '1.0', '4 May 2026')} ${MY_ACCEPTANCES_COPY.olderVersion}`);
    expect(MY_ACCEPTANCES_COPY.olderVersion).toBe('This was an older version. Accept the current version.');
    expect(markup).toMatch(/<a[^>]*href="\/acceptances"[^>]*>Read and accept<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/legal\/terms\/1"[^>]*>Read<\/a>/);   // the counting row is as before
  });

  it('FR-ACC-03 (S-21): each kind accepted is listed in order; an account with none says so', async () => {
    vi.mocked(myAcceptances).mockResolvedValue([
      { kind: 'terms', version: '1', sha256: 'a'.repeat(64), acceptedAt: '2026-10-28T09:00:00.000Z' },
      { kind: 'cross-border-consent', version: '1', sha256: 'c'.repeat(64), acceptedAt: '2026-10-29T09:00:00.000Z' },
    ]);
    const t = text(html(await MyAcceptances({ userId: 'u1' })));
    expect(t.indexOf('Terms of service, version 1')).toBeLessThan(t.indexOf('Consent to storage abroad, version 1'));
    expect(t).not.toContain('is now available');
    vi.mocked(myAcceptances).mockResolvedValue([]);
    expect(text(html(await MyAcceptances({ userId: 'u1' })))).toContain(MY_ACCEPTANCES_COPY.empty);
    expect(MY_ACCEPTANCES_COPY.empty).toBe('You have not accepted any legal texts yet.');
  });
});

describe('the welcome on S-08 (FR-ACC-01)', () => {
  it('FR-ACC-01 (7.4.2 S-04 / S-05): the welcome names the organisation and the role, as text', () => {
    const markup = html(<WelcomeNotice orgName="Makerere CAI Lab" role="assessor" />);
    expect(markup).toMatch(new RegExp(`<[a-z]+[^>]*role="status"[^>]*>${escapeRe(welcomeLine('Makerere CAI Lab', roleWithArticle('assessor')))}</[a-z]+>`));
    expect(welcomeLine('Makerere CAI Lab', roleWithArticle('assessor'))).toBe('Welcome to Makerere CAI Lab. You are an Assessor.');
    expect(welcomeLine('Lab Two', roleWithArticle('viewer'))).toBe('Welcome to Lab Two. You are a Viewer.');
    for (const hostile of HOSTILE_STRINGS) {
      const m = html(<WelcomeNotice orgName={hostile} role="viewer" />);
      expect(m, hostile).not.toMatch(/<script|<img/i);   // the name is escaped text (it may read "onerror=" as words)
    }
  });
});
