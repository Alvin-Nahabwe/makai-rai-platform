import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * NFR-SEC-12, NFR-SEC-09, ADR-C5 (C4 SF-1 and SEC-1; contract R12-5): two modules are reachable
 * from a fixed list of files only, checked by scanning the source rather than by an ESLint rule.
 *
 *   - `lib/data/identityClient.ts` (`identityLaneClient`, an unguarded client on the identity
 *     lane): imported only by lib/data/definer.ts, lib/data/identityReads.ts and lib/data/admin.ts.
 *   - `systemContext` (lib/data/tenant.ts, the reminder run's lane): named only by
 *     lib/data/tenant.ts, which defines it, and lib/reminders/job.ts.
 *
 * The scan reads app/, lib/, components/, scripts/ and the root .ts files (instrumentation.ts,
 * proxy.ts and the configs), and matches every import form: `from '…'` (so `export … from`),
 * a bare `import '…'`, `import('…')` and `require('…')`, plus the exported names as words, so a
 * namespace import or a re-export under another path is still found. Each form has a fixture
 * string below that the scan must catch.
 */

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return SOURCE_EXT.test(e.name) ? [p] : [];
  });
}

function scannedFiles(): string[] {
  const dirs = ['app', 'lib', 'components', 'scripts'].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
  const root = readdirSync('.').filter((f) => /\.(ts|mts|cts)$/.test(f) && statSync(f).isFile());
  return [...dirs.flatMap(walk), ...root].sort();
}

/** Every way a source file can reach `module` (a path's last segment) or name one of `names`. */
function reaches(src: string, module: string, names: readonly string[]): boolean {
  const forms: RegExp[] = [];
  if (module) {
    const spec = String.raw`['"][^'"]*\b${module}(?:\.[cm]?[jt]sx?)?['"]`;
    forms.push(
      new RegExp(String.raw`\bfrom\s*${spec}`),                 // import … from, export … from
      new RegExp(String.raw`\bimport\s*${spec}`),               // import '…' (side effect)
      new RegExp(String.raw`\bimport\s*\(\s*${spec}\s*\)`),     // import('…')
      new RegExp(String.raw`\brequire\s*\(\s*${spec}\s*\)`),    // require('…')
    );
  }
  for (const name of names) forms.push(new RegExp(String.raw`\b${name}\b`));
  return forms.some((re) => re.test(src));
}

const IDENTITY_CLIENT = { module: 'identityClient', names: ['identityLaneClient'] as const };
// systemContext lives in lib/data/tenant.ts, which every data module imports: the name is the check.
const SYSTEM_CONTEXT = { module: '', names: ['systemContext'] as const };
const ALLOWED_IDENTITY_CLIENT = ['lib/data/identityClient.ts', 'lib/data/definer.ts', 'lib/data/identityReads.ts', 'lib/data/admin.ts'];
const ALLOWED_SYSTEM_CONTEXT = ['lib/data/tenant.ts', 'lib/reminders/job.ts'];

const hitsOf = (t: { module: string; names: readonly string[] }) =>
  scannedFiles().filter((f) => reaches(readFileSync(f, 'utf8'), t.module, t.names));

describe('restricted imports (C4 SF-1, SEC-1)', () => {
  it('NFR-SEC-12 NFR-SEC-09 (lint self-test): each import form is caught, and a longer name is not', () => {
    const caught = [
      `import { identityLaneClient } from '@/lib/data/identityClient';`,
      `import '@/lib/data/identityClient';`,
      `const m = await import('../data/identityClient');`,
      `const { identityLaneClient } = require("./identityClient");`,
      `export { identityLaneClient } from './identityClient';`,
      `export * from "@/lib/data/identityClient.ts";`,
      `import * as x from './somewhereElse'; const c = x.identityLaneClient;`,
    ];
    for (const src of caught) expect(reaches(src, IDENTITY_CLIENT.module, IDENTITY_CLIENT.names), src).toBe(true);
    for (const src of [
      `import { systemContext } from '@/lib/data/tenant';`,
      `const { systemContext } = await import('@/lib/data/tenant');`,
      `const { systemContext } = require('../data/tenant');`,
      `export { systemContext } from './tenant';`,
      `import * as t from '@/lib/data/tenant'; await t.systemContext(id, 'reminders', run);`,
    ]) expect(reaches(src, SYSTEM_CONTEXT.module, SYSTEM_CONTEXT.names), src).toBe(true);
    for (const src of [
      `import { x } from './identityClientHelpers';`,
      `const myidentityLaneClient = 1;`,
      `import { withOrg } from '@/lib/data/tenant';`,
      `const systemContextual = true;`,
    ]) {
      expect(reaches(src, IDENTITY_CLIENT.module, IDENTITY_CLIENT.names) || reaches(src, SYSTEM_CONTEXT.module, SYSTEM_CONTEXT.names), src).toBe(false);
    }
  });

  it('NFR-SEC-12 (lint, not vacuous): the scan reads app, lib, scripts and the root files', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toEqual(expect.arrayContaining(['instrumentation.ts', 'proxy.ts', 'lib/data/definer.ts', 'lib/data/tenant.ts']));
    expect(files.some((f) => f.startsWith('scripts/'))).toBe(true);
    expect(files.some((f) => f.startsWith('app/'))).toBe(true);
  });

  it('NFR-SEC-12: identityLaneClient is reached only from definer.ts, identityReads.ts and admin.ts', () => {
    const hits = hitsOf(IDENTITY_CLIENT);
    expect(hits).toContain('lib/data/definer.ts');   // a real importer is found, so the scan is not vacuous
    expect(hits.filter((f) => !ALLOWED_IDENTITY_CLIENT.includes(f))).toEqual([]);
  });

  it('NFR-SEC-09 ADR-C5: systemContext is named only in lib/data/tenant.ts and lib/reminders/job.ts', () => {
    const hits = hitsOf(SYSTEM_CONTEXT);
    expect(hits).toContain('lib/data/tenant.ts');   // the definition is found, so the scan is not vacuous
    expect(hits.filter((f) => !ALLOWED_SYSTEM_CONTEXT.includes(f))).toEqual([]);
  });
});
