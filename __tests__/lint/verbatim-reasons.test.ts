import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFiles, ROOT } from './helpers/repo-files';
import { type Report, verbatimReport } from './helpers/verbatim';

/**
 * `verbatim(kind, text)` (lib/vocabulary/verbatim.ts) is the only way past the vocabulary lint
 * (__tests__/lint/vocabulary.test.ts). Its first argument must be the string LITERAL 'legal-text' or 'giz-credit':
 * the parameter's type alone does not bind it, since a variable, a cast or a template satisfies the type. Every call in
 * the repository's .ts and .tsx files outside __tests__/ and e2e/ is found however verbatim was imported, and listed,
 * so a reviewer sees each one. The resolver (./helpers/verbatim.ts) is the one the lint uses. It fails any other way
 * to reach the text past the lint: a declaration or binding named verbatim outside the declaring file, a re-export of
 * verbatim or its module, a dynamic import of the module, or verbatim passed around as a value.
 * Files come from ./helpers/repo-files.ts, as for the lint: tracked plus untracked, not ignored.
 */

describe('verbatim is called only with the two reasons', () => {
  it('every call in the repository passes a literal legal-text or giz-credit; the calls are listed', () => {
    const files = repoFiles().filter((f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('__tests__/') && !f.startsWith('e2e/'));
    expect(files).toContain('lib/vocabulary/verbatim.ts');
    expect(files.length).toBeGreaterThan(100);
    const all: Report = { calls: [], failures: [] };
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      if (!src.includes('verbatim')) continue; // a file without the word can neither call nor declare it
      const r = verbatimReport(f, src);
      all.calls.push(...r.calls);
      all.failures.push(...r.failures);
    }
    console.log(`verbatim calls (${all.calls.length}):${all.calls.map((c) => `\n  ${c}`).join('')}`);
    expect(all.failures).toEqual([]);
  });

  describe('on fixtures', () => {
    const imp = "import { verbatim } from '@/lib/vocabulary/verbatim';\n";
    it('a literal legal-text or giz-credit is listed and passes', () => {
      expect(verbatimReport('lib/a/copy.ts', `${imp}verbatim('legal-text', 'x'); verbatim("giz-credit", 'y');`))
        .toEqual({ calls: ['lib/a/copy.ts:2 legal-text', 'lib/a/copy.ts:2 giz-credit'], failures: [] });
    });
    it('another literal, a variable, a cast or a template fails', () => {
      const src = `${imp}const k = 'legal-text' as const;\nverbatim('other' as never, 'x');\nverbatim(k, 'x');\nverbatim('legal-text' as 'legal-text', 'x');\nverbatim(\`legal-text\`, 'x');\nverbatim('other', 'x');`;
      expect(verbatimReport('lib/a/copy.ts', src).failures).toHaveLength(5);
    });
    it('an aliased import, a namespace import and a relative path to the module are resolved', () => {
      expect(verbatimReport('lib/a/copy.ts', "import { verbatim as v } from '@/lib/vocabulary/verbatim';\nv(k, 'x');").failures).toHaveLength(1);
      expect(verbatimReport('lib/a/copy.ts', "import * as V from '../vocabulary/verbatim';\nV.verbatim(k, 'x');\nV.verbatim('giz-credit', 'y');"))
        .toEqual({ calls: ['lib/a/copy.ts:3 giz-credit'], failures: [expect.stringContaining('lib/a/copy.ts:2: first argument is k')] });
    });
    it('a relative path that does not reach lib/vocabulary/verbatim is not the module', () => {
      expect(verbatimReport('lib/a/copy.ts', "import { verbatim } from './verbatim';\nverbatim('giz-credit', 'x');").failures)
        .toEqual(['lib/a/copy.ts:1: a binding named verbatim that is not imported from lib/vocabulary/verbatim']);
    });
    it('a local function, a parameter or a variable named verbatim fails', () => {
      expect(verbatimReport('lib/a/copy.ts', "const verbatim = (_k: string, t: string) => t;\nexport const C = verbatim('giz-credit', 'the RAI Toolkit');").failures)
        .toEqual(['lib/a/copy.ts:1: a declaration named verbatim outside lib/vocabulary/verbatim.ts']);
      expect(verbatimReport('lib/a/copy.ts', 'function verbatim(k: string, t: string) { return t; }').failures).toHaveLength(1);
      expect(verbatimReport('lib/a/copy.ts', 'export const f = (verbatim: (k: string, t: string) => string) => verbatim("giz-credit", "x");').failures).toHaveLength(1);
      expect(verbatimReport('lib/a/copy.ts', 'const { verbatim } = obj;').failures).toHaveLength(1);
    });
    it('a re-export of verbatim or of its module fails: named, renamed, from a barrel, or export *', () => {
      expect(verbatimReport('lib/ui/copy.ts', "export { verbatim } from '@/lib/vocabulary/verbatim';").failures).toEqual(['lib/ui/copy.ts:1: re-export of lib/vocabulary/verbatim']);
      expect(verbatimReport('lib/ui/copy.ts', "export { verbatim as quote } from '@/lib/vocabulary/verbatim';").failures).toHaveLength(1);
      expect(verbatimReport('lib/ui/copy.ts', "export * from '@/lib/vocabulary/verbatim';").failures).toHaveLength(1);
      expect(verbatimReport('lib/ui/copy.ts', "export * as V from '@/lib/vocabulary/verbatim';").failures).toHaveLength(1);
      expect(verbatimReport('lib/ui/copy.ts', `${imp}export { verbatim };`).failures).toEqual(['lib/ui/copy.ts:2: verbatim re-exported as verbatim']);
      // The consumer of such a barrel imports a binding named verbatim from another module.
      expect(verbatimReport('lib/b/copy.ts', "import { verbatim } from '@/lib/ui/copy';\nverbatim('giz-credit', 'x');").failures)
        .toEqual(['lib/b/copy.ts:1: a binding named verbatim that is not imported from lib/vocabulary/verbatim']);
    });
    it('a dynamic import or require of the module fails', () => {
      expect(verbatimReport('lib/a/copy.ts', "const m = await import('@/lib/vocabulary/verbatim');").failures).toEqual(['lib/a/copy.ts:1: dynamic import of lib/vocabulary/verbatim']);
      expect(verbatimReport('lib/a/copy.ts', "const m = require('../vocabulary/verbatim');").failures).toHaveLength(1);
    });
    it('passing verbatim as a value fails', () => {
      expect(verbatimReport('lib/a/copy.ts', `${imp}const q = verbatim;`).failures).toEqual(['lib/a/copy.ts:2: verbatim used as a value, not called']);
    });
    it('the declaring file itself is clean', () => {
      const src = readFileSync(join(ROOT, 'lib/vocabulary/verbatim.ts'), 'utf8');
      expect(verbatimReport('lib/vocabulary/verbatim.ts', src)).toEqual({ calls: [], failures: [] });
    });
  });
});
