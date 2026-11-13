import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Register row D-279 (unit FONTS), carried over to Overpass by stage 1A task 2. The one typeface is served from this
 * repository, not fetched from Google at build time (`next/font/google`; a build that cannot reach Google, or that
 * Google's stylesheet breaks, fails). The `latin` and `latin-ext` files of Overpass (variable weight, 400 to 700) are
 * byte copies of what Google's stylesheet lists for them, fetched by scripts/fonts/fetch-overpass.sh into fonts/source/.
 * scripts/fonts/subset.sh splits the `latin` file into the `latin-core` file every page preloads and the `latin-rest`
 * file a page fetches only when it shows one of those characters, and the `latin-ext` file into `latin-ext-common`
 * and `latin-ext-rest` (NFR-PERF-02; the splits themselves are pinned by `__tests__/unit/font-subsets.test.ts`).
 * Every file is pinned by size and sha256, because the served ones go to every visitor and a same-size file would
 * otherwise pass. The SIL Open Font License text sits beside the files in both directories, because the licence
 * requires the text to travel with any copy of the font software. The import ban itself is
 * `__tests__/lint/no-google-fonts.test.ts`.
 */

const DIR = join(process.cwd(), 'app', 'fonts');
const SOURCE_DIR = join(process.cwd(), 'fonts', 'source');

/** The directory, file name, and the byte size and sha256 of each file (the originals as Google serves them). */
const FONT_FILES = [
  { dir: SOURCE_DIR, name: 'overpass-latin.woff2', bytes: 39_380, sha256: '29217ef8adef5f6c059feb461bdb029348205fc233dc9b6ca8604b0d068ac086' },
  { dir: SOURCE_DIR, name: 'overpass-latin-ext.woff2', bytes: 46_080, sha256: '0a1c9727f08b91252c19bd4ca36caf98162455f33c0adcac935606b5d8d11938' },
  { dir: DIR, name: 'overpass-latin-core.woff2', bytes: 27_212, sha256: '27b7dffd898afaef5a65883fa98d994006128dce58bba2ac555e5c996f0c39c4' },
  { dir: DIR, name: 'overpass-latin-rest.woff2', bytes: 16_104, sha256: '28d91acff78f194aaa051b5c63ed177ea86c4fb475b58799f96c040c818d6ddf' },
  { dir: DIR, name: 'overpass-latin-ext-common.woff2', bytes: 13_952, sha256: '4fd1720bcf21db833305624ac30fe8a17bae7298429785c2ac7b6d7912142069' },
  { dir: DIR, name: 'overpass-latin-ext-rest.woff2', bytes: 37_320, sha256: '3ef5fca8977f7e1bd7358ee5054f6fb4a8fd47598c7b9cb6bd09087d147ea72b' },
] as const;

/** The licence file: the first line of the upstream text (google/fonts ofl/overpass/OFL.txt at 5dac96833c85), exactly. */
const LICENCE = {
  name: 'OFL-Overpass.txt',
  firstLine: 'Copyright 2021 The Overpass Project Authors (https://github.com/RedHatOfficial/Overpass)',
  bytes: 4_392,
  sha256: '86e5ff25c701ec446d20b1a85b02ee6d36de8503a7288a4c948f5459809af1f0',
} as const;

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

  for (const dir of [DIR, SOURCE_DIR]) {
    it(`${relative(process.cwd(), dir)}/${LICENCE.name} exists, opens with the upstream first line and is the upstream text`, () => {
      const path = join(dir, LICENCE.name);
      expect(existsSync(path), `${path} exists`).toBe(true);
      const file = readFileSync(path);
      const text = file.toString('utf8');
      expect(text.split('\n')[0]).toBe(LICENCE.firstLine);
      expect(text, 'licence name').toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(file.length).toBe(LICENCE.bytes);
      expect(createHash('sha256').update(file).digest('hex'), 'sha256').toBe(LICENCE.sha256);
    });
  }

  it('no file of another family is left in app/fonts or fonts/source', () => {
    const left = [...readdirSync(DIR), ...readdirSync(SOURCE_DIR)].filter((f) => /source-sans|dm-serif|SourceSans|DMSerif/i.test(f));
    expect(left).toEqual([]);
  });
});

/**
 * `next/font/local` takes `declarations` once per call and puts them on every @font-face of that call, so a
 * family that has one file per subset needs one `localFont()` call per file, each with its own `unicode-range`.
 * The CSS variable the stylesheet reads (`--font-overpass`) is built from the JS constant's name, so the
 * `font-family` every call of a family declares has to equal that constant's name, or the variable names a
 * family that no @font-face defines (measured on the Turbopack 16.4.2 build). `wiringProblems` reads the layout's
 * source text and lists what differs from that wiring; if a formatter reflows the font block the parse finds
 * nothing and the test fails (it cannot pass by accident), and the fix is to reflow the block or the parse.
 */
/** The core range (printable ASCII, the characters typed names add, and the punctuation page copy uses) and the rest of Google's latin range. */
const LATIN_CORE = 'U+20-7E,U+A0,U+A7,U+B7,U+304,U+308,U+329,U+2013-2014,U+2018-201D,U+2026,U+2191,U+2193';
const LATIN_REST =
  'U+A1-A6,U+A8-B6,U+B8-FF,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+300-301,U+303,U+309,U+323,U+2000-2012,U+2015-2017,U+201E-201F,U+2021-2025,U+2027-206F,U+20AC,U+2122,U+2212,U+2215,U+FEFF,U+FFFD';
/**
 * Overpass's latin-ext file, cut in two (NFR-PERF-02): the letters names commonly carry (the old Source Sans range
 * intersected with the file's cmap), and every other code point the file maps that no latin face holds
 * (scripts/fonts/subset.sh computes and prints both).
 */
const EXT_COMMON = 'U+100-101,U+104-107,U+10C-10D,U+112-113,U+116-119,U+11E-11F,U+122-123,U+128-12B,U+12E-130,U+136-137,U+13B-13C,U+141-148,U+14A-14D,U+150-151,U+158-15B,U+15E-161,U+168-16B,U+16E-173,U+179-17E,U+181,U+186,U+18A,U+190,U+192,U+194,U+253-254,U+256-257,U+25B,U+263,U+28B,U+1E62-1E63';
const EXT_REST =
  'U+102-103,U+108-10B,U+10E-111,U+114-115,U+11A-11D,U+120-121,U+124-127,U+12C-12D,U+132-135,U+138-13A,U+13D-140,U+149,U+14E-14F,U+154-157,U+15C-15D,U+162-167,U+16C-16D,U+174-178,U+17F,U+187-189,U+18E-18F,U+191,U+193,U+196-199,U+19D,U+1A0-1A1,U+1A4-1A5,U+1A9,U+1AC-1B4,U+1B7,U+1C0-1F5,U+1F8-21B,U+21E-21F,U+226-233,U+237,U+242-245,U+24B-24C,U+250-252,U+259,U+25F-261,U+265-266,U+268-269,U+26E-26F,U+272,U+279,U+27D-27E,U+283,U+288-28A,U+28C-28E,U+292,U+294-295,U+29E,U+2A1-2A4,U+2A6-2A7,U+2A9-2AC,U+2B0,U+2B2,U+2B7-2BA,U+2C7,U+2C9,U+2D6,U+2DD,U+2E1-2E3,U+1E04-1E05,U+1E0C-1E0F,U+1E12-1E13,U+1E20-1E21,U+1E24-1E25,U+1E2E-1E2F,U+1E36-1E37,U+1E3C-1E3F,U+1E44-1E47,U+1E4A-1E4D,U+1E50-1E53,U+1E6C-1E71,U+1E80-1E85,U+1E92-1E93,U+1E9E,U+1EF2-1EF9,U+2020,U+20A1-20AB,U+20AD-20BF,U+2113,U+2C64,U+2C6D,U+2C72-2C73,U+A78B-A78D,U+A7AA';

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
  family: 'overpass';
  /** Not preloaded: the latin-ext and latin-rest files. Only the core file of a family is preloaded. */
  ext: boolean;
  /** The CSS variable only the core call of a family defines. */
  variable?: string;
  /** `adjustFontFallback` as written, for a core call; the other calls always write `false`. */
  fallback?: string;
}

const SPECS: Spec[] = [
  // next/font/local builds the fallback face from Arial unless told otherwise; Overpass is a sans-serif, so Arial is the
  // metric match for the face every page preloads (the layout writes it out, so a change of fallback is a visible edit).
  { file: 'overpass-latin-core.woff2', range: LATIN_CORE, family: 'overpass', ext: false, variable: '--font-overpass', fallback: "'Arial'" },
  { file: 'overpass-latin-rest.woff2', range: LATIN_REST, family: 'overpass', ext: true },
  { file: 'overpass-latin-ext-rest.woff2', range: EXT_REST, family: 'overpass', ext: true },
  { file: 'overpass-latin-ext-common.woff2', range: EXT_COMMON, family: 'overpass', ext: true },
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
  for (const family of ['overpass'] as const) {
    // Where two faces of a family cover a code point, the one declared last is tried first. Google's stylesheet declared
    // latin-ext before latin, so the code points they share resolved to the latin file where it had the glyph: U+0304,
    // U+0308 and U+0329 are in core now, U+0131 and U+0152-0153 in rest, so latin-ext comes before both of the files cut
    // from the latin one. (U+2020, which no latin file maps, is declared by the latin-ext faces only.)
    // (Overpass's two latin-ext faces declare no code point the latin faces declare; the order is kept anyway.)
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
  // One variable file serves every weight a page asks for, so the four Overpass calls share a weight range; which
  // range is the UI unit's to narrow (SRS UX-38), not this test's to pin.
  const weights = SPECS.map((x) => weight(x.file));
  if (!weights[0] || weights.some((w) => w !== weights[0])) problems.push(`the four Overpass calls declare the weights ${weights.map((w) => JSON.stringify(w)).join(', ')}, expected one weight on all`);
  if (!src.includes('className={overpass.variable}')) problems.push('the html element lost its font variable class');
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

  it('(harness) a layout that narrows the weight on every Overpass call passes, so the range may change', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'", true))).toEqual([]);
  });

  it('(harness) each way the wiring can break is reported', () => {
    expect(wiringProblems(mutate("weight: '400 700'", "weight: '500 700'"))[0]).toMatch(/one weight on all/);
    expect(wiringProblems(mutate("value: 'U+20-7E,", "value: 'U+0-FF,"))[0]).toMatch(/unicode-range/);
    expect(wiringProblems(mutate("value: 'overpass'", "value: 'overpassSans'"))[0]).toMatch(/font-family/);
    expect(wiringProblems(mutate("  preload: false,\n", ''))[0]).toMatch(/preload/);
    expect(wiringProblems(mutate("  adjustFontFallback: 'Arial',\n", ''))[0]).toMatch(/adjustFontFallback/);
    expect(wiringProblems(mutate('className={overpass.variable}', 'className=""'))[0]).toMatch(/variable class/);
    expect(wiringProblems('')[0]).toMatch(/0 localFont calls/);
    // The order check reads where each file's path first appears, so exchanging the two paths exchanges the order.
    const swapped = mutate("./fonts/overpass-latin-core.woff2", '@@').replace('./fonts/overpass-latin-ext-common.woff2', './fonts/overpass-latin-core.woff2').replace('@@', './fonts/overpass-latin-ext-common.woff2');
    expect(wiringProblems(swapped).join('\n')).toMatch(/is declared after/);
    expect(wiringProblems(mutate('never use', 'do use')).join('\n')).toMatch(/never to use the constant/);
  });
});

/**
 * The uses of a font variable in the stylesheet text `css` (comments ignored) that break this unit's rule: the
 * Overpass variable carries the fallback `system-ui` inside the var(), and the variables of the two retired families
 * are not read at all (nothing defines them). A var() with no fallback makes the whole declaration invalid when the
 * variable is unset, so the text drops to the browser's default instead of the stack that follows it.
 */
function fontVariableProblems(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems: string[] = [];
  for (const m of text.matchAll(/var\(\s*(--font-overpass|--font-source-sans|--font-dm-serif)\s*(?:,\s*([^)]*?)\s*)?\)/g)) {
    if (m[1] !== '--font-overpass') problems.push(`${m[0]} reads a variable no layout defines any more`);
    else if (m[2] !== 'system-ui') problems.push(`${m[0]} has ${m[2] === undefined ? 'no fallback' : `the fallback ${m[2]}`}, expected system-ui`);
  }
  return problems;
}

describe('every stylesheet reads the font variable the layout defines with a fallback (D-279)', () => {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'app', 'components'], { encoding: 'utf8' });
  const sheets = out.split('\n').filter((f) => f.endsWith('.css') && existsSync(f));

  // app/global-error.tsx renders its own <html> without the font class. It loads none of this stylesheet today
  // (only app/layout.tsx imports it), but a page of that kind that did, or a second root layout, would leave the
  // variable unset, so every use keeps its fallback.
  it('app/globals.css: --font-family reads --font-overpass with a valid fallback, and --font-display is the same family', () => {
    const css = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/--font-family:\s*var\(--font-overpass,\s*system-ui\),/);
    expect(css).toMatch(/--font-display:\s*var\(--font-family\);/);
  });

  it('no .css file under app or components reads a font variable without its fallback, or one of the retired families', () => {
    // A scan over no files would pass for nothing.
    expect(sheets.length, 'stylesheets in the scan').toBeGreaterThan(5);
    expect(sheets).toContain('app/globals.css');
    const problems = Object.fromEntries(sheets.map((f) => [f, fontVariableProblems(readFileSync(f, 'utf8'))]).filter(([, p]) => p.length > 0));
    expect(problems).toEqual({});
  });

  it('(harness) a use without its fallback, or with another one, or of a retired variable is reported; the right fallback and a comment are not', () => {
    expect(fontVariableProblems('.a { font-family: var(--font-overpass), monospace; }')).toEqual(['var(--font-overpass) has no fallback, expected system-ui']);
    expect(fontVariableProblems('.a { font-family: var(--font-overpass, monospace), x; }')).toEqual(['var(--font-overpass, monospace) has the fallback monospace, expected system-ui']);
    expect(fontVariableProblems('.a { font-family: var(--font-source-sans, system-ui); } .b { font-family: var(--font-dm-serif); }')).toEqual([
      'var(--font-source-sans, system-ui) reads a variable no layout defines any more',
      'var(--font-dm-serif) reads a variable no layout defines any more',
    ]);
    expect(fontVariableProblems('.a { font-family: var(--font-overpass, system-ui), monospace; } .b { font-family: var( --font-overpass , system-ui ); }')).toEqual([]);
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
