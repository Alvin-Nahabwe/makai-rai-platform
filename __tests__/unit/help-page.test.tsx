import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Help, `/help` (plan 1A Task 12, rulings L2-67 to L2-71, W1, W4; security obligations S5, S7, S8): the page's four
 * sections in order, the vocabulary list built from data/vocabulary.json, the sealing text, the three legal links, the
 * contact line, and the layout that shows the signed-in shell only to a person who passes the sign-in gates.
 * No database: the identity, the shell data and the deadlines are mocked; the page itself reads only files.
 */

const helpEmail = vi.hoisted(() => ({ value: 'help@makrai.org' as string | null }));
vi.mock('@/lib/help/contact', () => ({ readHelpEmail: () => helpEmail.value }));

const identityMocks = vi.hoisted(() => ({ tryResolveIdentity: vi.fn(), identityPassesGates: vi.fn() }));
vi.mock('@/lib/auth/identity', () => identityMocks);
const loadShellData = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shell/data', () => ({ loadShellData }));
const readSessionDeadlines = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/idleDeadline', () => ({ readSessionDeadlines }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/help', redirect: vi.fn() }));
vi.mock('next-auth/react', () => ({ signOut: vi.fn() }));

import HelpPage, { metadata } from '@/app/help/page';
import HelpLayout from '@/app/help/layout';
import { HELP_COPY } from '@/lib/help/copy';
import { helpTerm, helpVocabulary } from '@/lib/help/vocabulary';
import AppShell from '@/components/layout/AppShell';
import PublicHeader from '@/components/layout/PublicHeader';
import IdleWarning from '@/components/layout/IdleWarning';
import { SEAL_PROOF_HREF } from '@/components/review/reviewText';

const W1 = [
  'When your team seals a stage review, the platform saves the decisions and evidence in it at that moment. After that, nobody can change what was sealed. If a file must be deleted later (for example for privacy), the platform shows that it was deleted.',
  "A seal does not show that the decisions are correct or that the evidence supports them. It is your team's record, not a check by MAK-AI.",
];

const page = (): string => renderToStaticMarkup(HelpPage());
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
function section(html: string, id: string): string {
  const m = new RegExp(`<section aria-labelledby="${id}">([\\s\\S]*?)</section>(?=<section aria-labelledby="(?!help-group)|<p><a|</div>$)`).exec(html);
  if (m === null) throw new Error(`no section ${id}`);
  return m[1];
}
function find(node: ReactNode, type: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) for (const c of node) find(c, type, found);
  else if (isValidElement(node)) {
    if (node.type === type) found.push(node);
    find((node.props as { children?: ReactNode }).children, type, found);
  }
  return found;
}

beforeEach(() => {
  helpEmail.value = 'help@makrai.org';
  identityMocks.tryResolveIdentity.mockReset();
  identityMocks.identityPassesGates.mockReset();
  loadShellData.mockReset();
  readSessionDeadlines.mockReset();
});

describe('the Help page', () => {
  it('L2-69: one h1 "Help", the tab title from pageTitle, then the four sections in order with their ids, then the About link', () => {
    expect(metadata.title).toMatch(/^Help\b/);
    const html = page();
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Help<\/h1>/);
    const h2 = [...html.matchAll(/<h2 id="([^"]+)">([^<]+)<\/h2>/g)].map((m) => [m[1], m[2]]);
    expect(h2).toEqual([
      ['words-used-on-the-platform', 'Words used on the platform'],
      ['what-sealing-means', 'What sealing means'],
      ['terms-and-privacy', 'Terms and privacy'],
      ['contact', 'Contact'],
    ]);
    expect(html).toMatch(/^<div class="help">/);
    expect(html).toMatch(/<p><a href="\/about">About the MAK-AI RAI Platform<\/a><\/p><\/div>$/);
    expect(HELP_COPY.about).toBe('About the MAK-AI RAI Platform');
    expect(html).not.toMatch(/<main\b/);
  });

  it('L2-69: 98 entries in 8 groups, in the file\'s order and with the file\'s group names', () => {
    const groups = helpVocabulary();
    expect(groups.map((g) => [g.name, g.entries.length])).toEqual([
      ['People, organisations and accounts', 18], ['Projects, stages and questions', 16], ['Recording a decision', 19],
      ['Findings and follow-up', 11], ['Stage reviews, seals and documents', 17], ['Guidance content', 5], ['Legal texts', 5],
      ['Using the platform', 7],
    ]);
    const vocab = JSON.parse(readFileSync('data/vocabulary.json', 'utf8')) as { concepts: Array<{ id: string; group: string; definition?: unknown; historical?: unknown }> };
    const listed = vocab.concepts.filter((c) => typeof c.definition === 'string' && c.historical === undefined);
    // Grouped, and in the file's order inside each group: the file lists `legal-name` after the last group, so it closes
    // the first group.
    const groupOrder = [...new Set(listed.map((c) => c.group))];
    expect(groups.flatMap((g) => g.entries.map((e) => e.id))).toEqual(groupOrder.flatMap((name) => listed.filter((c) => c.group === name).map((c) => c.id)));
    expect(groups[0].entries.at(-1)?.id).toBe('legal-name');
    const html = page();
    const h3 = [...html.matchAll(/<h3 id="help-group-(\d+)">([^<]+)<\/h3>/g)].map((m) => [m[1], m[2].replace(/&amp;/g, '&')]);
    expect(h3).toEqual(groups.map((g, i) => [String(i + 1), g.name]));
  });

  it('L2-69: no historical concept and no concept without a definition is listed', () => {
    const vocab = JSON.parse(readFileSync('data/vocabulary.json', 'utf8')) as { concepts: Array<{ id: string; definition?: unknown; historical?: unknown }> };
    const shown = new Set(helpVocabulary().flatMap((g) => g.entries.map((e) => e.id)));
    const left = vocab.concepts.filter((c) => typeof c.definition !== 'string' || c.historical !== undefined);
    expect(left.length).toBe(17);
    for (const c of left) expect(shown.has(c.id), c.id).toBe(false);
  });

  it('L2-69 Q2: no term on Help holds a brace; a placeholder becomes the one character U+2026', () => {
    for (const e of helpVocabulary().flatMap((g) => g.entries)) expect(e.term, e.id).not.toMatch(/[{}]/);
    expect(helpTerm('Check again on {date}')).toBe('Check again on …');
    expect(helpTerm('Changed since seal {n}')).toBe('Changed since seal …');
    expect(helpTerm('Decided by; Entered by')).toBe('Decided by; Entered by');
    expect(text(page())).toContain('Check again on …');
    // the module holds the character itself, not an escape (bytes e2 80 a6)
    expect(readFileSync('lib/help/vocabulary.ts').includes(Buffer.from([0xe2, 0x80, 0xa6]))).toBe(true);
  });

  it('L2-69 L2-29a: every <dt data-term> is followed directly by its <dd data-definition>, as text, never the Definition component', () => {
    const html = page();
    const pairs = [...html.matchAll(/<dt data-term="([^"]+)">([\s\S]*?)<\/dt><dd data-definition="([^"]+)">([\s\S]*?)<\/dd>/g)];
    const entries = helpVocabulary().flatMap((g) => g.entries);
    expect(pairs.map((m) => m[1])).toEqual(entries.map((e) => e.id));
    for (const m of pairs) expect(m[3]).toBe(m[1]);
    expect(html.match(/<dt\b/g)).toHaveLength(98);
    expect(html.match(/<dd\b/g)).toHaveLength(98);
    for (const m of pairs) expect(m[2] + m[4]).not.toMatch(/<[a-z]/i);
    const src = readFileSync('app/help/page.tsx', 'utf8');
    expect(src).not.toMatch(/Definition|<Term\b|dangerouslySetInnerHTML/);
  });

  it('W1 (FR-PUB-04 UX-03): "What sealing means" is the two paragraphs, word for word, and says what a seal does not show', () => {
    const html = page();
    const sealing = section(html, 'what-sealing-means');
    const paras = [...sealing.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/&#x27;/g, "'"));
    expect(paras).toEqual(W1);
    expect(HELP_COPY.sealing.paragraphs).toEqual(W1);
    expect(html).toContain('A seal does not show that the decisions are correct or that the evidence supports them.');
    expect(html).not.toMatch(/not independently time-stamped/i);
  });

  it('W2: the review page\'s seal link is /help# plus the id the Help page gives "What sealing means"', () => {
    expect(SEAL_PROOF_HREF).toBe('/help#what-sealing-means');
    expect(page()).toContain(`<h2 id="${SEAL_PROOF_HREF.slice('/help#'.length)}">${HELP_COPY.sealing.heading}</h2>`);
  });

  it('W4: the three accepted texts, in ACCEPTED_KINDS order, named as their pages head them, and no organisation agreement', () => {
    const legal = section(page(), 'terms-and-privacy');
    const links = [...legal.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ['/legal/terms', 'Terms of service'],
      ['/legal/privacy', 'Privacy notice'],
      ['/legal/cross-border-consent', 'Consent to storage abroad'],
    ]);
    expect(legal).toMatch(/^<h2 id="terms-and-privacy">Terms and privacy<\/h2><ul class="help__links">(<li><a [^>]+>[^<]+<\/a><\/li>){3}<\/ul>$/);
    expect(page()).not.toMatch(/organisation-agreement|rganisation agreement/);
  });

  it('L2-69 S8: Contact with the address set is "Write to <address>." with a mailto link, and nothing else', () => {
    const contact = section(page(), 'contact');
    expect(contact).toBe('<h2 id="contact">Contact</h2><p>Write to <a href="mailto:help@makrai.org">help@makrai.org</a>.</p>');
  });

  it('L2-69: Contact with no address is the one sentence "For help, ask the Owner of your organisation."', () => {
    helpEmail.value = null;
    const contact = section(page(), 'contact');
    expect(contact).toBe('<h2 id="contact">Contact</h2><p>For help, ask the Owner of your organisation.</p>');
  });

  it('L2-69 no-country-content: nothing country-specific is on Help', () => {
    expect(text(page())).not.toMatch(/UNCST|Uganda/);
  });

  it('X-2: no client component imports lib/help/copy.ts or lib/help/vocabulary.ts', () => {
    const files = ['app', 'components', 'lib'].flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/^['"]use client['"]/m.test(src)) expect(src, f).not.toMatch(/@\/lib\/help\//);
    }
    for (const f of readdirSync('components/layout').map((x) => `components/layout/${x}`).concat(readdirSync('lib/shell').map((x) => `lib/shell/${x}`))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/lib\/help\//);
    }
  });
});

describe('the Help layout (L2-68, S5, S7)', () => {
  const identity = { userId: 'u1', email: 'a@example.test', name: 'A', platformRole: 'assessor' as const, mustChangePassword: false };
  const shell = { userId: 'u1', userName: 'A', platformLabel: null, roleLabels: {}, orgs: [] };

  it('L2-68 S5: signed out, the public header with Sign in at /login, one main, no AppShell, no IdleWarning, no shell data read', async () => {
    identityMocks.tryResolveIdentity.mockResolvedValue(null);
    const tree = await HelpLayout({ children: <p>child</p> });
    const headers = find(tree, PublicHeader);
    expect(headers).toHaveLength(1);
    expect(headers[0].props as unknown).toEqual({ signInHref: undefined });
    expect(find(tree, AppShell)).toHaveLength(0);
    expect(find(tree, IdleWarning)).toHaveLength(0);
    expect(loadShellData).not.toHaveBeenCalled();
    expect(identityMocks.identityPassesGates).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(tree);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main id="main-content" tabindex="-1" class="public-layout"><p>child<\/p><\/main>/);
    expect(html).toMatch(/<a href="\/login">Sign in<\/a>/);
  });

  for (const [label, who] of [
    ['a password change due', { ...identity, mustChangePassword: true }],
    ['an acceptance pending', identity],
  ] as const) {
    it(`L2-68 L2-70 S5 S7: with ${label}, the public header with Sign in at /, no AppShell, no shell data read`, async () => {
      identityMocks.tryResolveIdentity.mockResolvedValue(who);
      identityMocks.identityPassesGates.mockResolvedValue(false);
      const tree = await HelpLayout({ children: <p>child</p> });
      const headers = find(tree, PublicHeader);
      expect(headers).toHaveLength(1);
      expect(headers[0].props as unknown).toEqual({ signInHref: '/' });
      expect(find(tree, AppShell)).toHaveLength(0);
      expect(find(tree, IdleWarning)).toHaveLength(0);
      expect(loadShellData).not.toHaveBeenCalled();
      expect(readSessionDeadlines).not.toHaveBeenCalled();
      expect(identityMocks.identityPassesGates).toHaveBeenCalledWith(who);
      const html = renderToStaticMarkup(tree);
      expect(html).toMatch(/<a href="\/">Sign in<\/a>/);
      expect(html).not.toContain('a@example.test');
    });
  }

  it('L2-68 S5: past the gates, IdleWarning first and then AppShell with the shell data, and no public header', async () => {
    identityMocks.tryResolveIdentity.mockResolvedValue(identity);
    identityMocks.identityPassesGates.mockResolvedValue(true);
    loadShellData.mockResolvedValue(shell);
    readSessionDeadlines.mockResolvedValue({ idleSecondsLeft: 900, absoluteSecondsLeft: 3600 });
    const tree = await HelpLayout({ children: <p>child</p> });
    expect(loadShellData).toHaveBeenCalledWith(identity);
    const shells = find(tree, AppShell);
    expect(shells).toHaveLength(1);
    expect((shells[0].props as { shell: unknown }).shell).toBe(shell);
    expect(find(tree, PublicHeader)).toHaveLength(0);
    const kids = (tree as ReactElement<{ children: ReactNode[] }>).props.children;
    expect(Array.isArray(kids) && isValidElement(kids[0]) && kids[0].type === IdleWarning).toBe(true);
    expect(isValidElement(kids[1]) && kids[1].type === AppShell).toBe(true);
  });

  it('L2-68: past the gates with unreadable deadlines, no warning and no log line', async () => {
    identityMocks.tryResolveIdentity.mockResolvedValue(identity);
    identityMocks.identityPassesGates.mockResolvedValue(true);
    loadShellData.mockResolvedValue(shell);
    readSessionDeadlines.mockResolvedValue(null);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tree = await HelpLayout({ children: <p>child</p> });
    expect(find(tree, IdleWarning)).toHaveLength(0);
    expect(find(tree, AppShell)).toHaveLength(1);
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('L2-68: a rejection that is not a SessionError propagates, from the identity read or the gates; it is never the public header', async () => {
    identityMocks.tryResolveIdentity.mockRejectedValue(new Error('database down'));
    await expect(HelpLayout({ children: null })).rejects.toThrow('database down');
    identityMocks.tryResolveIdentity.mockResolvedValue(identity);
    identityMocks.identityPassesGates.mockRejectedValue(new Error('acceptances down'));
    await expect(HelpLayout({ children: null })).rejects.toThrow('acceptances down');
  });

  it('L2-70 S7: PublicHeader takes signInHref, default /login, and only the Help layout passes it, as the fixed string', () => {
    expect(renderToStaticMarkup(<PublicHeader />)).toMatch(/<a href="\/login">Sign in<\/a>/);
    const passers = ['app', 'components'].flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
      .filter((f) => /\.tsx$/.test(f) && /<PublicHeader\b[^>]*signInHref/.test(readFileSync(f, 'utf8')));
    expect(passers).toEqual(['app/help/layout.tsx']);
    expect(readFileSync('app/help/layout.tsx', 'utf8')).toMatch(/<PublicHeader signInHref=\{gated \? '\/' : undefined\} \/>/);
  });
});
