import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const credit = vi.hoisted(() => ({
  current: { text: 'placeholder', href: 'https://example.org/licence', licence: 'LICENCE' },
}));
vi.mock('@/lib/credit', () => ({ readCreditLine: () => credit.current }));

import Footer from '@/components/layout/Footer';
import PublicHeader from '@/components/layout/PublicHeader';
import SkipLink, { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';

/**
 * The shell's footer, skip link and public header (SRS 7.1.1; UX-03, UX-04; FR-PUB-02; NFR-SEC-11).
 * The credit line is mocked here so the test controls what the footer is given, hostile text included.
 */

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const anchors = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);

beforeEach(() => {
  credit.current = {
    text: 'This platform draws on Responsible AI Assessments by GIZ, licensed under CC BY-SA 4.0. Changes were made.',
    href: 'https://creativecommons.org/licenses/by-sa/4.0/',
    licence: 'CC BY-SA 4.0',
  };
});

describe('footer', () => {
  it('UX-03 FR-PUB-02 NFR-A11Y-04: the footer holds the credit and four links in a fixed order', () => {
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toMatch(/^<footer/);
    expect(html).toContain(escapeHtml(credit.current.text));
    expect(anchors(html)).toEqual([
      [credit.current.licence, credit.current.href],
      ['Legal texts', '/legal/terms'],
      ['About', '/about'],
      ['Help and contact', '/about#help-and-contact'],
    ]);
  });

  it('FR-PUB-02 NFR-SEC-11: the footer renders the credit as text and links only https', () => {
    credit.current = { text: '<b>x</b> GIZ', href: 'javascript:alert(1)', licence: 'LICENCE' };
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt; GIZ');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('javascript:');
    expect(anchors(html).map(([name]) => name)).toEqual(['Legal texts', 'About', 'Help and contact']);
    expect(html).toContain('LICENCE');
  });

  it('UX-03: the licence link leaves the site safely and the footer is a labelled navigation', () => {
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toMatch(/<a [^>]*href="https:\/\/creativecommons\.org[^"]*"[^>]*rel="noopener noreferrer"|<a [^>]*rel="noopener noreferrer"[^>]*href="https:\/\/creativecommons\.org/);
    expect(html).toMatch(/<nav [^>]*aria-label="Footer"/);
  });
});

describe('skip link', () => {
  it('UX-04: the skip link targets the main landmark', () => {
    expect(MAIN_CONTENT_ID).toBe('main-content');
    expect(renderToStaticMarkup(<SkipLink />)).toBe('<a class="skip-link" href="#main-content">Skip to content</a>');
  });

  it('UX-04: every <main> under app/ carries the skip-link target and a tab stop', () => {
    // The signed-in pages' <main> is AppShell's (plan 1A Task 11), so that file is read too.
    const tags = [...mainTagsUnder('app'), ...mainTagsIn('components/layout/AppShell.tsx')];
    expect(tags.length, '<main> tags found under app/ and in AppShell').toBeGreaterThanOrEqual(6);
    expect(tags.map(([file]) => file), 'the signed-in main').toContain('components/layout/AppShell.tsx');
    for (const [file, tag] of tags)
      expect(tag, file).toMatch(/id=(\{MAIN_CONTENT_ID\}|"main-content")[^>]*tabIndex=\{-1\}|tabIndex=\{-1\}[^>]*id=(\{MAIN_CONTENT_ID\}|"main-content")/);
  });
});

describe('public header', () => {
  it('UX-03: the public header holds the product name, About and Sign in', () => {
    const html = renderToStaticMarkup(<PublicHeader />);
    expect(html).toMatch(/^<header/);
    expect(anchors(html)).toEqual([
      ['MAK-AI RAI Platform', '/'],
      ['About', '/about'],
      ['Sign in', '/login'],
    ]);
  });
});

/** Every `<main ...>` JSX opening tag in a .tsx file under `dir`, with its file. */
function mainTagsUnder(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...mainTagsUnder(path));
    } else if (name.endsWith('.tsx')) {
      out.push(...mainTagsIn(path));
    }
  }
  return out;
}

/** Every `<main ...>` JSX opening tag in one .tsx file. */
function mainTagsIn(path: string): Array<[string, string]> {
  const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return [...source.matchAll(/<main\b[^>]*>/g)].map((m): [string, string] => [path, m[0]]);
}
