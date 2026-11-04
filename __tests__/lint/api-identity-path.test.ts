import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Threat A6 (FR-ACC-04, SRS 7.1.2): an API route resolves its caller only through requireIdentityForApi (or
 * requireOrgContextWithIdentity, which calls it), so gates 1 to 3 run for every route. tryResolveIdentity (a page's
 * soft identity) and requireOrgContextFor (lib/auth/context.ts, an org check with no gate of its own) would let a
 * route build its caller without them. No file under app/api imports either, except app/api/users/me/route.ts,
 * which resolves the caller with requireIdentityForApi first and then checks each of its organisations.
 */
const FORBIDDEN = ['tryResolveIdentity', 'requireOrgContextFor'] as const;
const EXEMPT: Record<string, string> = {
  'app/api/users/me/route.ts': 'S-21 deletion: requireIdentityForApi resolves the caller, then requireOrgContextFor checks each organisation the account leaves',
};

/** The forbidden names a source imports, from any module, by a named import (aliased or not). */
function forbiddenImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  // `import { a, b as c } from '...'` and `const { a } = await import('...')`: the names inside the braces.
  const lists = [...code.matchAll(/\bimport\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g),
    ...code.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(/g)].map((m) => m[1]);
  const names = lists.flatMap((l) => l.split(',').map((n) => n.trim().split(/\s+as\s+|\s*:\s*/)[0].trim()).filter(Boolean));
  return FORBIDDEN.filter((f) => names.includes(f));
}

function routeFiles(dir = 'app/api'): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? routeFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('API routes resolve their caller through the gate (A6)', () => {
  it('FR-ACC-04 (A6): no file under app/api imports tryResolveIdentity or requireOrgContextFor, except the named exemption', () => {
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(40);
    const hits = files.filter((f) => !(f in EXEMPT) && forbiddenImports(readFileSync(f, 'utf8')).length > 0);
    expect(hits).toEqual([]);
  });

  it('FR-ACC-04 (A6): the exempt file still resolves its caller with requireIdentityForApi', () => {
    for (const f of Object.keys(EXEMPT)) expect(readFileSync(f, 'utf8'), f).toMatch(/\bawait requireIdentityForApi\(/);
  });

  it('FR-ACC-04 (A6, lint self-test): the scanner finds a forbidden import in any form, and nothing else', () => {
    expect(forbiddenImports("import { tryResolveIdentity } from '@/lib/auth/identity';")).toEqual(['tryResolveIdentity']);
    expect(forbiddenImports("import { requireIdentityForApi, requireOrgContextFor as orgFor } from '../../lib/auth/context';")).toEqual(['requireOrgContextFor']);
    expect(forbiddenImports("import {\n  requireOrgContextFor,\n} from '@/lib/auth/context';")).toEqual(['requireOrgContextFor']);
    expect(forbiddenImports("const { tryResolveIdentity } = await import('@/lib/auth/identity');")).toEqual(['tryResolveIdentity']);
    expect(forbiddenImports("import { requireIdentityForApi } from '@/lib/auth/identity';\n// tryResolveIdentity is for pages")).toEqual([]);
    expect(forbiddenImports("import { requireOrgContextWithIdentity } from '@/lib/auth/context';")).toEqual([]);
  });
});
