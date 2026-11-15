import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Threat A7 (UX-01, SRS 7.1.2): the gates run on every page request, and Next does not re-render a layout shared by
 * the page a client-side navigation leaves and the page it opens. So the group's root layout
 * (app/(authenticated)/layout.tsx) is not enough: each page calls requireIdentity itself, or a layout between it and the
 * group root does (as change-password/layout.tsx does for its one page), or it is on the named exempt list below. A
 * layout that holds two or more pages does not stand in for them: layout-gate-siblings.test.ts (L-1).
 */
const GROUP = 'app/(authenticated)';
// S-29 (change-password) left this list with S-21's Change password link: change-password/layout.tsx gates it (ACC-b).
const EXEMPT: Record<string, string> = {
  [`${GROUP}/acceptances/page.tsx`]: 'S-05, gate 3\'s own destination (exempt from it by exact path, lib/auth/identity.ts); it calls requireIdentity itself',
};

const CALLS_GATE = /\brequireIdentity\(/;

/** The pages of `files` (path -> source) that neither call the gate nor sit under a gating layout below the group root. */
function ungatedPages(files: ReadonlyMap<string, string>, group = GROUP): string[] {
  // A call in code, not a mention: comments are stripped first (explore/layout.tsx names requireIdentity() in prose).
  const code = (f: string) => (files.get(f) ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const gates = (f: string) => CALLS_GATE.test(code(f));
  return [...files.keys()].filter((f) => f.endsWith('/page.tsx')).sort().filter((page) => {
    if (gates(page)) return false;
    // Each directory from the page's own up to, but not including, the group root.
    for (let dir = dirname(page); dir !== group && dir.startsWith(`${group}/`); dir = dirname(dir)) {
      if (gates(`${dir}/layout.tsx`)) return false;
    }
    return true;
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /^(page|layout)\.tsx$/.test(name) ? [p] : [];
  });
}

describe('every signed-in page runs the gates on a client-side navigation (A7)', () => {
  it('UX-01 FR-ACC-04 (A7): each page under app/(authenticated) calls requireIdentity, or a layout below the group root does, or is exempt with a reason', () => {
    const files = new Map(filesUnder(GROUP).map((f) => [f, readFileSync(f, 'utf8')]));
    expect([...files.keys()].filter((f) => f.endsWith('page.tsx')).length).toBeGreaterThan(8);
    expect(ungatedPages(files).filter((p) => !(p in EXEMPT))).toEqual([]);
    for (const [f, reason] of Object.entries(EXEMPT)) expect({ f, exists: existsSync(f), reason: reason.length > 0 }).toEqual({ f, exists: true, reason: true });
  });

  it('UX-01 (A7, lint self-test): a client page with no gate and only the group root layout above it is found', () => {
    const tree = (extra: Record<string, string>) => new Map(Object.entries({
      'g/layout.tsx': 'export default async function L() { await requireIdentity(); }',
      'g/a/page.tsx': "'use client';\nexport default function P() { return null; }",
      'g/b/page.tsx': 'export default async function P() { await requireIdentity(); }',
      'g/c/d/page.tsx': "'use client';\nexport default function P() { return null; }",
      ...extra,
    }));
    expect(ungatedPages(tree({}), 'g')).toEqual(['g/a/page.tsx', 'g/c/d/page.tsx']);
    expect(ungatedPages(tree({ 'g/c/layout.tsx': 'export default async function L() { await requireIdentity(); }' }), 'g')).toEqual(['g/a/page.tsx']);
    // A comment that names the gate is not a call.
    expect(ungatedPages(tree({ 'g/a/layout.tsx': '/** the root layout\'s requireIdentity() does not run here */\n// requireIdentity();\nexport default function L() {}' }), 'g'))
      .toEqual(['g/a/page.tsx', 'g/c/d/page.tsx']);
    // requireIdentityForApi is the API gate, not the page gate.
    expect(ungatedPages(tree({ 'g/a/layout.tsx': 'await requireIdentityForApi();' }), 'g')).toEqual(['g/a/page.tsx', 'g/c/d/page.tsx']);
  });
});
