import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isClaim } from '@/lib/claims/pattern';
import { ABOUT_COPY } from '@/lib/about/copy';
import { ACCOUNT_COPY } from '@/lib/account/copy';
import { ADMIN_COPY } from '@/lib/admin/copy';
import { AUTH_COPY } from '@/lib/auth/copy';
import { DECISION_COPY } from '@/lib/decision/copy';
import { DOCUMENTS_COPY } from '@/lib/documents/copy';
import { ERRORS_COPY } from '@/lib/errors/copy';
import { NOT_FOUND_COPY } from '@/lib/errors/not-found/copy';
import { EXPORT_COPY } from '@/lib/export/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { HOME_COPY } from '@/lib/home/copy';
import { LEGAL_COPY } from '@/lib/legal/copy';
import { ORG_COPY } from '@/lib/org/copy';
import { PROJECT_COPY } from '@/lib/project/copy';
import { REVIEW_COPY } from '@/lib/review/copy';

/**
 * Spec 7.5 (WCAG 2.4.2): every page names itself in the browser tab as `<thing> · <project or organisation> · MAK-AI RAI
 * Platform`, built by `pageTitle` (lib/ui/title.ts) from a `<AREA>_COPY.titles` word. Development-only routes under
 * `app/dev/` are not product pages and are skipped.
 */

function pagesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p.split(sep).join('/') === 'app/dev' ? [] : pagesUnder(p);
    return name === 'page.tsx' ? [p.split(sep).join('/')] : [];
  });
}

/**
 * A page inside a parallel-route slot (`@slot/`, e.g. app/(authenticated)/@project/, owner ruling R4) is not a page of its
 * own: it renders beside the page the address names, which owns the title. Slot pages are held to the opposite rule below
 * (no metadata at all, so a slot can never replace the page's title).
 */
const isSlotPage = (f: string): boolean => f.split('/').some((seg) => seg.startsWith('@'));
/**
 * A page that only redirects renders nothing, so it has no tab to title. Exempt by exact path, with the reason, as
 * authenticated-page-gate.test.ts exempts a page; the last test below keeps each entry a real, redirect-only page.
 */
const REDIRECT_ONLY: Record<string, string> = {
  'app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/next/page.tsx': 'redirect-only: renders nothing, so it has no title and no project to remember',
};
const ALL_PAGES = pagesUnder('app');
const PAGES = ALL_PAGES.filter((f) => !isSlotPage(f) && !(f in REDIRECT_ONLY));
const SLOT_PAGES = ALL_PAGES.filter(isSlotPage);
const code = (f: string): string => readFileSync(f, 'utf8');
/** The source without comments, so a comment that names a token cannot satisfy a check for it. */
const withoutComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const STATIC = /\bexport const metadata\b/;
const DYNAMIC = /\bexport (async )?function generateMetadata\b/;

describe('page titles (spec 7.5)', () => {
  it('1A spec 7.5: every page exports metadata or generateMetadata, never both, and builds its title with pageTitle(', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(37);
    const wrong = PAGES.filter((f) => {
      const s = withoutComments(code(f));
      return STATIC.test(s) === DYNAMIC.test(s) || !s.includes('pageTitle(');
    });
    expect(wrong).toEqual([]);
  });

  it('1A spec 7.5 (route task 1): a parallel-route slot\'s page exports no metadata, so the title stays the page\'s', () => {
    expect(SLOT_PAGES.length).toBeGreaterThanOrEqual(1);
    expect(SLOT_PAGES.filter((f) => { const s = withoutComments(code(f)); return STATIC.test(s) || DYNAMIC.test(s); })).toEqual([]);
  });

  it('1A spec 7.5: no page file spells out the product name or says Toolkit', () => {
    expect(PAGES.filter((f) => code(f).includes('MAK-AI RAI Platform') || code(f).includes('Toolkit'))).toEqual([]);
  });

  it('1A spec 7.5: the root layout title is PRODUCT_NAME, and the error and not-found files use pageTitle', () => {
    expect(code('app/layout.tsx')).toMatch(/\btitle: PRODUCT_NAME\b/);
    // One source for the error title: ErrorPage writes it, and the global error document renders ErrorPage with no <title> of its own.
    expect(code('app/error.tsx')).toContain('<title>{pageTitle(ERRORS_COPY.titles.error)}</title>');
    expect(code('app/global-error.tsx')).toContain('<ErrorPage ');
    expect(withoutComments(code('app/global-error.tsx'))).not.toContain('<title');
    for (const f of ['app/not-found.tsx', 'app/(authenticated)/not-found.tsx']) expect(code(f)).toContain('title: pageTitle(NOT_FOUND_COPY.title)');
  });

  // Shape only: the behaviour (gates first, Next's 404 for a non-member or an unknown organisation, no name on a refusal)
  // is proven page by page in __tests__/integration/page-titles-tenancy.test.ts.
  it('1A R10-2: each signed-in page that names its organisation or project in generateMetadata defines a cache() load, calls the two gates and maps the gate\'s not-found through orNotFound', () => {
    const named = PAGES.filter((f) => f.startsWith('app/(authenticated)/orgs/') && DYNAMIC.test(code(f)));
    expect(named.length).toBe(20); // 6 organisation pages and 14 project pages
    const wrong = named.filter((f) => {
      const s = withoutComments(code(f));
      return !/= cache\(/.test(s) || !s.includes('requireIdentity(') || !s.includes('requireOrgContextFor(') || !s.includes('await orNotFound(');
    });
    expect(wrong).toEqual([]);
  });

  it('1A spec 7.5: no title word holds a claim word or Toolkit', () => {
    const words: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === 'string') words.push(v);
      else if (typeof v === 'function') words.push(String((v as (...a: string[]) => string)('X', 'Y')));
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
    };
    for (const m of [ABOUT_COPY, ACCOUNT_COPY, ADMIN_COPY, AUTH_COPY, DECISION_COPY, DOCUMENTS_COPY, ERRORS_COPY, EXPORT_COPY, FINDINGS_COPY,
      GUIDANCE_COPY, HOME_COPY, LEGAL_COPY, ORG_COPY, PROJECT_COPY, REVIEW_COPY]) collect(m.titles);
    collect(NOT_FOUND_COPY.title);
    expect(words.length).toBeGreaterThan(20);
    expect(words.filter((w) => isClaim(w) || w.includes('Toolkit') || w.trim() === '')).toEqual([]);
  });

  it('every redirect-only exemption is a page that exists, gives its reason, calls redirect( and returns no markup', () => {
    for (const [f, reason] of Object.entries(REDIRECT_ONLY)) {
      expect(ALL_PAGES, f).toContain(f);
      expect(reason.length, f).toBeGreaterThan(0);
      const s = withoutComments(code(f));
      expect(s, f).toMatch(/\bredirect\(/);
      expect(s, f).not.toMatch(/<[A-Za-z]|\bmetadata\b|generateMetadata/);
    }
  });
});
