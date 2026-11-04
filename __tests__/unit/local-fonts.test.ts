import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Register row D-279 (unit FONTS). The two typefaces are served from this repository, not fetched from Google at
 * build time (`next/font/google`; a build that cannot reach Google, or that Google's stylesheet breaks, fails).
 * The `latin` and `latin-ext` files of Source Sans 3 (variable weight) and DM Serif Display 400 are byte copies of
 * what that loader downloaded. DM Serif's `latin-ext` file is served as it came; the `latin` files are kept under
 * fonts/source/ and split by scripts/fonts/subset.sh into the `latin-core` file every page preloads and the
 * `latin-rest` file it fetches only when it shows one of those characters, and Source Sans 3's `latin-ext` file is
 * kept there too and split into `latin-ext-common` and `latin-ext-rest` (NFR-PERF-02; the splits themselves are
 * pinned by `__tests__/unit/font-subsets.test.ts`). Every file is pinned by size and sha256, because the served
 * ones go to every visitor and a same-size file would otherwise pass. Each family's SIL Open Font License text
 * sits beside its files in both directories, because the licence requires the text to travel with any copy of the
 * font software. The import ban itself is `__tests__/lint/no-google-fonts.test.ts`.
 */

const DIR = join(process.cwd(), 'app', 'fonts');
const SOURCE_DIR = join(process.cwd(), 'fonts', 'source');

/** The directory, file name, and the byte size and sha256 of each file (the originals as taken from the built output). */
const FONT_FILES = [
  { dir: SOURCE_DIR, name: 'source-sans-3-latin.woff2', bytes: 28_804, sha256: '587435ca9d90732b8c1ce4958222c6ad3ade2b875500188e1d318efbcb61f4c5' },
  { dir: SOURCE_DIR, name: 'source-sans-3-latin-ext.woff2', bytes: 60_048, sha256: 'ed3571ea9ff752f1c846f1c9ad2b0006de42f478a2db9163a74db0729a4eb281' },
  { dir: SOURCE_DIR, name: 'dm-serif-display-latin.woff2', bytes: 17_844, sha256: 'f273cf2c9ce9bc7d6b0f4fcb8aee72f8cf5a249991308b6a144217e0760c5d3f' },
  { dir: DIR, name: 'source-sans-3-latin-core.woff2', bytes: 18_616, sha256: 'a3853dd48650b263c16f6d1681373684483eaa38bfb413c99927ca93f8814b68' },
  { dir: DIR, name: 'source-sans-3-latin-rest.woff2', bytes: 11_740, sha256: '9976f3c415dc28fc314c11f4bed5deef5eb017753e3701d899b587e6ed2e3225' },
  { dir: DIR, name: 'source-sans-3-latin-ext-common.woff2', bytes: 11_852, sha256: 'e81c84a0f4b8fad3e5ec116de3c9f4d568d11d8670386b4d616685d6703550fa' },
  { dir: DIR, name: 'source-sans-3-latin-ext-rest.woff2', bytes: 45_484, sha256: 'e49d601aaa19ac5b4504c03487c15f5aaafc2acc04fd206f5b9f95d26aef761c' },
  { dir: DIR, name: 'dm-serif-display-latin-core.woff2', bytes: 11_420, sha256: '3844ad1d6b683dc6c86576b50a797f4983907251a2bd0bd617997568c38821ed' },
  { dir: DIR, name: 'dm-serif-display-latin-rest.woff2', bytes: 7_528, sha256: '579b37a6279b3159ce80986421f1f991dea79467db4ab4f8432e3266b7d903de' },
  { dir: DIR, name: 'dm-serif-display-latin-ext.woff2', bytes: 6_800, sha256: 'dfea1d6549e78df6e55d942c1d1eba5e2f809496205bc0b3a9d684f268b60011' },
] as const;

/** The licence file and the copyright line of the family it covers, as the upstream text opens. */
const LICENCES = [
  { name: 'OFL-SourceSans3.txt', copyright: /^Copyright 2010-2020 Adobe \(http:\/\/www\.adobe\.com\/\), with Reserved Font Name 'Source'/ },
  { name: 'OFL-DMSerifDisplay.txt', copyright: /^Copyright 2014-2018 Adobe \(http:\/\/www\.adobe\.com\/\).*Copyright 2019 Google LLC\./ },
] as const;

describe('the typeface files are committed under app/fonts and fonts/source (D-279, NFR-PERF-02)', () => {
  it('app/fonts holds exactly the served files, and the latin originals are not among them', () => {
    const served = readdirSync(DIR).filter((f) => f.endsWith('.woff2')).sort();
    expect(served).toEqual(FONT_FILES.filter((f) => f.dir === DIR).map((f) => f.name).sort());
  });

  for (const { dir, name, bytes, sha256 } of FONT_FILES) {
    it(`${relative(process.cwd(), dir)}/${name} exists, is a WOFF2 file, is ${bytes} bytes and has its pinned sha256`, () => {
      const path = join(dir, name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const file = readFileSync(path);
      expect(file.subarray(0, 4).toString('latin1'), 'WOFF2 signature').toBe('wOF2');
      expect(statSync(path).size).toBe(bytes);
      expect(createHash('sha256').update(file).digest('hex'), 'sha256').toBe(sha256);
    });
  }

  for (const { name, copyright, dir } of LICENCES.flatMap((l) => [DIR, SOURCE_DIR].map((dir) => ({ ...l, dir })))) {
    it(`${relative(process.cwd(), dir)}/${name} exists and opens with its family's copyright line`, () => {
      const path = join(dir, name);
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
/** The core range (printable ASCII, the characters typed names add, and the punctuation page copy uses) and the rest of Google's latin range. */
const LATIN_CORE = 'U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193';
const LATIN_REST =
  'U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+2000-2012,U+2015-2017,U+201E-201F,U+2021-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD';
/** Source Sans 3's latin-ext file, cut in two (NFR-PERF-02): the letters names commonly carry, and the rest it maps. */
const SANS_EXT_COMMON = 'U+100-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+218-21B,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63';
const SANS_EXT_REST =
  'U+108-10B,U+10E-111,U+114-115,U+11A-11D,U+120-121,U+124-127,U+12C-12F,U+132-135,U+138-13A,U+13D-140,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-167,U+16C-16D,U+174-178,U+17F-180,U+18D-18F,U+193,U+196-197,U+19A-19B,U+19E,U+1A0-1A1,U+1AF-1B1,U+1B7,U+1BF-1C3,U+1CD-1DD,U+1E2-1E7,U+1EA-1EB,U+1EE-1F0,U+1F4-1F5,U+1F7-201,U+204-205,U+208-209,U+20C-20D,U+21C-220,U+222-223,U+226-227,U+237,U+23A-23E,U+241-245,U+248-249,U+250-252,U+255,U+258-25A,U+25C-262,U+264-27B,U+27D-285,U+287-28A,U+28C-292,U+294-295,U+298-299,U+29B-29F,U+2A1-2A8,U+2B0-2B4,U+2B7-2B9,U+2BD-2C1,U+2C7-2CC,U+2D0-2D7,U+2DD-2DE,U+2E0-2E4,U+2ED,U+1D25,U+1D2C,U+1D2E,U+1D30-1D31,U+1D33-1D3A,U+1D3C,U+1D3E-1D43,U+1D47-1D4B,U+1D4D,U+1D4F-1D52,U+1D56-1D58,U+1D5B,U+1D6F-1D70,U+1D79,U+1D7B,U+1D7F,U+1D9C,U+1DA0,U+1DAC,U+1DAE,U+1DB0,U+1DBB,U+1DBF,U+1E02-1E03,U+1E06-1E07,U+1E0A-1E11,U+1E16-1E17,U+1E1E-1E2B,U+1E32-1E3B,U+1E3E-1E49,U+1E52-1E53,U+1E56-1E61,U+1E66-1E67,U+1E6A-1E6F,U+1E72-1E73,U+1E7E-1E85,U+1E8E-1E97,U+1E9E-1E9F,U+1EF2-1EF9,U+2020,U+20A1,U+20A3-20A4,U+20A6-20A7,U+20A9,U+20AB,U+20AE,U+20B1-20B2,U+20B4-20B5,U+20B8-20BA,U+20BD,U+2113,U+2C60-2C62,U+2C65-2C66,U+2C71,U+2C7D,U+A722-A725,U+A74E-A74F,U+A75A-A75B,U+A764-A765,U+A779-A787,U+A789,U+A7AD-A7AE,U+A7B3,U+A7B5,U+A7F2-A7F4';
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
  /** Not preloaded: the latin-ext and latin-rest files. Only the core file of a family is preloaded. */
  ext: boolean;
  /** The CSS variable only the core call of a family defines. */
  variable?: string;
  /** `adjustFontFallback` as written, for a core call; the other calls always write `false`. */
  fallback?: string;
}

const SPECS: Spec[] = [
  { file: 'source-sans-3-latin-core.woff2', range: LATIN_CORE, family: 'sourceSans', ext: false, variable: '--font-source-sans' },
  { file: 'source-sans-3-latin-rest.woff2', range: LATIN_REST, family: 'sourceSans', ext: true },
  { file: 'source-sans-3-latin-ext-rest.woff2', range: SANS_EXT_REST, family: 'sourceSans', ext: true },
  { file: 'source-sans-3-latin-ext-common.woff2', range: SANS_EXT_COMMON, family: 'sourceSans', ext: true },
  // next/font/local builds the fallback face from Arial unless told otherwise, and Arial is a sans-serif: DM Serif
  // Display headings would show in it while the font loads, or for good if it fails. The Google build used a serif.
  { file: 'dm-serif-display-latin-core.woff2', range: LATIN_CORE, family: 'dmSerif', ext: false, variable: '--font-dm-serif', fallback: "'Times New Roman'" },
  { file: 'dm-serif-display-latin-rest.woff2', range: LATIN_REST, family: 'dmSerif', ext: true },
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
    // Where two faces of a family cover a code point, the one declared last is tried first. Google's stylesheet declared
    // latin-ext before latin, so the code points they share resolved to the latin file where it had the glyph: U+0304,
    // U+0308 and U+0329 are in core now, U+0131 and U+0152-0153 in rest, so latin-ext comes before both of the files cut
    // from the latin one. (U+2020, which no latin file maps, is declared by the latin-ext faces only.)
    // (Source Sans 3's two latin-ext faces declare no code point the latin faces declare; the order is kept anyway.)
    const fam = SPECS.filter((x) => x.family === family);
    for (const ext of fam.filter((x) => x.file.includes('-latin-ext'))) {
      for (const latin of fam.filter((x) => !x.file.includes('-latin-ext'))) {
        if (src.indexOf(`./fonts/${ext.file}`) > src.indexOf(`./fonts/${latin.file}`)) problems.push(`${ext.file} is declared after ${latin.file}; Google's order, and the one that keeps the shared code points on the latin files, is latin-ext first`);
      }
    }
    // An unused constant is all next/font allows for a call whose only product is an @font-face, and it still gets a
    // className rule and a variable naming a family nothing defines.
    for (const other of fam.filter((x) => x.ext)) {
      const call = callFor.get(other.file);
      if (call && !new RegExp(`^// .*never use.*\\nconst ${call.constName} = localFont`, 'im').test(src)) problems.push(`${other.file} has no comment line above its call saying never to use the constant's className or variable`);
    }
  }
  const weight = (file: string) => {
    const c = callFor.get(file);
    return c && prop(c, 'weight');
  };
  // One variable file serves every weight a page asks for, so the three Source Sans calls share a weight range; which
  // range is the UI unit's to narrow (SRS UX-38), not this test's to pin.
  const sansWeights = ['source-sans-3-latin-core.woff2', 'source-sans-3-latin-rest.woff2', 'source-sans-3-latin-ext-common.woff2', 'source-sans-3-latin-ext-rest.woff2'].map(weight);
  if (!sansWeights[0] || sansWeights.some((w) => w !== sansWeights[0])) problems.push(`the four Source Sans calls declare the weights ${sansWeights.map((w) => JSON.stringify(w)).join(', ')}, expected one weight on all`);
  for (const file of ['dm-serif-display-latin-core.woff2', 'dm-serif-display-latin-rest.woff2', 'dm-serif-display-latin-ext.woff2']) {
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

  it('(harness) a layout that narrows the weight on every Source Sans call passes, so the range may change', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'", true))).toEqual([]);
  });

  it('(harness) each way the wiring can break is reported', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'"))[0]).toMatch(/one weight on all/);
    expect(wiringProblems(mutate("value: 'U+20-7E,", "value: 'U+0-FF,"))[0]).toMatch(/unicode-range/);
    expect(wiringProblems(mutate("value: 'dmSerif'", "value: 'dmSerifDisplay'"))[0]).toMatch(/font-family/);
    expect(wiringProblems(mutate("  preload: false,\n", ''))[0]).toMatch(/preload/);
    expect(wiringProblems(mutate("  adjustFontFallback: 'Times New Roman',\n", ''))[0]).toMatch(/adjustFontFallback/);
    expect(wiringProblems(mutate('${sourceSans.variable} ', ''))[0]).toMatch(/variable class/);
    expect(wiringProblems('')[0]).toMatch(/0 localFont calls/);
    // The order check reads where each file's path first appears, so exchanging the two paths exchanges the order.
    const swapped = mutate("./fonts/source-sans-3-latin-core.woff2", '@@').replace('./fonts/source-sans-3-latin-ext-common.woff2', './fonts/source-sans-3-latin-core.woff2').replace('@@', './fonts/source-sans-3-latin-ext-common.woff2');
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
