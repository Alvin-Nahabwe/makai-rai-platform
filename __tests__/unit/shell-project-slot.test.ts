import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The signed-in layout's `@project` slot (owner ruling R4). On a client-side navigation Next.js keeps a slot's last page
 * when the new address matches nothing in the slot (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * parallel-routes.md, "Behavior"), so a project's block would stay in the rail after leaving the project. The slot therefore
 * mirrors app/(authenticated) page for page: a project's pages read the project, every other page renders nothing.
 *
 * Why a mirror and not catch-alls: a root-level catch-all lets /_next/static/... resolve to a page
 * (__tests__/unit/proxy-matcher.test.ts); Next.js 16's strict route matching refuses a slot page with no page of its route
 * in the other slots ("Every page must be part of at least one complete route", seen on `next dev`, 15 November 2026), and
 * an optional catch-all at a page's own level ("the same specificity as a optional catch-all route"). This test fails when
 * a signed-in page has no mirror, or the slot has a page no signed-in page matches. The browser check of the soft
 * navigation: e2e/shell-project.spec.ts.
 */
const GROUP = 'app/(authenticated)';
const SLOT = `${GROUP}/@project`;
const EMPTY = /^\s*export default function \w+\(\) \{\s*return null;\s*\}\s*$/;
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? filesUnder(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
const pagesOf = (dir: string, skipSlots: boolean) => filesUnder(dir)
  .filter((f) => f.endsWith('/page.tsx') && !(skipSlots && f.slice(dir.length).includes('/@')))
  .map((f) => f.slice(dir.length + 1)).sort();
const isProjectPage = (rel: string) => rel.startsWith('orgs/[slug]/projects/[id]/');

/**
 * What breaks the mirror, as lines that say what to do: each signed-in page without a slot page names the slot page to
 * create, and each slot page without a signed-in page names itself (Next.js 16's strict route matching refuses it).
 */
function mirrorProblems(pages: readonly string[], slotPages: readonly string[]): string[] {
  const missing = pages.filter((p) => !slotPages.includes(p))
    .map((p) => `missing ${SLOT}/${p} (mirror of ${GROUP}/${p})`);
  const extra = slotPages.filter((p) => !pages.includes(p))
    .map((p) => `${SLOT}/${p} has no signed-in page at ${GROUP}/${p}: delete it`);
  return [...missing, ...extra];
}

describe('the @project slot mirrors every signed-in page', () => {
  it('R4: every page of app/(authenticated) has a page at the same path in the slot, and the slot has no other page', () => {
    const pages = pagesOf(GROUP, true);
    expect(pages.length).toBeGreaterThanOrEqual(27);
    expect(mirrorProblems(pages, pagesOf(SLOT, false)), 'the @project slot must mirror app/(authenticated) page for page').toEqual([]);
  });

  it('(self-test) a missing mirror is named by the path to create, and a slot page with no signed-in page by its own path', () => {
    expect(mirrorProblems(['account/page.tsx', 'orgs/[slug]/settings/members/page.tsx'], ['account/page.tsx', 'explore/old/page.tsx'])).toEqual([
      'missing app/(authenticated)/@project/orgs/[slug]/settings/members/page.tsx (mirror of app/(authenticated)/orgs/[slug]/settings/members/page.tsx)',
      'app/(authenticated)/@project/explore/old/page.tsx has no signed-in page at app/(authenticated)/explore/old/page.tsx: delete it',
    ]);
    expect(mirrorProblems(['a/page.tsx'], ['a/page.tsx'])).toEqual([]);
  });

  it('R4: outside a project, the slot\'s page renders nothing and reads nothing', () => {
    const outside = pagesOf(SLOT, false).filter((rel) => !isProjectPage(rel));
    expect(outside.length).toBeGreaterThanOrEqual(10);
    for (const rel of outside) expect(code(`${SLOT}/${rel}`), rel).toMatch(EMPTY);
  });

  it('R4 A7: on a project\'s pages the slot\'s page calls requireIdentity itself, then renders ProjectInContext with no catch', () => {
    const inside = pagesOf(SLOT, false).filter(isProjectPage);
    expect(inside.length).toBeGreaterThanOrEqual(12);
    for (const rel of inside) {
      const src = code(`${SLOT}/${rel}`);
      expect(src, rel).toMatch(/const identity = await requireIdentity\(\);\s*return <ProjectInContext identity=\{identity\} params=\{await params\} \/>;/);
      expect(src, rel).not.toMatch(/\bcatch\b/);
    }
  });

  it('R4: a full page load of an address the slot has no page for renders nothing (default.tsx), and the slot has no error, loading or not-found file', () => {
    expect(code(`${SLOT}/default.tsx`)).toMatch(EMPTY);
    // An error other than "not found" reaches the page's error boundary rather than a rail quietly without its block (S2).
    expect(filesUnder(SLOT).filter((f) => /\/(error|loading|not-found|layout|template)\.tsx$/.test(f))).toEqual([]);
  });

  it('UX-01: the slot holds no dynamic segment at its root and no catch-all anywhere', () => {
    expect(readdirSync(SLOT).filter((n) => n.startsWith('['))).toEqual([]);
    expect(filesUnder(SLOT).filter((f) => f.includes('[...') || f.includes('[[...'))).toEqual([]);
    expect(existsSync(`${SLOT}/default.tsx`)).toBe(true);
  });
});
