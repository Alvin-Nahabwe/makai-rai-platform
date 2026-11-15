import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Security review 0.7.0, L-1 (A7, UX-01): a layout that calls requireIdentity re-runs on a client-side navigation INTO
 * its segment, but not on one BETWEEN two pages beneath it, because Next keeps a layout both pages share. So a gating
 * layout below the group root stands in for a page's own call only when it holds that one page; with two or more pages
 * beneath it, each page calls requireIdentity itself (as explore/framework and explore/controls now do). This adds to
 * authenticated-page-gate.test.ts, which accepts any gating layout between a page and the group root.
 */
const GROUP = 'app/(authenticated)';
const CALLS_GATE = /\brequireIdentity\(/;

/** Pages that lean on a gating layout (below the group root) which also holds another page, as "page (layout)". */
function sharedLayoutPages(files: ReadonlyMap<string, string>, group = GROUP): string[] {
  const code = (f: string) => (files.get(f) ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const gates = (f: string) => CALLS_GATE.test(code(f));
  const pages = [...files.keys()].filter((f) => f.endsWith('/page.tsx')).sort();
  return pages.flatMap((page) => {
    if (gates(page)) return [];
    for (let dir = dirname(page); dir !== group && dir.startsWith(`${group}/`); dir = dirname(dir)) {
      const layout = `${dir}/layout.tsx`;
      if (!gates(layout)) continue;
      const beneath = pages.filter((p) => p.startsWith(`${dir}/`));
      return beneath.length > 1 ? [`${page} (${layout})`] : [];
    }
    return [];
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /^(page|layout)\.tsx$/.test(name) ? [p] : [];
  });
}

describe('a gating layout stands in for a page only when it holds no other page (L-1)', () => {
  it('UX-01 FR-ACC-04 (A7, L-1): no page under app/(authenticated) leans on a gating layout that two or more pages share', () => {
    const files = new Map(filesUnder(GROUP).map((f) => [f, readFileSync(f, 'utf8')]));
    expect([...files.keys()].some((f) => f.endsWith('/explore/layout.tsx'))).toBe(true);
    expect(sharedLayoutPages(files)).toEqual([]);
  });

  it('UX-01 (A7, lint self-test): two pages under one gating layout are found; one alone, or each calling the gate, is not', () => {
    const LAYOUT = 'export default async function L({ children }) { await requireIdentity(); return children; }';
    const BARE = 'export default function P() { return null; }';
    const GATED = 'export default async function P() { await requireIdentity(); return null; }';
    const tree = (extra: Record<string, string>) => new Map(Object.entries({
      'g/layout.tsx': LAYOUT,
      'g/x/layout.tsx': LAYOUT, 'g/x/a/page.tsx': BARE, 'g/x/b/page.tsx': BARE,
      'g/y/layout.tsx': LAYOUT, 'g/y/page.tsx': BARE,
      ...extra,
    }));
    expect(sharedLayoutPages(tree({}), 'g')).toEqual(['g/x/a/page.tsx (g/x/layout.tsx)', 'g/x/b/page.tsx (g/x/layout.tsx)']);
    expect(sharedLayoutPages(tree({ 'g/x/a/page.tsx': GATED }), 'g')).toEqual(['g/x/b/page.tsx (g/x/layout.tsx)']);
    expect(sharedLayoutPages(tree({ 'g/x/a/page.tsx': GATED, 'g/x/b/page.tsx': GATED }), 'g')).toEqual([]);
    // A comment that names the gate is not a call.
    expect(sharedLayoutPages(tree({ 'g/x/a/page.tsx': `// requireIdentity();\n${BARE}` }), 'g')).toContain('g/x/a/page.tsx (g/x/layout.tsx)');
  });
});
