import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Register row D-279 (unit FONTS). The two typefaces are served from this repository, not fetched from Google at
 * build time (`next/font/google`; a build that cannot reach Google, or that Google's stylesheet breaks, fails).
 * The four font files are byte copies of what that loader downloaded: Source Sans 3 (variable weight) and
 * DM Serif Display 400, each in a `latin` and a `latin-ext` subset. They are pinned by size and sha256, because
 * they are served to every visitor and a same-size file would otherwise pass. Each family's SIL Open Font
 * License text sits beside its files, because the licence requires the text to travel with any copy of the font
 * software. The import ban itself is `__tests__/lint/no-google-fonts.test.ts`.
 */

const DIR = join(process.cwd(), 'app', 'fonts');

/** The file name, and the byte size and sha256 of the copy taken from the built output. */
const FONT_FILES = [
  { name: 'source-sans-3-latin.woff2', bytes: 28_804, sha256: '587435ca9d90732b8c1ce4958222c6ad3ade2b875500188e1d318efbcb61f4c5' },
  { name: 'source-sans-3-latin-ext.woff2', bytes: 60_048, sha256: 'ed3571ea9ff752f1c846f1c9ad2b0006de42f478a2db9163a74db0729a4eb281' },
  { name: 'dm-serif-display-latin.woff2', bytes: 17_844, sha256: 'f273cf2c9ce9bc7d6b0f4fcb8aee72f8cf5a249991308b6a144217e0760c5d3f' },
  { name: 'dm-serif-display-latin-ext.woff2', bytes: 6_800, sha256: 'dfea1d6549e78df6e55d942c1d1eba5e2f809496205bc0b3a9d684f268b60011' },
] as const;

/** The licence file and the copyright line of the family it covers, as the upstream text opens. */
const LICENCES = [
  { name: 'OFL-SourceSans3.txt', copyright: /^Copyright 2010-2020 Adobe \(http:\/\/www\.adobe\.com\/\), with Reserved Font Name 'Source'/ },
  { name: 'OFL-DMSerifDisplay.txt', copyright: /^Copyright 2014-2018 Adobe \(http:\/\/www\.adobe\.com\/\).*Copyright 2019 Google LLC\./ },
] as const;

describe('the typeface files are committed under app/fonts (D-279)', () => {
  for (const { name, bytes, sha256 } of FONT_FILES) {
    it(`${name} exists, is a WOFF2 file, is ${bytes} bytes and has its pinned sha256`, () => {
      const path = join(DIR, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const file = readFileSync(path);
      expect(file.subarray(0, 4).toString('latin1'), 'WOFF2 signature').toBe('wOF2');
      expect(statSync(path).size).toBe(bytes);
      expect(createHash('sha256').update(file).digest('hex'), 'sha256').toBe(sha256);
    });
  }

  for (const { name, copyright } of LICENCES) {
    it(`${name} exists and opens with its family's copyright line`, () => {
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
 * family that no @font-face defines (measured on the Turbopack 16.4.2 build). `wiringProblems` reads the layout's
 * source text and lists what differs from that wiring; if a formatter reflows the font block the parse finds
 * nothing and the test fails (it cannot pass by accident), and the fix is to reflow the block or the parse.
 */
const LATIN =
  'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF';

interface FontCall {
  constName: string;
  body: string;
}

/** Every `const x = localFont({ ... });` in the layout source, in source order. */
function localFontCalls(src: string): FontCall[] {
  return [...src.matchAll(/const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => ({ constName: m[1], body: m[2] }));
}

/** The value of a property written on one line in a call, with quotes removed. */
function prop(call: FontCall, name: string): string | undefined {
  return call.body.match(new RegExp(`^\\s*${name}:\\s*'([^']*)'`, 'm'))?.[1];
}

/** A property's value as written (quotes kept), up to its comma. */
function rawProp(call: FontCall, name: string): string | undefined {
  return call.body.match(new RegExp(`^\\s*${name}:\\s*([^,\\n]+),`, 'm'))?.[1];
}

/** The `value` of the `declarations` entry whose `prop` is `name`. */
function declared(call: FontCall, name: string): string | undefined {
  return call.body.match(new RegExp(`\\{\\s*prop:\\s*'${name}',\\s*value:\\s*'([^']*)'\\s*\\}`))?.[1];
}

interface Spec {
  file: string;
  range: string;
  family: 'sourceSans' | 'dmSerif';
  ext: boolean;
  /** The CSS variable only the latin call of a family defines. */
  variable?: string;
  /** `adjustFontFallback` as written, for a latin call; the latin-ext calls always write `false`. */
  fallback?: string;
}

const SPECS: Spec[] = [
  { file: 'source-sans-3-latin.woff2', range: LATIN, family: 'sourceSans', ext: false, variable: '--font-source-sans' },
  { file: 'source-sans-3-latin-ext.woff2', range: LATIN_EXT, family: 'sourceSans', ext: true },
  // next/font/local builds the fallback face from Arial unless told otherwise, and Arial is a sans-serif: DM Serif
  // Display headings would show in it while the font loads, or for good if it fails. The Google build used a serif.
  { file: 'dm-serif-display-latin.woff2', range: LATIN, family: 'dmSerif', ext: false, variable: '--font-dm-serif', fallback: "'Times New Roman'" },
  { file: 'dm-serif-display-latin-ext.woff2', range: LATIN_EXT, family: 'dmSerif', ext: true },
];

/** What differs, in the layout source `src`, from the wiring above; empty when it is wired as required. */
function wiringProblems(src: string): string[] {
  const calls = localFontCalls(src);
  if (calls.length !== SPECS.length) return [`${calls.length} localFont calls in app/layout.tsx, expected ${SPECS.length}`];
  const problems: string[] = [];
  const callFor = new Map<string, FontCall>();
  for (const s of SPECS) {
    const matching = calls.filter((c) => prop(c, 'src') === `./fonts/${s.file}`);
    if (matching.length !== 1) {
      problems.push(`${s.file} is loaded by ${matching.length} calls, expected 1`);
      continue;
    }
    const c = matching[0];
    callFor.set(s.file, c);
    const check = (what: string, got: unknown, want: unknown) => {
      if (got !== want) problems.push(`${s.file} ${what}: ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    };
    check('unicode-range', declared(c, 'unicode-range'), s.range);
    check('font-family', declared(c, 'font-family'), s.family);
    check('display', prop(c, 'display'), 'swap');
    check('variable', prop(c, 'variable'), s.variable);
    check('preload: false', c.body.includes('preload: false'), s.ext);
    check('adjustFontFallback', rawProp(c, 'adjustFontFallback'), s.ext ? 'false' : s.fallback);
    // The CSS variable is built from the constant's name, so the latin call is the constant named for the family.
    if (!s.ext) check('constant name', c.constName, s.family);
  }
  for (const family of ['sourceSans', 'dmSerif'] as const) {
    // Where two faces of a family cover a code point, the one declared last wins. Google's stylesheet declared latin-ext
    // before latin, so U+0304, U+0308, U+0329 and U+2020 resolve to the preloaded latin file; keep that order.
    const [latin, ext] = SPECS.filter((x) => x.family === family).sort((a, b) => Number(a.ext) - Number(b.ext));
    if (src.indexOf(`./fonts/${ext.file}`) > src.indexOf(`./fonts/${latin.file}`)) problems.push(`${ext.file} is declared after ${latin.file}; Google's order, and the one that keeps the shared code points on the latin file, is latin-ext first`);
    // An unused constant is all next/font allows for a call whose only product is an @font-face, and it still gets a
    // className rule and a variable naming a family nothing defines.
    const extCall = callFor.get(ext.file);
    if (extCall && !new RegExp(`^// .*never use.*\\nconst ${extCall.constName} = localFont`, 'im').test(src)) problems.push(`${ext.file} has no comment line above its call saying never to use the constant's className or variable`);
  }
  const weight = (file: string) => {
    const c = callFor.get(file);
    return c && prop(c, 'weight');
  };
  // One variable file serves every weight a page asks for, so the two Source Sans calls share a weight range; which
  // range is the UI unit's to narrow (SRS UX-38), not this test's to pin.
  const [latinWeight, extWeight] = [weight('source-sans-3-latin.woff2'), weight('source-sans-3-latin-ext.woff2')];
  if (!latinWeight || latinWeight !== extWeight) problems.push(`the two Source Sans calls declare the weights ${JSON.stringify(latinWeight)} and ${JSON.stringify(extWeight)}, expected one weight on both`);
  for (const file of ['dm-serif-display-latin.woff2', 'dm-serif-display-latin-ext.woff2']) {
    if (weight(file) !== '400') problems.push(`${file} weight: ${JSON.stringify(weight(file))}, expected "400"`);
  }
  if (!src.includes('className={`${sourceSans.variable} ${dmSerif.variable}`}')) problems.push('the html element lost a font variable class');
  return problems;
}

describe('the layout loads the committed files with next/font/local (D-279)', () => {
  const layout = readFileSync(join(process.cwd(), 'app', 'layout.tsx'), 'utf8');

  it('app/layout.tsx: one localFont call per file, each with its subset unicode-range, family, weight, preload and fallback setting', () => {
    expect(wiringProblems(layout)).toEqual([]);
  });

  /** The layout with `from` replaced by `to` (the first one, or all), failing if nothing changed. */
  function mutate(from: string, to: string, all = false): string {
    const out = all ? layout.replaceAll(from, to) : layout.replace(from, to);
    expect(out, `the mutation changes the layout: ${from}`).not.toBe(layout);
    return out;
  }

  it('(harness) a layout that narrows the weight on both Source Sans calls passes, so UI can narrow it', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'", true))).toEqual([]);
  });

  it('(harness) each way the wiring can break is reported', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'"))[0]).toMatch(/one weight on both/);
    expect(wiringProblems(mutate("value: 'U+??,U+131", "value: 'U+0-FF,U+131"))[0]).toMatch(/unicode-range/);
    expect(wiringProblems(mutate("value: 'dmSerif'", "value: 'dmSerifDisplay'"))[0]).toMatch(/font-family/);
    expect(wiringProblems(mutate("  preload: false,\n", ''))[0]).toMatch(/preload/);
    expect(wiringProblems(mutate("  adjustFontFallback: 'Times New Roman',\n", ''))[0]).toMatch(/adjustFontFallback/);
    expect(wiringProblems(mutate('${sourceSans.variable} ', ''))[0]).toMatch(/variable class/);
    expect(wiringProblems('')[0]).toMatch(/0 localFont calls/);
    // The order check reads where each file's path first appears, so exchanging the two paths exchanges the order.
    const swapped = mutate("./fonts/source-sans-3-latin.woff2", '@@').replace('./fonts/source-sans-3-latin-ext.woff2', './fonts/source-sans-3-latin.woff2').replace('@@', './fonts/source-sans-3-latin-ext.woff2');
    expect(wiringProblems(swapped).join('\n')).toMatch(/is declared after/);
    expect(wiringProblems(mutate('never use', 'do use')).join('\n')).toMatch(/never to use the constant/);
  });
});

/**
 * The uses of a font variable in the stylesheet text `css` (comments ignored) that lack the fallback this unit
 * requires inside the var(): `system-ui` for the Source Sans variable and `Georgia` for the DM Serif one. A var()
 * with no fallback makes the whole declaration invalid when the variable is unset, so the text drops to the
 * browser's default instead of the stack that follows it.
 */
function fontVariableProblems(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems: string[] = [];
  for (const m of text.matchAll(/var\(\s*(--font-source-sans|--font-dm-serif)\s*(?:,\s*([^)]*?)\s*)?\)/g)) {
    const want = m[1] === '--font-source-sans' ? 'system-ui' : 'Georgia';
    if (m[2] !== want) problems.push(`${m[0]} has ${m[2] === undefined ? 'no fallback' : `the fallback ${m[2]}`}, expected ${want}`);
  }
  return problems;
}

describe('every stylesheet reads the font variables the layout defines with a fallback (D-279)', () => {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'app', 'components'], { encoding: 'utf8' });
  const sheets = out.split('\n').filter((f) => f.endsWith('.css') && existsSync(f));

  // app/global-error.tsx renders its own <html> without the two font classes. It loads none of this stylesheet today
  // (only app/layout.tsx imports it), but a page of that kind that did, or a second root layout, would leave the
  // variables unset, so every use keeps its fallback.
  it('app/globals.css: --font-family and --font-display keep a valid fallback inside their var()', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/--font-family:\s*var\(--font-source-sans,\s*system-ui\),/);
    expect(css).toMatch(/--font-display:\s*var\(--font-dm-serif,\s*Georgia\),/);
  });

  it('no .css file under app or components reads --font-source-sans or --font-dm-serif without its fallback', () => {
    // A scan over no files would pass for nothing.
    expect(sheets.length, 'stylesheets in the scan').toBeGreaterThan(5);
    expect(sheets).toContain('app/globals.css');
    const problems = Object.fromEntries(sheets.map((f) => [f, fontVariableProblems(readFileSync(f, 'utf8'))]).filter(([, p]) => p.length > 0));
    expect(problems).toEqual({});
  });

  it('(harness) a use without its fallback, or with another one, is reported; the right fallback and a comment are not', () => {
    expect(fontVariableProblems('.a { font-family: var(--font-source-sans), monospace; }')).toEqual(['var(--font-source-sans) has no fallback, expected system-ui']);
    expect(fontVariableProblems('.a { font-family: var(--font-dm-serif); }')).toEqual(['var(--font-dm-serif) has no fallback, expected Georgia']);
    expect(fontVariableProblems('.a { font-family: var(--font-source-sans, monospace), x; }')).toEqual(['var(--font-source-sans, monospace) has the fallback monospace, expected system-ui']);
    expect(fontVariableProblems('.a { font-family: var(--font-source-sans, system-ui), monospace; } .b { font-family: var( --font-dm-serif , Georgia ); }')).toEqual([]);
    expect(fontVariableProblems('/* was var(--font-source-sans) */ .a { color: red; }')).toEqual([]);
  });
});

/**
 * Whether the file `f`, holding `text`, names a retired family where it would be used: in a stylesheet outside its
 * comments, or on a `fontFamily` line of a component.
 */
function namesOldFamily(f: string, text: string): boolean {
  const NAMES = /Source Sans 3|DM Serif Display/;
  // A comment that explains why a name is gone is not a use of it.
  return f.endsWith('.css') ? NAMES.test(text.replace(/\/\*[\s\S]*?\*\//g, '')) : text.split('\n').some((l) => /fontFamily/.test(l) && NAMES.test(l));
}

describe('no stylesheet or component names the old family names (D-279)', () => {
  it("no CSS under app, components or lib, and no fontFamily in a component, says 'Source Sans 3' or 'DM Serif Display'", () => {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'app', 'components', 'lib'], { encoding: 'utf8' });
    const files = out.split('\n').filter((f) => /\.(css|tsx?)$/.test(f) && existsSync(f));
    // A scan over no files would pass for nothing.
    expect(files.length, 'files in the scan').toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('.css')), 'a stylesheet is in the scan').toBe(true);
    expect(files.filter((f) => namesOldFamily(f, readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('(harness) a CSS comment that names a retired family passes; a declaration that names one is reported', () => {
    expect(namesOldFamily('a.css', "/* the body used 'Source Sans 3' before the fonts moved here */\nbody { color: red; }")).toBe(false);
    expect(namesOldFamily('a.css', '/* DM Serif Display\n   was the heading face */\nh1 { margin: 0; }')).toBe(false);
    expect(namesOldFamily('a.css', ".a { font-family: 'Source Sans 3', monospace; }")).toBe(true);
    expect(namesOldFamily('a.css', ":root { --font-display: var(--font-dm-serif, 'DM Serif Display'); }")).toBe(true);
    expect(namesOldFamily('a.css', '/* note */ .a { font-family: "DM Serif Display"; }')).toBe(true);
    expect(namesOldFamily('a.tsx', '<h1 style={{ fontFamily: "DM Serif Display" }} />')).toBe(true);
    expect(namesOldFamily('a.tsx', "// 'Source Sans 3' is no longer loaded\nconst x = 1;")).toBe(false);
  });
});
