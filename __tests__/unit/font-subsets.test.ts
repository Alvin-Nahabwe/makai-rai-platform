import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PERF-02 (SRS line 3195): every public page transfers at most 220 KB on a first visit. Every page preloads one
 * Source Sans 3 file and one DM Serif Display file, so their size is paid on every page. The preloaded files hold
 * printable ASCII and the few other characters the pages' own copy uses; the rest of the latin range Google's
 * stylesheet declared sits in a third file per family that is not preloaded and that a browser fetches only when a
 * page shows one of its characters (a name with an accent, say). Nothing that rendered in the font before falls back
 * to another font now: these tests read the files' own character maps, not only the declared ranges.
 *
 * The originals stay under fonts/source/ and scripts/fonts/subset.sh regenerates the subsets from them.
 */

// ---------------------------------------------------------------------------------------------- unicode-range sets

type Ranges = Array<[number, number]>;

/** Parses a CSS unicode-range value (`U+20-7E,U+B7,U+??`) into inclusive [from, to] pairs. */
function parseRange(value: string): Ranges {
  return value.split(',').map((part) => {
    const m = /^U\+([0-9A-F]{1,6}|[0-9A-F]{0,5}\?{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(part.trim());
    if (!m || (m[1].includes('?') && m[2] !== undefined)) throw new Error(`not a unicode-range part: ${JSON.stringify(part)}`);
    const [a, b] = m[1].includes('?') ? [m[1].replace(/\?/g, '0'), m[1].replace(/\?/g, 'F')] : [m[1], m[2] ?? m[1]];
    const range: [number, number] = [parseInt(a, 16), parseInt(b, 16)];
    if (range[0] > range[1]) throw new Error(`a unicode-range part runs backwards: ${part}`);
    return range;
  });
}

function inRanges(cp: number, ranges: Ranges): boolean {
  return ranges.some(([a, b]) => cp >= a && cp <= b);
}

function codePoints(ranges: Ranges): Set<number> {
  const out = new Set<number>();
  for (const [a, b] of ranges) for (let c = a; c <= b; c++) out.add(c);
  return out;
}

const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

/** The latin range of Google's stylesheet, which the latin file declared before this change (unit FONTS, D-279). */
const OLD_LATIN = parseRange(
  'U+??,U+131,U+152-153,U+2BB-2BC,U+2C6,U+2DA,U+2DC,U+304,U+308,U+329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
);

/** C0 controls, DEL and C1 controls: no visible glyph, and a newline in pre-wrap text must not fetch a font file. */
const isControl = (cp: number) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

// ---------------------------------------------------------------------------------------------- the layout's calls

interface Call {
  constName: string;
  file: string;
  family: string;
  range: Ranges;
  rangeText: string;
  preload: boolean;
}

const LAYOUT = readFileSync('app/layout.tsx', 'utf8');

function layoutCalls(src: string): Call[] {
  return [...src.matchAll(/const (\w+) = localFont\(\{([\s\S]*?)\n\}\);/g)].map((m) => {
    const body = m[2];
    const field = (re: RegExp, what: string) => {
      const found = re.exec(body)?.[1];
      if (!found) throw new Error(`app/layout.tsx: the localFont call of ${m[1]} has no ${what} this test can read`);
      return found;
    };
    const file = field(/^\s*src:\s*'\.\/([^']+)'/m, 'src');
    const family = field(/\{\s*prop:\s*'font-family',\s*value:\s*'([^']*)'\s*\}/, 'font-family declaration');
    const rangeText = field(/\{\s*prop:\s*'unicode-range',\s*value:\s*'([^']*)'\s*\}/, 'unicode-range declaration');
    return { constName: m[1], file, family, rangeText, range: parseRange(rangeText), preload: !body.includes('preload: false') };
  });
}

const CALLS = layoutCalls(LAYOUT);
const FAMILIES = ['sourceSans', 'dmSerif'] as const;
/** The original latin file of each family, as next/font/google downloaded it. */
const ORIGINAL: Record<(typeof FAMILIES)[number], string> = {
  sourceSans: 'fonts/source/source-sans-3-latin.woff2',
  dmSerif: 'fonts/source/dm-serif-display-latin.woff2',
};

function callsOf(family: string): { core: Call; rest: Call; ext: Call } {
  const of = CALLS.filter((c) => c.family === family);
  const core = of.filter((c) => c.preload);
  const rest = of.filter((c) => !c.preload && c.file.includes('-latin-rest.'));
  const ext = of.filter((c) => !c.preload && c.file.includes('-latin-ext.'));
  expect({ family, core: core.length, rest: rest.length, ext: ext.length }).toEqual({ family, core: 1, rest: 1, ext: 1 });
  return { core: core[0], rest: rest[0], ext: ext[0] };
}

// ---------------------------------------------------------------------------------------------- WOFF2 cmap reader

/** The code points a WOFF2 file maps to a glyph (its cmap's format 4 or 12 subtable). */
function woff2CodePoints(path: string): Set<number> {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`${path} is not a WOFF2 file`);
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  const KNOWN: Record<number, string> = { 0: 'cmap', 10: 'glyf', 11: 'loca' };
  let pos = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[pos++];
      v = v * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new Error(`${path}: bad UIntBase128`);
  };
  let offset = 0;
  let cmap: { at: number; length: number } | undefined;
  for (let t = 0; t < numTables; t++) {
    const flags = buf[pos++];
    const index = flags & 0x3f;
    let tag = KNOWN[index] ?? `#${index}`;
    if (index === 63) {
      tag = buf.toString('latin1', pos, pos + 4);
      pos += 4;
    }
    const version = flags >> 6;
    const origLength = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const length = transformed ? base128() : origLength;
    if (tag === 'cmap') cmap = { at: offset, length };
    offset += length;
  }
  if (!cmap) throw new Error(`${path} has no cmap table`);
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error(`${path} is a font collection, which this reader does not read`);
  const stream = brotliDecompressSync(buf.subarray(pos, pos + totalCompressedSize));
  if (stream.length !== offset) throw new Error(`${path}: the table data is ${stream.length} bytes, the directory says ${offset}`);
  const data = stream.subarray(cmap.at, cmap.at + cmap.length);
  const out = new Set<number>();
  const numSub = data.readUInt16BE(2);
  let read = 0;
  for (let i = 0; i < numSub; i++) {
    const sub = data.readUInt32BE(4 + i * 8 + 4);
    const format = data.readUInt16BE(sub);
    if (format === 4 || format === 12) read++;
    if (format === 4) {
      const segX2 = data.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = data.readUInt16BE(ends + s * 2);
        const start = data.readUInt16BE(starts + s * 2);
        const delta = data.readInt16BE(deltas + s * 2);
        const ro = data.readUInt16BE(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (ro === 0) glyph = (c + delta) & 0xffff;
          else {
            const g = data.readUInt16BE(rangeOffsets + s * 2 + ro + (c - start) * 2);
            glyph = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const at = sub + 16 + g * 12;
        const start = data.readUInt32BE(at);
        const end = data.readUInt32BE(at + 4);
        const glyph = data.readUInt32BE(at + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.add(c);
      }
    }
  }
  if (read === 0 || out.size === 0) throw new Error(`${path}: no format 4 or 12 cmap subtable with any mapping`);
  return out;
}

// ---------------------------------------------------------------------------------------------- the pages' copy

/**
 * Source text with its comments removed, so a character only a comment holds does not count. A TypeScript or TSX file
 * goes through the compiler (removeComments, JSX kept as written), which knows a `/*` or `//` inside a string is not a
 * comment; a stylesheet has only block comments.
 */
function uncommented(text: string, file: string): string {
  if (file.endsWith('.css')) return text.replace(/\/\*[\s\S]*?\*\//g, '');
  if (!/\.tsx?$/.test(file)) return text;
  return ts.transpileModule(text, {
    fileName: file,
    compilerOptions: { removeComments: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
}

/** The HTML entities source text may use, by name; any other named entity fails the scan rather than being skipped. */
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', middot: '\u00b7', sect: '\u00a7',
  ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026',
  rarr: '\u2192', larr: '\u2190', times: '\u00d7',
};

/** `text` with JSX/HTML entities and JavaScript escapes replaced by the characters they stand for. */
function decoded(text: string, file: string): string {
  // A stylesheet spells a character as a CSS escape (`content: '\\2019'`), up to six hex digits and one optional space.
  const css = file.endsWith('.css') ? text.replace(/\\([0-9a-f]{1,6}) ?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))) : text;
  return css
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (_m, e: string) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      const ch = ENTITIES[e];
      if (ch === undefined) throw new Error(`${file}: the entity &${e}; is not in this test's table; add it`);
      return ch;
    })
    .replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_m, a?: string, b?: string, c?: string) => String.fromCodePoint(parseInt((a ?? b ?? c)!, 16)));
}

/** Resolves an import specifier of `from` to a file in this repository, or undefined for a package. */
function resolveImport(from: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = normalize(join(dirname(from), spec));
  else return undefined;
  const stem = base.replace(/\.js$/, '');
  for (const candidate of [base, `${stem}.tsx`, `${stem}.ts`, `${stem}/index.tsx`, `${stem}/index.ts`]) {
    if (existsSync(candidate) && /\.(tsx?|css|json|md)$/.test(candidate)) return candidate;
  }
  if (/\.(svg|png|jpe?g|webp|ico)$/.test(base) && existsSync(base)) return undefined;
  throw new Error(`${from}: the import ${JSON.stringify(spec)} resolves to no file this scan reads`);
}

/** `roots` and every repository file they import, transitively. */
function importClosure(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(tsx?|css)$/.test(f)) continue;
    const text = uncommented(readFileSync(f, 'utf8'), f);
    const specs = f.endsWith('.css')
      ? [...text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
      : [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+(['"])([^'"]+)\1|import\s+(['"])([^'"]+)\3|(?:import|require)\(\s*(['"])([^'"]+)\5\s*\)/g)].map((m) => m[2] ?? m[4] ?? m[6]);
    for (const spec of specs) {
      const target = resolveImport(f, spec);
      if (target) queue.push(target);
    }
  }
  return [...seen].sort();
}

function gitFiles(...patterns: string[]): string[] {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...patterns], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

/** The public pages (S-01 to S-04, S-06, S-28), S-05, the root layout and their imports, and every legal text. */
function publicCopyFiles(): string[] {
  const pages = gitFiles('app/(public)/**/page.tsx');
  // S-01 to S-04, S-06 and S-28 (with /terms and /privacy, which redirect); a glob that finds fewer proves less.
  expect(pages.length, 'public pages found').toBeGreaterThanOrEqual(8);
  // The not-found and error pages render for anyone, signed in or not, in the same layout.
  const roots = [...pages, ...gitFiles('app/(public)/**/layout.tsx'), 'app/layout.tsx', 'app/not-found.tsx', 'app/error.tsx', 'app/global-error.tsx', 'app/(authenticated)/acceptances/page.tsx'];
  return [...importClosure(roots), ...gitFiles('data/legal/**/*.md')];
}

/** Each character outside printable ASCII in `files` (comments ignored), with the first file that holds it. */
function charactersIn(files: string[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const f of files) {
    const text = decoded(uncommented(readFileSync(f, 'utf8'), f), f);
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if ((cp > 0x7e || cp < 0x20) && !'\n\r\t'.includes(ch) && !out.has(cp)) out.set(cp, f);
    }
  }
  return out;
}

/**
 * Characters the public copy holds that no range declared before this change, or now: neither original subset file
 * maps them, so they render in the fallback font today, as before. Each is pinned to stay outside the old ranges, so
 * this list can never excuse a character this change stopped covering.
 */
const NEVER_COVERED: Record<string, string> = {
  [hex(0x2190)]: "app/(public)/forgot-password/page.tsx: '← Back to sign in' (the latin subset maps U+2191 and U+2193, not U+2190)",
  [hex(0x2192)]: "app/globals.css: content: '→' after a link (the latin subset maps U+2191 and U+2193, not U+2192)",
  [hex(0x2713)]: "app/(public)/about/AboutPage.css: content: '✓ ' before a list item",
};

// ---------------------------------------------------------------------------------------------- the tests

describe('NFR-PERF-02: the preloaded font files hold printable ASCII and the pages’ punctuation', () => {
  it('NFR-PERF-02: the layout loads three latin-script files per family, of which only the core file is preloaded', () => {
    for (const family of FAMILIES) {
      const { core, rest, ext } = callsOf(family);
      for (const c of [core, rest, ext]) expect(existsSync(join('app', c.file)), c.file).toBe(true);
      expect(core.file).toMatch(/-latin-core\.woff2$/);
    }
    expect(CALLS.filter((c) => c.preload).map((c) => c.constName).sort()).toEqual(['dmSerif', 'sourceSans']);
  });

  for (const family of FAMILIES) {
    it(`NFR-PERF-02: ${family}'s preloaded file declares, and its cmap maps, every code point from U+0020 to U+007E`, () => {
      const { core } = callsOf(family);
      const cmap = woff2CodePoints(join('app', core.file));
      const missing: string[] = [];
      for (let cp = 0x20; cp <= 0x7e; cp++) {
        if (!inRanges(cp, core.range)) missing.push(`${hex(cp)} not declared`);
        if (!cmap.has(cp)) missing.push(`${hex(cp)} not in the file`);
      }
      expect(missing).toEqual([]);
    });

    it(`NFR-PERF-02: ${family}'s core and rest files split the old latin range between them, controls aside`, () => {
      const { core, rest } = callsOf(family);
      const problems: string[] = [];
      for (const cp of codePoints(OLD_LATIN)) {
        const inCore = inRanges(cp, core.range);
        const inRest = inRanges(cp, rest.range);
        if (isControl(cp)) {
          if (inCore || inRest) problems.push(`${hex(cp)} is a control character and is declared`);
        } else if (inCore === inRest) problems.push(`${hex(cp)} is declared by ${inCore ? 'both files' : 'neither file'}`);
      }
      for (const cp of [...codePoints(core.range), ...codePoints(rest.range)]) {
        if (!inRanges(cp, OLD_LATIN)) problems.push(`${hex(cp)} is outside the old latin range`);
      }
      expect(problems).toEqual([]);
    });

    it(`NFR-PERF-02: every glyph ${family}'s original latin file mapped in its declared range is in the file whose range now declares it`, () => {
      const { core, rest } = callsOf(family);
      const [orig, coreMap, restMap] = [woff2CodePoints(ORIGINAL[family]), woff2CodePoints(join('app', core.file)), woff2CodePoints(join('app', rest.file))];
      expect(orig.size, 'the original file maps characters').toBeGreaterThan(200);
      const lost: string[] = [];
      for (const cp of orig) {
        // A glyph outside the old declared range (the file maps U+0300 and U+0301, say) was never used from it.
        if (isControl(cp) || !inRanges(cp, OLD_LATIN)) continue;
        if (inRanges(cp, core.range) && !coreMap.has(cp)) lost.push(`${hex(cp)} missing from ${core.file}`);
        else if (inRanges(cp, rest.range) && !restMap.has(cp)) lost.push(`${hex(cp)} missing from ${rest.file}`);
        else if (!inRanges(cp, core.range) && !inRanges(cp, rest.range)) lost.push(`${hex(cp)} declared by neither file`);
      }
      expect(lost).toEqual([]);
    });
  }

  it('NFR-PERF-02: the latin-ext file of each family is declared before its rest and core files, so the code points it shares with the latin range resolve to the file cut from the latin one', () => {
    for (const family of FAMILIES) {
      const { core, rest, ext } = callsOf(family);
      for (const latin of [rest, core]) {
        expect(LAYOUT.indexOf(`'./${ext.file}'`), `${ext.file} before ${latin.file}`).toBeLessThan(LAYOUT.indexOf(`'./${latin.file}'`));
      }
    }
  });

  /**
   * Text typed by people (an organisation's name on the public invitation page S-04, an inviter's name, a member's
   * name in the sidebar) is not in the repository, so the copy scans cannot see it. The characters a keyboard or a
   * paste most often adds to otherwise ASCII names sit in the preloaded file, so such a name does not fetch a rest
   * file: the no-break space, the en dash, the curly quotes (iOS types U+2019 for an apostrophe), and the combining
   * macron, diaeresis and dot below, which decomposed (NFD) text puts after an ASCII letter; with the mark in the rest
   * file, no one face would hold the letter and its mark. Latin-1 letters stay in the rest file: in the preloaded
   * files they cost about 12 KB on every page.
   */
  const TYPED = [0xa0, 0x2013, 0x2018, 0x2019, 0x201a, 0x201b, 0x201c, 0x201d, 0x304, 0x308, 0x329];
  for (const family of FAMILIES) {
    it(`NFR-PERF-02: ${family}'s preloaded file declares, and maps where the original did, the no-break space, en dash, curly quotes and the combining marks U+0304, U+0308 and U+0329`, () => {
      const { core } = callsOf(family);
      const [orig, map] = [woff2CodePoints(ORIGINAL[family]), woff2CodePoints(join('app', core.file))];
      const missing: string[] = [];
      for (const cp of TYPED) {
        if (!inRanges(cp, core.range)) missing.push(`${hex(cp)} not declared`);
        if (orig.has(cp) && !map.has(cp)) missing.push(`${hex(cp)} not in the file`);
      }
      expect(missing).toEqual([]);
    });
  }

  it('NFR-PERF-02: every character of the public pages, S-05 and the legal texts is declared by some file of each family', () => {
    const files = publicCopyFiles();
    // The closure must reach the shared footer, the form components and the legal texts, or it proves nothing.
    expect(files).toEqual(expect.arrayContaining(['components/layout/Footer.tsx', 'app/(public)/about/AboutPage.css']));
    expect(files.filter((f) => f.startsWith('data/legal/')).length).toBeGreaterThan(3);
    const uncovered: string[] = [];
    for (const [cp, file] of charactersIn(files)) {
      // A control character (a regex escape such as \x00 in lib/validate.ts) draws no glyph and fetches no file.
      if (hex(cp) in NEVER_COVERED || isControl(cp)) continue;
      for (const family of FAMILIES) {
        const declared = CALLS.filter((c) => c.family === family).some((c) => inRanges(cp, c.range));
        if (!declared) uncovered.push(`${hex(cp)} (${file}) in no ${family} range`);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it('NFR-PERF-02: the characters listed as never covered were outside the old ranges too, and are still in the copy', () => {
    // The latin-ext files and their range did not change, so the layout's ext range is the old one.
    expect(callsOf('dmSerif').ext.rangeText).toBe(callsOf('sourceSans').ext.rangeText);
    const OLD_EXT = callsOf('sourceSans').ext.range;
    const present = charactersIn(publicCopyFiles());
    for (const key of Object.keys(NEVER_COVERED)) {
      const cp = parseInt(key.slice(2), 16);
      expect({ key, oldLatin: inRanges(cp, OLD_LATIN), oldExt: inRanges(cp, OLD_EXT), present: present.has(cp) }).toEqual({ key, oldLatin: false, oldExt: false, present: true });
    }
  });

  /** Files under lib whose rest-range characters are never shown: regexes, a byte-order-mark check, a thrown error. */
  const LIB_NOT_COPY: Record<string, string> = {
    'lib/claims/pattern.ts': 'the product-claims regexes and their test strings (U+2010, U+2011, U+2015, U+2019)',
    'lib/data/tenant.ts': 'the text of an Error thrown to a developer (U+2019), never rendered',
    'lib/evidence/format.ts': 'BIDI_CONTROLS, a regex of U+202A-202E and U+2066-2069 that strips them',
    'lib/legal/registry.ts': "the check that a legal text does not start with U+FEFF",
  };

  it('NFR-PERF-02: no page needs the rest file for the copy of app, components, lib or data', () => {
    // A latin character outside printable ASCII that a page's own text uses belongs in the preloaded file; otherwise
    // that page fetches the rest file on every first visit and the cut buys nothing there. data/ holds the question
    // content and the citations report pages show (components/report/ReferencesList.tsx renders ref.citation).
    const sheets = gitFiles('app', 'components', 'lib', 'data').filter((f) => /\.(tsx?|css|json|md)$/.test(f) && !f.includes('__tests__') && !(f in LIB_NOT_COPY));
    expect(sheets.length).toBeGreaterThan(50);
    expect(sheets).toEqual(expect.arrayContaining(['data/scoringConfig.json', 'lib/http/messages.ts']));
    for (const f of Object.keys(LIB_NOT_COPY)) expect(existsSync(f), `${f} (LIB_NOT_COPY) exists`).toBe(true);
    const { core } = callsOf('sourceSans');
    const needRest = [...charactersIn(sheets)].filter(([cp]) => inRanges(cp, OLD_LATIN) && !isControl(cp) && !inRanges(cp, core.range)).map(([cp, f]) => `${hex(cp)} ${f}`);
    // To fix a failure here: rewrite the copy, or move the character into CORE in scripts/fonts/subset.sh and the four
    // core and rest ranges in app/layout.tsx, run the script, and re-pin the files in __tests__/unit/local-fonts.test.ts.
    expect(needRest, 'copy characters only the rest file holds (see the comment above this line)').toEqual([]);
    expect(callsOf('dmSerif').core.rangeText, 'both families preload the same range').toBe(core.rangeText);
  });

  it('NFR-PERF-02: scripts/fonts/subset.sh cuts the files with the ranges the layout declares', () => {
    const script = readFileSync('scripts/fonts/subset.sh', 'utf8');
    const core = /^CORE='([^']+)'$/m.exec(script)?.[1];
    const rest = /^REST='([^']+)'$/m.exec(script)?.[1];
    for (const family of FAMILIES) {
      const calls = callsOf(family);
      expect({ family, core, rest }).toEqual({ family, core: calls.core.rangeText, rest: calls.rest.rangeText });
    }
  });

  it('(harness) the cmap reader and the range parser read what fontTools reads', () => {
    // len(TTFont(f).getBestCmap()) for each file, fontTools 4.46.0.
    const SIZES: Record<string, number> = {
      'fonts/source/source-sans-3-latin.woff2': 231,
      'fonts/source/dm-serif-display-latin.woff2': 221,
      'app/fonts/source-sans-3-latin-ext.woff2': 563,
      'app/fonts/dm-serif-display-latin-ext.woff2': 102,
    };
    for (const [f, n] of Object.entries(SIZES)) expect({ f, n: woff2CodePoints(f).size }).toEqual({ f, n });
    // The original Source Sans 3 latin subset maps 231 code points (fontTools 4.46: len(TTFont(f).getBestCmap())).
    const orig = woff2CodePoints(ORIGINAL.sourceSans);
    expect(orig.size).toBe(231);
    expect([0x41, 0xe9, 0x2014, 0x20ac].every((cp) => orig.has(cp))).toBe(true);
    expect(orig.has(0x2190)).toBe(false);
    expect(parseRange('U+??,U+20-7E,U+B7')).toEqual([[0, 0xff], [0x20, 0x7e], [0xb7, 0xb7]]);
    for (const bad of ['U+2O14', 'U+20-7E,', 'U+7E-20', '20-7E']) expect(() => parseRange(bad), bad).toThrow();
    // 256 + 131 = 387 code points in the old latin range, of which 65 are controls (U+00-1F, U+7F-9F).
    expect(codePoints(OLD_LATIN).size).toBe(387);
    expect([...codePoints(OLD_LATIN)].filter((cp) => !isControl(cp)).length).toBe(322);
    // The scan reads characters, not their spelling in source: an entity, an escape and a string holding /* or //.
    expect(decoded(uncommented("const a = <p>&copy; '\\u00e9' {'//x'} {\"/*\"} &#8212;</p>; // \u00ff", 'x.tsx'), 'x.tsx')).toMatch(/\u00a9 '\u00e9' \{'\/\/x'\} \{"\/\*"\} \u2014/);
    expect(() => decoded('&bogus;', 'x.tsx')).toThrow(/bogus/);
    expect(decoded(".a::before { content: '\\2019 x\\00a0'; }", 'a.css')).toBe(".a::before { content: '\u2019x\u00a0'; }");
  });
});
