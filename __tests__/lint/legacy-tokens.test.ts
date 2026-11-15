import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Plan 1A, Task 1 added a block of legacy names to app/globals.css so screens not yet restyled kept resolving their old
 * variables; Task 21 deleted that block on 15 November 2026. Two properties keep it gone.
 *
 *  (a) Every `var(--x)` read in a tracked stylesheet or source file resolves to a name defined in globals.css, or to a
 *      name in EXTERNAL below, each with the file that defines it. The test fails when that file stops defining it.
 *  (b) None of the 82 legacy names (LEGACY_NAMES below, copied from the block before it was deleted) is defined in
 *      globals.css or read by any tracked file, so a name cannot come back.
 *
 * Scope: tracked `.css`, `.ts` and `.tsx` files outside `__tests__/` and `e2e/`, which quote variable names as test
 * data rather than read them.
 */

/** Variables defined outside globals.css: name -> [file, text that proves the file still defines it]. */
const EXTERNAL: Record<string, [string, RegExp]> = {
  '--font-overpass': ['app/layout.tsx', /variable:\s*'--font-overpass'/],
  '--decision-save-bar-h': ['components/decision/DecisionForm.tsx', /setProperty\('--decision-save-bar-h'/],
  '--shell-panel-top': ['components/layout/TopBar.tsx', /setProperty\('--shell-panel-top'/],
};

/** The 82 names the deleted LEGACY ALIASES block defined. */
const LEGACY_NAMES = new Set([
  '--border',
  '--border-radius-full',
  '--border-radius-lg',
  '--border-radius-md',
  '--border-radius-sm',
  '--border-radius-xl',
  '--border-strong',
  '--color-black',
  '--color-charcoal',
  '--color-cross-cutting',
  '--color-gray-200',
  '--color-gray-300',
  '--color-gray-400',
  '--color-gray-500',
  '--color-gray-600',
  '--color-gray-700',
  '--color-in-processing',
  '--color-info',
  '--color-navy',
  '--color-navy-light',
  '--color-off-white',
  '--color-post-processing',
  '--color-pre-processing',
  '--color-primary',
  '--color-primary-dark',
  '--color-primary-light',
  '--color-risk-critical',
  '--color-risk-high',
  '--color-risk-low',
  '--color-risk-moderate',
  '--color-white',
  '--focus-ring',
  '--font-display',
  '--font-size-2xl',
  '--font-size-3xl',
  '--font-size-4xl',
  '--font-size-5xl',
  '--font-size-6xl',
  '--font-size-base',
  '--font-size-lg',
  '--font-size-sm',
  '--font-size-xl',
  '--font-size-xs',
  '--font-weight-extrabold',
  '--font-weight-medium',
  '--form-field-border',
  '--gradient-brand',
  '--line-height-normal',
  '--line-height-relaxed',
  '--line-height-tight',
  '--link',
  '--shadow-glow',
  '--shadow-lg',
  '--shadow-md',
  '--shadow-sm',
  '--shadow-xl',
  '--stage-bg',
  '--stage-fg',
  '--surface-base',
  '--surface-card',
  '--surface-raised',
  '--text-body',
  '--text-muted',
  '--text-primary',
  '--tint-accent-bg',
  '--tint-accent-fg',
  '--tint-brand-bg',
  '--tint-brand-fg',
  '--tint-critical-bg',
  '--tint-critical-fg',
  '--tint-high-bg',
  '--tint-high-fg',
  '--tint-info-bg',
  '--tint-info-fg',
  '--tint-low-bg',
  '--tint-low-fg',
  '--tint-moderate-bg',
  '--tint-moderate-fg',
  '--transition-base',
  '--transition-fast',
  '--transition-slow',
  '--transition-spring',
]);

const globals = readFileSync('app/globals.css', 'utf8');

const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  .split('\n')
  .filter((f) => /\.(css|tsx?)$/.test(f) && !/^(__tests__|e2e|node_modules)\//.test(f) && existsSync(f));

function definedIn(source: string): Set<string> {
  return new Set([...source.matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
}

/** Names read with var(), a template-literal fragment such as `--font-weight-${x}` is not a name and is skipped. */
function readsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/var\(\s*(--[A-Za-z0-9_-]*[A-Za-z0-9_])\s*[,)]/g)].map((m) => m[1]);
}

const GLOBAL_NAMES = definedIn(globals);
const readers = Object.fromEntries(tracked.map((f) => [f, new Set(readsOf(f))]));

describe('legacy tokens', () => {
  it('the scan reads stylesheets and the fixed list holds 82 names', () => {
    expect(tracked.length).toBeGreaterThan(20);
    expect(LEGACY_NAMES.size).toBe(82);
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

  it('(b) globals.css defines no legacy name and has no LEGACY ALIASES block', () => {
    expect(globals).not.toContain('LEGACY ALIASES');
    expect([...GLOBAL_NAMES].filter((n) => LEGACY_NAMES.has(n))).toEqual([]);
  });

  it('(b) no tracked file reads a legacy name', () => {
    const readersOfLegacy = tracked.flatMap((f) => [...readers[f]].filter((n) => LEGACY_NAMES.has(n)).map((n) => `${f} reads ${n}`));
    expect(readersOfLegacy).toEqual([]);
  });
});
