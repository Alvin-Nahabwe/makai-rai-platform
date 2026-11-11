import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LegalTextVersion } from '@/types/legal';
import { HOSTILE_STRINGS } from '../helpers/hostile';

/**
 * S-06, the public legal text pages (FR-ACC-02, SRS line 479; 7.1.5 line 1629). The registry is the actual
 * module, except that privacy is served from the fixture tree of `legal-registry.test.ts`
 * (`__tests__/fixtures/legal/privacy`: version 1 of 2 Nov 2026 and version 2 of 1 Dec 2026), so the pages
 * have a current version and a past one to show; one case swaps in a third version (`privacyHistory`, the
 * `vi.hoisted` pattern of contract E-6) and puts the two fixture versions back after it. The other three kinds
 * are the shipped version-1 files. Hashes are computed here from the files' bytes, independently of the registry.
 */
const privacyHistory = vi.hoisted(() => ({ versions: [] as LegalTextVersion[], fixture: [] as LegalTextVersion[] }));
vi.mock('@/lib/legal/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/legal/registry')>();
  const fixture = actual.loadLegalRegistry('__tests__/fixtures/legal').get('privacy');
  if (!fixture || fixture.length !== 2) throw new Error('the fixture tree must hold privacy versions 1 and 2');
  privacyHistory.fixture = [...fixture];
  privacyHistory.versions = [...fixture];
  const privacy = () => privacyHistory.versions;
  return {
    ...actual,
    currentLegalText: (kind: LegalTextVersion['kind']) =>
      kind === 'privacy' ? privacy()[privacy().length - 1] : actual.currentLegalText(kind),
    legalTextHistory: (kind: LegalTextVersion['kind']) =>
      kind === 'privacy' ? [...privacy()] : actual.legalTextHistory(kind),
    legalTextVersion: (kind: LegalTextVersion['kind'], version: string) =>
      kind === 'privacy' ? (privacy().find((t) => t.version === version) ?? null) : actual.legalTextVersion(kind, version),
  };
});
afterEach(() => {
  privacyHistory.versions = [...privacyHistory.fixture];
});
const { LEGAL_KINDS, currentLegalText, legalTextHistory, legalTextVersion } = await import('@/lib/legal/registry');
const actualRegistry = await vi.importActual<typeof import('@/lib/legal/registry')>('@/lib/legal/registry');

const KindModule = await import('@/app/(public)/legal/[kind]/page');
const VersionModule = await import('@/app/(public)/legal/[kind]/[version]/page');
const { LegalTextView } = await import('@/components/legal/LegalTextView');
const KindPage = KindModule.default;
const VersionPage = VersionModule.default;

const FIX = '__tests__/fixtures/legal';
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Written independently of the component: 7.5.8, "lower-case hexadecimal in groups of four, separated by spaces". */
const groupsOfFour = (hex: string) => (hex.match(/.{4}/g) ?? []).join(' ');
/** The text after the `---` line, as the file holds it. A file without that line is a broken fixture, not an empty text. */
const bodyOf = (path: string) => {
  const content = readFileSync(path, 'utf8');
  const at = content.indexOf('\n---\n');
  if (at < 0) throw new Error(`${path} has no line holding only ---`);
  return content.slice(at + '\n---\n'.length);
};
/** Undoes React's text escaping, so the shown words can be compared with the file's. */
const unescaped = (s: string) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** The paragraphs of the text itself: every `<p>` after the hash block, which closes the text's header. */
const textParagraphs = (html: string) =>
  [...html.slice(html.indexOf('</dl>')).matchAll(/<p[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]);

/** The blocks of the text itself in order, headings (h2) and paragraphs alike: what a reader is shown of its words. */
const textBlocks = (html: string) =>
  [...html.slice(html.indexOf('</dl>')).matchAll(/<(p|h2)[^>]*>([^<]*)<\/\1>/g)].map((m) => m[2]);

const PRIVACY_V1 = { sha256: sha(`${FIX}/privacy/1.md`), text: bodyOf(`${FIX}/privacy/1.md`) };
const PRIVACY_V2 = { sha256: sha(`${FIX}/privacy/2.md`), text: bodyOf(`${FIX}/privacy/2.md`) };

const kindPage = async (kind: string) => renderToStaticMarkup(await KindPage({ params: Promise.resolve({ kind }) }));
const versionPage = async (kind: string, version: string) =>
  renderToStaticMarkup(await VersionPage({ params: Promise.resolve({ kind, version }) }));
const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;

describe('S-06 /legal/[kind] and /legal/[kind]/[version]', () => {
  it('FR-ACC-02: /legal/privacy shows the current version, its hash and the past versions', async () => {
    const html = await kindPage('privacy');
    expect(html).toContain('Version 2, published 1 Dec 2026');
    expect(html).toContain(groupsOfFour(PRIVACY_V2.sha256));
    expect(html).not.toContain(groupsOfFour(PRIVACY_V1.sha256));
    expect(textParagraphs(html)).toEqual([
      'Fixture privacy notice, version 2. For tests only.',
      'Second paragraph of the fixture privacy notice, version 2.',
    ]);
    // The past list holds version 1 and not the current version; the current one has its own fixed address.
    const past = html.slice(html.indexOf('<h2>Past versions</h2>'));
    expect(past).toContain('href="/legal/privacy/1"');
    expect(past).toContain('Version 1, published 2 Nov 2026');
    expect(past).not.toContain('href="/legal/privacy/2"');
    expect(html).toContain('href="/legal/privacy/2"');
  });

  it('FR-ACC-02: /legal/privacy/1 shows version 1 with its own text and hash', async () => {
    const html = await versionPage('privacy', '1');
    expect(html).toContain(PRIVACY_V1.text.split('\n\n')[0]);
    expect(textParagraphs(html)).toEqual([
      'Fixture privacy notice, version 1. For tests only.',
      'Second paragraph of the fixture privacy notice, version 1.',
    ]);
    expect(html).toContain('Version 1, published 2 Nov 2026');
    expect(html).toContain(groupsOfFour(PRIVACY_V1.sha256));
    expect(html).not.toContain(groupsOfFour(PRIVACY_V2.sha256));
  });

  it('FR-ACC-02: a past version says it is not the current one and links to the current version', async () => {
    const html = await versionPage('privacy', '1');
    expect(html).toContain('This is an earlier version. The current one is version 2, published 1 Dec 2026.');
    expect(html).toContain('href="/legal/privacy"');
    const current = await versionPage('privacy', '2');
    expect(current).not.toContain('This is an earlier version.');
    expect(current).toContain('href="/legal/privacy"');
  });

  it('FR-ACC-02: an unknown kind or a traversal version answers 404', async () => {
    for (const version of ['..%2Fterms%2F1', '../terms/1', '9', '01', 'constructor', '__proto__', '']) {
      await expect(versionPage('privacy', version), version).rejects.toThrow(NOT_FOUND);
    }
    // A version another kind has is not a version of this kind. Privacy is given a version far past any real one, so
    // terms lacks it however many versions terms is later published with; the premise is asserted, not assumed.
    const ahead = '9999';
    privacyHistory.versions = [...privacyHistory.fixture, { ...privacyHistory.fixture[1], version: ahead }];
    expect(legalTextVersion('privacy', ahead), 'privacy has the version').not.toBeNull();
    expect(legalTextVersion('terms', ahead), 'terms lacks it').toBeNull();
    await expect(versionPage('privacy', ahead)).resolves.toContain(`Version ${ahead}`);
    await expect(versionPage('terms', ahead)).rejects.toThrow(NOT_FOUND);
    // A version past the newest one of the kind is not a version of it; the newest is the registry's, so a published
    // terms version 2 moves this case to 3 without an edit.
    await expect(versionPage('terms', String(Number(currentLegalText('terms').version) + 1))).rejects.toThrow(NOT_FOUND);
    for (const kind of ['x', 'Privacy', 'terms ', 'constructor', '__proto__', 'hasOwnProperty', '..']) {
      await expect(kindPage(kind), kind).rejects.toThrow(NOT_FOUND);
      await expect(versionPage(kind, '1'), kind).rejects.toThrow(NOT_FOUND);
    }
  });

  it('FR-ACC-02: only the registry kinds and versions are generated, and no other is served (dynamicParams false)', async () => {
    expect(KindModule.dynamicParams).toBe(false);
    expect(VersionModule.dynamicParams).toBe(false);
    expect(await KindModule.generateStaticParams()).toEqual([
      { kind: 'terms' }, { kind: 'privacy' }, { kind: 'cross-border-consent' }, { kind: 'organisation-agreement' },
    ]);
    // Generated from the registry's history, oldest first: a published version joins the list without an edit here.
    expect(await VersionModule.generateStaticParams()).toEqual(
      LEGAL_KINDS.flatMap((kind) => legalTextHistory(kind).map((t) => ({ kind, version: t.version }))),
    );
  });

  it('FR-ACC-02: past versions are listed newest first, without the current one', async () => {
    const [v1, v2] = privacyHistory.fixture;
    privacyHistory.versions = [
      v1, v2,
      { ...v2, version: '3', publishedOn: '2027-01-04', acceptance: 'offered', sha256: 'ef'.repeat(32), text: 'Version 3 text.\n' },
    ];
    const html = await kindPage('privacy');
    expect(html).toContain('Version 3, published 4 Jan 2027');
    const past = html.slice(html.indexOf('<h2>Past versions</h2>'));
    expect([...past.matchAll(/href="(\/legal\/privacy\/[^"]+)"/g)].map((m) => m[1])).toEqual(['/legal/privacy/2', '/legal/privacy/1']);
  });

  it('FR-ACC-02: every shipped legal text is shown word for word, with the SHA-256 of its file', () => {
    for (const kind of actualRegistry.LEGAL_KINDS) {
      const text = actualRegistry.currentLegalText(kind);
      const path = `data/legal/${kind}/${text.version}.md`;
      const html = renderToStaticMarkup(<LegalTextView text={text} />);
      const shownWords = textBlocks(html).map(unescaped).join(' ').split(/\s+/).filter(Boolean);
      // A heading's "## " marker is markup, not a word of the text.
      const fileWords = bodyOf(path).replace(/^## /gm, '').split(/\s+/).filter(Boolean);
      expect(fileWords.length, kind).toBeGreaterThan(0);
      expect(shownWords, kind).toEqual(fileWords);
      expect(html, kind).toContain(groupsOfFour(sha(path)));
    }
  });

  it('FR-ACC-02: a kind with one version lists no past versions', async () => {
    const html = await kindPage('terms');
    const past = html.slice(html.indexOf('<h2>Past versions</h2>'));
    expect(past).toContain('<p>None</p>');
    expect(past).not.toContain('href="/legal/terms/');
    expect(html).toContain('href="/legal/terms/1"');
  });

  it('FR-ACC-02: each kind is headed by its 7.5.7 name, and its hash is the SHA-256 of its shipped file', async () => {
    const names = {
      terms: 'Terms of service',
      'cross-border-consent': 'Cross-border storage consent',
      'organisation-agreement': 'Organisation agreement',
    } as const;
    for (const [kind, heading] of Object.entries(names)) {
      const html = await kindPage(kind);
      expect(html.match(/<h1[ >]/g), kind).toHaveLength(1);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
      expect(html).toContain(groupsOfFour(sha(`data/legal/${kind}/1.md`)));
      expect(html).toContain('Version 1, published 2 Nov 2026');
    }
    expect(await kindPage('privacy')).toMatch(/<h1[^>]*>Privacy notice<\/h1>/);
  });

  it('FR-ACC-02 G-11: the hash is written as 16 groups of four lower-case hexadecimal characters', async () => {
    const html = await versionPage('privacy', '2');
    const shown = /<code[^>]*>([^<]*)<\/code>/.exec(html)?.[1];
    expect(shown).toBe(groupsOfFour(PRIVACY_V2.sha256));
    expect(shown).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){15}$/);
  });

  it('FR-PUB-01: only the text block of S-06 carries data-legal-text', () => {
    const text: LegalTextVersion = {
      kind: 'terms', version: '3', publishedOn: '2027-01-05', acceptance: 'offered', sha256: 'ab'.repeat(32),
      text: '## Our promise\n\nWe certify the words of this stub.\n\nA second paragraph.\n',
    };
    const html = renderToStaticMarkup(<LegalTextView text={text} />);
    expect(html.match(/data-legal-text/g), 'one marked element').toHaveLength(1);
    const at = html.indexOf('data-legal-text');
    const open = html.lastIndexOf('<', at);
    const close = html.lastIndexOf('</div>');
    const marked = html.slice(open, close + '</div>'.length);
    const outside = html.slice(0, open) + html.slice(close + '</div>'.length);
    expect(marked.startsWith('<div ')).toBe(true);
    expect(marked).toContain('We certify the words of this stub.');
    expect(marked).toContain('<h2>Our promise</h2>');
    // Nothing but the stub's blocks, in order: interface copy added inside the block, before or after them, fails here.
    const inner = marked.slice(marked.indexOf('>') + 1, marked.length - '</div>'.length);
    expect(inner).toBe('<h2>Our promise</h2><p>We certify the words of this stub.</p><p>A second paragraph.</p>');
    // The page's heading, the version line and the fingerprint are interface copy: they stay outside.
    for (const part of ['<h1', 'Version 3, published 5 Jan 2027', groupsOfFour('ab'.repeat(32)), 'SHA-256']) {
      expect(marked, part).not.toContain(part);
      expect(outside, part).toContain(part);
    }
    expect(outside).not.toContain('certify');
  });

  it('FR-ACC-02: the text is one paragraph per blank-line-separated block, and keeps its single line breaks', () => {
    const text: LegalTextVersion = {
      kind: 'terms', version: '3', publishedOn: '2027-01-05', acceptance: 'offered', sha256: 'ab'.repeat(32),
      text: 'First block.\n\nSecond block, line one.\nSecond block, line two.\n\n\nThird block.\n',
    };
    const html = renderToStaticMarkup(<LegalTextView text={text} />);
    expect(html).toContain('Version 3, published 5 Jan 2027');
    const paragraphs = textParagraphs(html);
    expect(paragraphs).toEqual(['First block.', 'Second block, line one.\nSecond block, line two.', 'Third block.']);
  });

  it('FR-ACC-02 (WCAG 1.3.1): a block that is one line starting with "## " is a section heading; any other block is a paragraph', () => {
    const text: LegalTextVersion = {
      kind: 'terms', version: '3', publishedOn: '2027-01-05', acceptance: 'offered', sha256: 'ab'.repeat(32),
      text: '## 1. Purpose\n\nThe purpose.\n\n## Not a heading\nbecause the block has two lines.\n\nA ## in the middle.\n',
    };
    const html = renderToStaticMarkup(<LegalTextView text={text} />);
    expect(html.match(/<h2[^>]*>[^<]*<\/h2>/g)).toEqual(['<h2>1. Purpose</h2>']);
    expect(textParagraphs(html)).toEqual(['The purpose.', '## Not a heading\nbecause the block has two lines.', 'A ## in the middle.']);
  });

  it('FR-ACC-02 NFR-SEC-11: markup in a legal text renders as text', () => {
    const hostile: LegalTextVersion = {
      kind: 'privacy', version: '1', publishedOn: '2026-11-02', acceptance: 'required', sha256: 'cd'.repeat(32),
      text: HOSTILE_STRINGS.join('\n\n'),
    };
    const html = renderToStaticMarkup(<LegalTextView text={hostile} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(textParagraphs(html)).toEqual(['&lt;script&gt;alert(1)&lt;/script&gt;', '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;', 'javascript:alert(1)']);
  });

  it('FR-ACC-02 (7.6.2, 2.4.2): each page title names the text, then the product', async () => {
    expect(await KindModule.generateMetadata({ params: Promise.resolve({ kind: 'privacy' }) })).toEqual({
      title: 'Privacy notice - MAK-AI RAI Platform',
    });
    expect(await VersionModule.generateMetadata({ params: Promise.resolve({ kind: 'privacy', version: '1' }) })).toEqual({
      title: 'Privacy notice, version 1 - MAK-AI RAI Platform',
    });
    await expect(KindModule.generateMetadata({ params: Promise.resolve({ kind: 'x' }) })).rejects.toThrow(NOT_FOUND);
    await expect(
      VersionModule.generateMetadata({ params: Promise.resolve({ kind: 'privacy', version: '9' }) }),
    ).rejects.toThrow(NOT_FOUND);
  });
});

describe('the old pages of the two texts (FR-ACC-02)', () => {
  it('FR-ACC-02: /terms and /privacy redirect permanently to S-06', async () => {
    const { default: TermsPage } = await import('@/app/(public)/terms/page');
    const { default: PrivacyPage } = await import('@/app/(public)/privacy/page');
    for (const [Page, to] of [[TermsPage, '/legal/terms'], [PrivacyPage, '/legal/privacy']] as const) {
      // permanentRedirect throws Next's redirect error, digest "NEXT_REDIRECT;replace;<to>;308;".
      expect(() => Page(), to).toThrow(expect.objectContaining({ digest: expect.stringMatching(new RegExp(`^NEXT_REDIRECT;[a-z]+;${to};308;`)) }));
    }
  });
});

