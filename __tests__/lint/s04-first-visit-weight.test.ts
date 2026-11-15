import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PERF-02 (SRS line 3195), FIX-15: S-04 with accented names stays within the owner's limit (owner-questions.md,
 * decision of 6 Nov: 243700 B through nginx, 237700 B on the direct run, e2e/first-visit-transfer.spec.ts). Every byte
 * of S-04's first visit counts, so two things it downloaded without using are kept out:
 *
 *  - S-05's RecordAcceptances. Turbopack ships a client module whole, used exports or not, so when it lived in
 *    components/legal/AcceptancesForm.tsx, which S-04 imports for its acceptances step, S-04 downloaded it (and the
 *    draft store's loader went into a chunk of its own, one more request). It lives in its own module, which S-04's
 *    graph never reaches.
 *  - Rules for classes nothing renders. app/globals.css is one stylesheet that every page downloads; a rule whose
 *    selectors all name a class no file of the app writes is bytes on every first visit, S-04's included.
 *
 * These pin the trims; the bytes themselves are measured by the first-visit spec and V's run through nginx.
 */

const ROOT = process.cwd();

/** The file an import specifier names, or null for a package. `@/` is the repository root (tsconfig paths). */
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? join(dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${relative(ROOT, from)}: cannot resolve ${spec}`);
}

/** Every source file `entry` reaches through static imports and re-exports (type-only imports included, which only over-approximates). */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
      const target = resolveImport(file, m[1]);
      if (target !== null) queue.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f)).sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|mjs)$/.test(e.name) ? [path] : [];
  });
}

/** The class names the selectors of a stylesheet name: comments stripped, declaration blocks left out. */
function selectorClasses(css: string): Set<string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set<string>();
  // Text before each `{` that is not inside a declaration block is a selector list or an at-rule prelude.
  let depthText = '';
  let depth = 0;
  for (const ch of noComments) {
    if (ch === '{') {
      if (!depthText.trim().startsWith('@')) for (const m of depthText.matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) out.add(m[1]);
      depth++;
      depthText = '';
    } else if (ch === '}') {
      depth--;
      depthText = '';
    } else if (ch === ';') {
      depthText = '';
    } else {
      depthText += ch;
    }
  }
  if (depth !== 0) throw new Error('unbalanced braces in the stylesheet');
  return out;
}

describe('NFR-PERF-02 FIX-15: S-04 downloads nothing it does not use', () => {
  it('NFR-PERF-02 FIX-15: no module S-04\'s client imports defines S-05\'s RecordAcceptances', () => {
    const graph = importGraph(join(ROOT, 'app/(public)/invitations/[token]/AcceptInvitationClient.tsx'));
    expect(graph).toContain('components/legal/AcceptancesForm.tsx');   // the graph is the real one: S-04 does use the form
    const defining = graph.filter((f) => /\bfunction RecordAcceptances\b/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(defining).toEqual([]);
  });

  it('NFR-PERF-02 T16-Q11: no file S-04\'s client reaches statically imports next-auth/react or signOutClearingDrafts', () => {
    // Both are used only after a press (the sign-in after Create account, the two sign-outs), so each is loaded with
    // import() inside the handler that needs it. importGraph skips packages, so each file of the graph is read here for
    // the two specifiers; a relative path that resolves to the sign-out module counts too.
    const signOutModule = join(ROOT, 'lib/client/signOutClearingDrafts.ts');
    const graph = importGraph(join(ROOT, 'app/(public)/invitations/[token]/AcceptInvitationClient.tsx'));
    expect(graph).toContain('components/legal/AcceptancesForm.tsx');   // the graph is the real one
    const found = graph.flatMap((f) => {
      const source = readFileSync(join(ROOT, f), 'utf8');
      return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\s(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g)]
        .map((m) => m[1])
        .filter((spec) => spec === 'next-auth/react' || resolveImport(join(ROOT, f), spec) === signOutModule)
        .map((spec) => `${f}: ${spec}`);
    });
    expect(found).toEqual([]);
  });

  it('NFR-PERF-02 FIX-15: S-05 still records acceptances through RecordAcceptances', () => {
    const graph = importGraph(join(ROOT, 'app/(gate)/acceptances/page.tsx'));
    expect(graph.filter((f) => /\bexport function RecordAcceptances\b/.test(readFileSync(join(ROOT, f), 'utf8')))).toEqual(['components/legal/RecordAcceptances.tsx']);
  });

  it('NFR-PERF-02 FIX-15: every class app/globals.css styles is one the app writes', () => {
    /*
     * Kept although nothing renders them:
     *  - stage-indicator and its four stage modifiers: the stage colour pairs UX-06 pins (__tests__/unit/design-tokens.test.ts).
     */
    const kept = new Set(['stage-indicator', 'stage-indicator--pre', 'stage-indicator--in', 'stage-indicator--post', 'stage-indicator--cross']);
    const corpus = ['app', 'components', 'lib'].flatMap(sourceFiles).map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    const unused = [...selectorClasses(readFileSync(join(ROOT, 'app/globals.css'), 'utf8'))]
      .filter((c) => !kept.has(c))
      .filter((c) => !new RegExp(`(^|[^a-zA-Z0-9_-])${c.replace(/-/g, '\\-')}([^a-zA-Z0-9_-]|$)`, 'm').test(corpus))
      .sort();
    expect(unused).toEqual([]);
  });
});
