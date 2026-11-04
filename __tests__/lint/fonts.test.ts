import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * UX-38 (SRS 7.6.4 rule 7): the application loads only the font weights its
 * screens use, which are 400, 600 and 700. Two halves, because the property is
 * "the weights the CSS asks for are the weights the layout loads":
 *
 *  - the layout loads Source Sans 3 from app/fonts through next/font/local (never next/font/google), in a variable
 *    file whose weight range covers those three;
 *  - no stylesheet asks for another one, whether it writes a number, a
 *    keyword or a `var(--font-weight-*)` token. Tokens are resolved against the
 *    `:root` block of app/globals.css, so a stylesheet that still says
 *    `var(--font-weight-medium)` is held to what that token now means.
 */

const ALLOWED = new Set([400, 600, 700]);
const KEYWORDS: Record<string, number> = { normal: 400, bold: 700 };

function trackedCss(): string[] {
  return execFileSync('git', ['ls-files', '*.css']).toString().trim().split('\n').filter(Boolean);
}

function tokenWeights(globals: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of globals.matchAll(/(--font-weight-[a-z]+):\s*(\d+)\s*;/g)) out[m[1]] = Number(m[2]);
  return out;
}

function resolve(value: string, tokens: Record<string, number>): number | undefined {
  const v = value.replace('!important', '').trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v in KEYWORDS) return KEYWORDS[v];
  const ref = /^var\((--font-weight-[a-z]+)\)$/.exec(v);
  return ref ? tokens[ref[1]] : undefined;
}

describe('fonts', () => {
  const globals = readFileSync('app/globals.css', 'utf8');
  const tokens = tokenWeights(globals);

  it('UX-38: the layout self-hosts Source Sans 3 through next/font/local, in a file that covers 400 to 700', () => {
    // Comments may name the Google loader to say it is not used; only code counts.
    const layout = readFileSync('app/layout.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(layout).toMatch(/from 'next\/font\/local'/);
    expect(layout).not.toMatch(/next\/font\/google/);
    const files = [...layout.matchAll(/src:\s*'\.\/(fonts\/source-sans-3[^']*\.woff2)'/g)].map((m) => m[1]);
    expect(files.length, 'Source Sans 3 files in the layout').toBeGreaterThan(0);
    for (const f of files) expect(existsSync(`app/${f}`), f).toBe(true);
    // The Latin file is a variable font; its declared range must include every weight the CSS may ask for.
    const range = /src:\s*'\.\/fonts\/source-sans-3-latin\.woff2',\s*weight:\s*'(\d+) (\d+)'/.exec(layout);
    expect(range, 'weight range of the Latin file').not.toBeNull();
    expect(Number(range![1])).toBeLessThanOrEqual(400);
    expect(Number(range![2])).toBeGreaterThanOrEqual(700);
  });

  it('UX-38: globals.css names only the regular, semibold and bold weights', () => {
    const named = [...globals.matchAll(/font-weight:\s*([^;]+);/g)].map((m) => m[1].replace('!important', '').trim());
    expect(named.length).toBeGreaterThan(0);
    for (const w of named) {
      expect(
        ['400', '600', '700', 'normal', 'bold', 'var(--font-weight-regular)', 'var(--font-weight-semibold)', 'var(--font-weight-bold)'],
        `font-weight: ${w}`,
      ).toContain(w);
    }
  });

  it('UX-38: every stylesheet resolves to a loaded weight, tokens included', () => {
    for (const file of trackedCss()) {
      const css = readFileSync(file, 'utf8');
      for (const m of css.matchAll(/(?<![-\w])font-weight:\s*([^;}]+)/g)) {
        const weight = resolve(m[1], tokens);
        expect(weight, `${file}: font-weight: ${m[1].trim()} does not resolve to a number`).toBeDefined();
        expect(ALLOWED.has(weight as number), `${file}: font-weight: ${m[1].trim()} resolves to ${weight}`).toBe(true);
      }
    }
  });

  it('UX-38: no weight token is defined at a weight the layout does not load', () => {
    for (const [name, weight] of Object.entries(tokens)) {
      expect(ALLOWED.has(weight), `${name}: ${weight}`).toBe(true);
    }
  });
});
