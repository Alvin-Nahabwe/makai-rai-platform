import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PRIV-04 (unit FONTS). The two typefaces are served from this repository, not fetched from Google at
 * build time (`next/font/google`; register row D-279). The four font files are byte copies of what that loader
 * downloaded: Source Sans 3 (variable weight) and DM Serif Display 400, each in a `latin` and a `latin-ext`
 * subset. Each family's SIL Open Font License text sits beside its files, because the licence requires the
 * text to travel with any copy of the font software.
 */

const DIR = join(process.cwd(), 'app', 'fonts');

/** The file name, the byte size of the copy taken from the built output, and what the file is. */
const FONT_FILES = [
  { name: 'source-sans-3-latin.woff2', bytes: 28_804 },
  { name: 'source-sans-3-latin-ext.woff2', bytes: 60_048 },
  { name: 'dm-serif-display-latin.woff2', bytes: 17_844 },
  { name: 'dm-serif-display-latin-ext.woff2', bytes: 6_800 },
] as const;

/** The licence file and the copyright line of the family it covers, as the upstream text opens. */
const LICENCES = [
  { name: 'OFL-SourceSans3.txt', copyright: /^Copyright 2010-2020 Adobe \(http:\/\/www\.adobe\.com\/\), with Reserved Font Name 'Source'/ },
  { name: 'OFL-DMSerifDisplay.txt', copyright: /^Copyright 2014-2018 Adobe \(http:\/\/www\.adobe\.com\/\).*Copyright 2019 Google LLC\./ },
] as const;

describe('NFR-PRIV-04: the typeface files are committed under app/fonts', () => {
  for (const { name, bytes } of FONT_FILES) {
    it(`NFR-PRIV-04: ${name} exists, is a WOFF2 file and is ${bytes} bytes`, () => {
      const path = join(DIR, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const file = readFileSync(path);
      expect(file.subarray(0, 4).toString('latin1'), 'WOFF2 signature').toBe('wOF2');
      expect(statSync(path).size).toBe(bytes);
    });
  }

  for (const { name, copyright } of LICENCES) {
    it(`NFR-PRIV-04: ${name} exists and opens with its family's copyright line`, () => {
      const path = join(DIR, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.split('\n')[0]).toMatch(copyright);
      expect(text, 'licence name').toContain('SIL OPEN FONT LICENSE Version 1.1');
    });
  }
});

/**
 * `next/font/local` takes `declarations` once per call and puts them on every @font-face of that call, so a
 * family that has one file per subset needs one `localFont()` call per file, each with its own `unicode-range`.
 * The CSS variable the stylesheet reads (`--font-source-sans`) is built from the JS constant's name, so the
 * `font-family` every call of a family declares has to equal that constant's name, or the variable names a
 * family that no @font-face defines (measured on the Turbopack 16.4.2 build). These tests read the layout.
 */
const LATIN =
  'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface FontCall {
  constName: string;
  body: string;
}

/** Every `const x = localFont({ ... });` in the layout, in source order. */
function localFontCalls(): FontCall[] {
  const src = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
  return [...src.matchAll(/const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({ constName: m[1], body: m[2] }));
}

/** The value of a property written on one line in a call, with quotes removed. */
function prop(call: FontCall, name: string): string | undefined {
  return call.body.match(new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'm'))?.[1];
}

/** The `value` of the `declarations` entry whose `prop` is `name`. */
function declared(call: FontCall, name: string): string | undefined {
  return call.body.match(new RegExp(`\\{\\s*prop:\\s*'${name}',\\s*value:\\s*'([^']*)'\\s*\\}`))?.[1];
}

const WIRING = [
  { file: 'source-sans-3-latin.woff2', range: LATIN, family: 'sourceSans', weight: '300 700', variable: '--font-source-sans' },
  { file: 'source-sans-3-latin-ext.woff2', range: LATIN_EXT, family: 'sourceSans', weight: '300 700', variable: undefined },
  { file: 'dm-serif-display-latin.woff2', range: LATIN, family: 'dmSerif', weight: '400', variable: '--font-dm-serif' },
  { file: 'dm-serif-display-latin-ext.woff2', range: LATIN_EXT, family: 'dmSerif', weight: '400', variable: undefined },
] as const;

describe('NFR-PRIV-04: the layout loads the committed files with next/font/local', () => {
  it('NFR-PRIV-04: one localFont call per file, each with its own subset unicode-range and its family name', () => {
    const calls = localFontCalls();
    expect(calls, 'four localFont calls in app/layout.tsx').toHaveLength(4);
    for (const w of WIRING) {
      const matching = calls.filter((c) => prop(c, 'src') === `./fonts/${w.file}`);
      expect(matching, `exactly one call for ${w.file}`).toHaveLength(1);
      const call = matching[0];
      expect(declared(call, 'unicode-range'), `${w.file} unicode-range`).toBe(w.range);
      expect(declared(call, 'font-family'), `${w.file} font-family`).toBe(w.family);
      expect(prop(call, 'weight'), `${w.file} weight`).toBe(w.weight);
      expect(prop(call, 'display'), `${w.file} display`).toBe('swap');
      expect(prop(call, 'variable'), `${w.file} variable`).toBe(w.variable);
    }
  });

  it('NFR-PRIV-04: the family each file declares is the name of its latin call, so the CSS variable names a defined family', () => {
    const calls = localFontCalls();
    for (const family of ['sourceSans', 'dmSerif']) {
      const latin = calls.find((c) => c.constName === family);
      expect(latin, `a const named ${family}`).toBeDefined();
      expect(prop(latin!, 'src'), `${family} loads the latin file`).toMatch(/-latin\.woff2$/);
      for (const c of calls.filter((x) => declared(x, 'font-family') === family))
        expect(c.constName === family || /-latin-ext\.woff2$/.test(prop(c, 'src') ?? ''), `${c.constName} belongs to ${family}`).toBe(true);
    }
  });

  it('NFR-PRIV-04: only the two latin files are preloaded and carry a fallback face; the latin-ext calls turn both off', () => {
    const calls = localFontCalls();
    expect(calls, 'four localFont calls in app/layout.tsx').toHaveLength(4);
    for (const c of calls) {
      const ext = /-latin-ext\.woff2$/.test(prop(c, 'src') ?? '');
      expect(c.body.includes('preload: false'), `${prop(c, 'src')} preload off`).toBe(ext);
      expect(c.body.includes('adjustFontFallback: false'), `${prop(c, 'src')} no fallback face`).toBe(ext);
    }
  });

  it('NFR-PRIV-04: the html element still carries both font variable classes', () => {
    const src = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');
    expect(src).toContain('className={`${sourceSans.variable} ${dmSerif.variable}`}');
  });
});

describe('NFR-PRIV-04: no stylesheet or component names the old family names', () => {
  it("NFR-PRIV-04: no CSS under app, components or lib, and no fontFamily in a component, says 'Source Sans 3' or 'DM Serif Display'", () => {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'app', 'components', 'lib'], { encoding: 'utf8' });
    const files = out.split('\n').filter((f) => /\.(css|tsx?)$/.test(f) && existsSync(f));
    // A scan over no files would pass for nothing.
    expect(files.length, 'files in the scan').toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('.css')), 'a stylesheet is in the scan').toBe(true);
    const NAMES = /Source Sans 3|DM Serif Display/;
    const hits = files.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return f.endsWith('.css') ? NAMES.test(text) : text.split('\n').some((l) => /fontFamily/.test(l) && NAMES.test(l));
    });
    expect(hits).toEqual([]);
  });
});
