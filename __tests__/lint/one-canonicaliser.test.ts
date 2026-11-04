import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The shared integrity module (ADR-C3, NFR-MNT-05) is imported by client code: `lib/client/retrySafeWrite.ts`
 * takes `canonicalJson` from it (contract, consumers of `lib/integrity/canonical.mjs`). So the module may hold
 * no static import of a Node built-in, which a browser bundle cannot resolve or replaces with a polyfill
 * against the page-weight budgets (G-13); its digest functions take `node:crypto` at call time instead.
 */

const ROOT = process.cwd();
const BUILTINS = new Set(builtinModules);
const isBuiltin = (spec: string) => spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]);

/** The value (not type-only) static import and re-export specifiers of a source file, comments removed. */
function staticSpecifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (base === null) return null;
  for (const c of ['', '.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx']) {
    if (existsSync(base + c) && statSync(base + c).isFile()) return base + c;
  }
  throw new Error(`cannot resolve ${spec} from ${relative(ROOT, from)}`);
}

/** Every built-in a file reaches through its static value imports, as `<importing file>: <specifier>`. */
function builtinsReached(entry: string): string[] {
  const seen = new Set<string>();
  const hits: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of staticSpecifiers(file)) {
      if (isBuiltin(spec)) hits.push(`${relative(ROOT, file)}: ${spec}`);
      const next = resolveLocal(spec, file);
      if (next !== null) visit(next);
    }
  };
  visit(join(ROOT, entry));
  return hits;
}

describe('one canonicaliser, safe for the client', () => {
  it('NFR-MNT-05 NFR-PERF-02 (ADR-C3): canonical.mjs has no static import of a node: module', () => {
    expect(staticSpecifiers(join(ROOT, 'lib/integrity/canonical.mjs')).filter(isBuiltin)).toEqual([]);
  });

  it('NFR-MNT-05 NFR-PERF-02 (ADR-C3): the static import graph of lib/client/retrySafeWrite.ts holds no Node built-in', () => {
    expect(staticSpecifiers(join(ROOT, 'lib/client/retrySafeWrite.ts'))).toContain('@/lib/integrity/canonical.mjs');
    expect(builtinsReached('lib/client/retrySafeWrite.ts')).toEqual([]);
  });

  it('NFR-MNT-05: the walk sees a built-in where one is imported (the lint is not vacuous)', () => {
    expect(builtinsReached('lib/content/bundleHash.ts')).toContain('lib/content/bundleHash.ts: node:crypto');
  });
});
