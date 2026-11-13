import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Plan 1A, Task 1. app/globals.css keeps a block of legacy names (`/* LEGACY ALIASES: deleted by Task 21 *\/`) so every
 * screen not yet restyled still resolves its old variables. Two properties keep that block honest.
 *
 *  (a) Every `var(--x)` read in a tracked stylesheet or source file resolves to a name defined in globals.css, or to a
 *      name in EXTERNAL below, each with the file that defines it. The test fails when that file stops defining it.
 *  (b) The set of files that read a legacy name equals legacy-tokens.allow.json exactly: a new reader fails, and so
 *      does a listed file that no longer reads one ("remove it from the list"). Task 21 empties the list and the block.
 *
 * Scope: tracked `.css`, `.ts` and `.tsx` files outside `__tests__/` and `e2e/`, which quote variable names as test
 * data rather than read them. To regenerate the allow list after a restyle:
 *   LEGACY_TOKENS_PRINT=1 npx vitest run __tests__/lint/legacy-tokens.test.ts
 * prints the current list as JSON; paste it into legacy-tokens.allow.json.
 */

/** Variables defined outside globals.css: name -> [file, text that proves the file still defines it]. */
const EXTERNAL: Record<string, [string, RegExp]> = {
  '--font-source-sans': ['app/layout.tsx', /variable:\s*'--font-source-sans'/],
  '--font-dm-serif': ['app/layout.tsx', /variable:\s*'--font-dm-serif'/],
  '--about-link': ['app/(public)/about/AboutPage.css', /--about-link\s*:/],
  '--about-hero-text': ['app/(public)/about/AboutPage.css', /--about-hero-text\s*:/],
  '--stage-color': ['app/(public)/about/page.tsx', /'--stage-color'\s*:/],
  '--decision-save-bar-h': ['components/decision/DecisionForm.tsx', /setProperty\('--decision-save-bar-h'/],
};

const globals = readFileSync('app/globals.css', 'utf8');

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\n')
  .filter((f) => /\.(css|tsx?)$/.test(f) && !/^(__tests__|e2e|node_modules)\//.test(f) && existsSync(f));

function definedIn(source: string): Set<string> {
  return new Set([...source.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
}

function legacyBlock(source: string): Set<string> {
  const start = source.indexOf('/* LEGACY ALIASES');
  if (start === -1) throw new Error('globals.css has no LEGACY ALIASES block');
  return definedIn(source.slice(start, source.indexOf('}', start)));
}

/** Names read with var(), a template-literal fragment such as `--font-weight-${x}` is not a name and is skipped. */
function readsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/var\(\s*(--[A-Za-z0-9_-]*[A-Za-z0-9_])\s*[,)]/g)].map((m) => m[1]);
}

const GLOBAL_NAMES = definedIn(globals);
const LEGACY = legacyBlock(globals);
const readers = Object.fromEntries(tracked.map((f) => [f, new Set(readsOf(f))]));
const legacyReaders = tracked.filter((f) => [...readers[f]].some((n) => LEGACY.has(n))).sort();

if (process.env.LEGACY_TOKENS_PRINT) console.log(JSON.stringify(legacyReaders, null, 2));

describe('legacy tokens', () => {
  it('the scan reads stylesheets and the legacy block is not empty', () => {
    expect(tracked.length).toBeGreaterThan(20);
    expect(LEGACY.size).toBeGreaterThan(20);
  });

  it('(a) every variable read resolves to globals.css or to a listed external definition', () => {
    const unresolved: string[] = [];
    for (const file of tracked) {
      for (const name of readers[file]) {
        if (!GLOBAL_NAMES.has(name) && !(name in EXTERNAL)) unresolved.push(`${file} reads ${name}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  it('(a) each external variable is still defined by the file the list names', () => {
    for (const [name, [file, proof]] of Object.entries(EXTERNAL)) {
      expect(existsSync(file), `${name}: ${file} exists`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${name} in ${file}`).toMatch(proof);
    }
  });

  it('(b) the files reading a legacy name are exactly the files in legacy-tokens.allow.json', () => {
    const allowed = (JSON.parse(readFileSync('__tests__/lint/legacy-tokens.allow.json', 'utf8')) as string[]).slice().sort();
    const notListed = legacyReaders.filter((f) => !allowed.includes(f)).map((f) => `${f} reads a legacy name: use a new role, or add it to the list`);
    const stale = allowed.filter((f) => !legacyReaders.includes(f)).map((f) => `${f} no longer reads a legacy name: remove it from the list`);
    expect([...notListed, ...stale]).toEqual([]);
  });
});
