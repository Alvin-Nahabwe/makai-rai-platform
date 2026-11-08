import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * NFR-SEC-04 (b) (SRS line 2922) and FR-ORG-03: the platform administrator reaches no project, record or
 * count. The administrator's code (lib/data/admin.ts, the pages under app/(authenticated)/admin, the routes
 * under app/api/admin and components/admin) must not import a record module, directly or through anything
 * it imports. The closure follows static imports, re-exports, side-effect imports, dynamic import() and
 * require(), for relative and `@/` specifiers; a package specifier is not followed.
 */

const RECORD = /lib\/(data\/(decisions|findings|teamFindings|followup|reviews|seals|documents|evidence|projects|export|views)|seal\/|question\/|documents\/)/;
const SOURCE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SPECIFIER = /\bfrom\s*['"`]([^'"`]+)['"`]|\bimport\s*['"`]([^'"`]+)['"`]|\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(root, d.name);
    if (d.isDirectory()) return filesUnder(p);
    return SOURCE_EXT.some((e) => d.name.endsWith(e)) ? [p] : [];
  });
}

/** The file a specifier names, or null for a package (not followed). */
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
  else return null;
  const candidates = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => path.join(base, 'index' + e))];
  const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  if (!hit) throw new Error(`${from}: cannot resolve the import '${spec}'`);   // an unresolved import would hide its closure
  return hit;
}

/** Comments are dropped first, so prose such as "copied from `.env.example`" is not read as an import. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function specifiersOf(src: string): string[] {
  return [...withoutComments(src).matchAll(SPECIFIER)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
}

function importClosure(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) continue;
    for (const spec of specifiersOf(readFileSync(file, 'utf8'))) {
      const next = resolveSpecifier(file, spec);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].sort();
}

const adminRoots = () => ['lib/data/admin.ts', ...filesUnder('app/(authenticated)/admin'), ...filesUnder('app/api/admin'), ...filesUnder('components/admin')];

describe('the administrator modules import no record module', () => {
  it('NFR-SEC-04 FR-ORG-03: administrator modules import no record module', () => {
    const closure = importClosure(adminRoots());
    // Non-vacuity: the closure reached the administrator's own reads and the identity-lane client they use.
    expect(closure).toContain('lib/data/admin.ts');
    expect(closure).toContain('lib/data/identityClient.ts');
    expect(closure.filter((f) => RECORD.test(f))).toEqual([]);
  });

  it('NFR-SEC-04 (helper): the scan finds every import form and the pattern names the record modules', () => {
    const forms = [
      "import { x } from '@/lib/data/decisions';",
      "export * from '../seal/manifest';",
      "import '@/lib/question/panel';",
      'const m = await import(`@/lib/data/evidence`);',
      "const r = require('./documents/render');",
      "/* copied from `.env.example` */ // or from '.env'",
    ];
    expect(forms.map((f) => specifiersOf(f)).flat()).toEqual(['@/lib/data/decisions', '../seal/manifest', '@/lib/question/panel', '@/lib/data/evidence', './documents/render']);
    for (const f of ['lib/data/decisions.ts', 'lib/data/views.ts', 'lib/seal/manifest.ts', 'lib/documents/render.ts', 'lib/data/projects.ts'])
      expect(RECORD.test(f), f).toBe(true);
    for (const f of ['lib/data/admin.ts', 'lib/data/identityClient.ts', 'lib/data/definer.ts', 'lib/data/tenant.ts'])
      expect(RECORD.test(f), f).toBe(false);
  });
});
