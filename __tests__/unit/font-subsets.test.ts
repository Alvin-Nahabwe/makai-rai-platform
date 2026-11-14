import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * NFR-PERF-02 (SRS line 3195): every public page transfers at most 220 KB on a first visit. Every page preloads one
 * Overpass file, so its size is paid on every page. The preloaded files hold
 * printable ASCII and the few other characters the pages' own copy uses; the rest of the latin range Google's
 * stylesheet declared sits in a further file that is not preloaded and that a browser fetches only when a
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

/** The latin range of Google's stylesheet, the same for Source Sans 3 before and for Overpass now (unit FONTS, D-279). */
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
const FAMILIES = ['overpass'] as const;
/** The original latin file of each family, as Google serves it (scripts/fonts/fetch-overpass.sh). */
const ORIGINAL: Record<(typeof FAMILIES)[number], string> = {
  overpass: 'fonts/source/overpass-latin.woff2',
};
/** Google's latin-ext range, as the Overpass stylesheet declares it (the Source Sans and DM Serif ones were the same). */
const GOOGLE_EXT = parseRange(
  'U+100-2BA,U+2BD-2C5,U+2C7-2CC,U+2CE-2D7,U+2DD-2FF,U+304,U+308,U+329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF',
);

/** Code points of the old latin range that no latin file maps but each latin-ext file does: the dagger. */
const HANDED_TO_EXT = [0x2020];

/** How many latin-ext faces each family has: Overpass's is split into a common and a remainder face. */
const EXT_FACES: Record<(typeof FAMILIES)[number], number> = { overpass: 2 };

function callsOf(family: (typeof FAMILIES)[number]): { core: Call; rest: Call; ext: Call[] } {
  const of = CALLS.filter((c) => c.family === family);
  const core = of.filter((c) => c.preload);
  const rest = of.filter((c) => !c.preload && c.file.includes('-latin-rest.'));
  const ext = of.filter((c) => !c.preload && c.file.includes('-latin-ext'));
  expect({ family, core: core.length, rest: rest.length, ext: ext.length, all: of.length })
    .toEqual({ family, core: 1, rest: 1, ext: EXT_FACES[family], all: 2 + EXT_FACES[family] });
  return { core: core[0], rest: rest[0], ext };
}

// ---------------------------------------------------------------------------------------------- WOFF2 reader

/** A WOFF2 file's tables, decompressed, by tag (glyf and loca stay in their WOFF2 transform; nothing here reads them). */
function woff2Tables(path: string): Map<string, Buffer> {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`${path} is not a WOFF2 file`);
  if (buf.toString('latin1', 4, 8) === 'ttcf') throw new Error(`${path} is a font collection, which this reader does not read`);
  const numTables = buf.readUInt16BE(12);
  const totalCompressedSize = buf.readUInt32BE(20);
  // The WOFF2 known-tag indices this file reads (W3C WOFF2, section 5.1).
  const KNOWN: Record<number, string> = { 0: 'cmap', 10: 'glyf', 11: 'loca', 26: 'GDEF', 27: 'GPOS' };
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
  const at = new Map<string, { at: number; length: number }>();
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
    at.set(tag, { at: offset, length });
    offset += length;
  }
  const stream = brotliDecompressSync(buf.subarray(pos, pos + totalCompressedSize));
  if (stream.length !== offset) throw new Error(`${path}: the table data is ${stream.length} bytes, the directory says ${offset}`);
  return new Map([...at].map(([tag, t]) => [tag, stream.subarray(t.at, t.at + t.length)]));
}

/** The glyph id each code point of a WOFF2 file maps to (its cmap's format 4 and 12 subtables), glyph 0 left out. */
function woff2Cmap(path: string): Map<number, number> {
  const data = woff2Tables(path).get('cmap');
  if (!data) throw new Error(`${path} has no cmap table`);
  const out = new Map<number, number>();
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
          if (glyph !== 0) out.set(c, glyph);
        }
      }
    } else if (format === 12) {
      const groups = data.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const at = sub + 16 + g * 12;
        const start = data.readUInt32BE(at);
        const end = data.readUInt32BE(at + 4);
        const glyph = data.readUInt32BE(at + 8);
        for (let c = start; c <= end; c++) if (glyph + (c - start) !== 0) out.set(c, glyph + (c - start));
      }
    }
  }
  if (read === 0 || out.size === 0) throw new Error(`${path}: no format 4 or 12 cmap subtable with any mapping`);
  return out;
}

/** The code points a WOFF2 file maps to a glyph. */
function woff2CodePoints(path: string): Set<number> {
  return new Set(woff2Cmap(path).keys());
}

/** The glyph ids of an OpenType Coverage table at `at` (format 1, a list; format 2, ranges). */
function coverage(data: Buffer, at: number): number[] {
  const format = data.readUInt16BE(at);
  const count = data.readUInt16BE(at + 2);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (format === 1) out.push(data.readUInt16BE(at + 4 + i * 2));
    else if (format === 2) for (let g = data.readUInt16BE(at + 4 + i * 6); g <= data.readUInt16BE(at + 6 + i * 6); g++) out.push(g);
    else throw new Error(`Coverage format ${format}`);
  }
  return out;
}

/**
 * What makes a glyph a mark to the text shaper: its GDEF glyph class 3, and the mark coverages of the GPOS lookups that
 * position marks (MarkBasePos 4, MarkLigPos 5: MarkCoverage; MarkMarkPos 6: Mark1Coverage; each the subtable's second
 * field), extension lookups (9) followed. `marks` maps each glyph in a mark coverage to the lookups that hold it.
 */
function woff2MarkGlyphs(path: string): { class3: Set<number>; marks: Map<number, number[]> } {
  const tables = woff2Tables(path);
  const gdef = tables.get('GDEF');
  const gpos = tables.get('GPOS');
  if (!gdef || !gpos) throw new Error(`${path} has no GDEF or no GPOS table`);
  const class3 = new Set<number>();
  const classDef = gdef.readUInt16BE(4);
  if (classDef !== 0) {
    const format = gdef.readUInt16BE(classDef);
    if (format === 1) {
      const start = gdef.readUInt16BE(classDef + 2);
      const count = gdef.readUInt16BE(classDef + 4);
      for (let i = 0; i < count; i++) if (gdef.readUInt16BE(classDef + 6 + i * 2) === 3) class3.add(start + i);
    } else if (format === 2) {
      for (let i = 0; i < gdef.readUInt16BE(classDef + 2); i++) {
        const r = classDef + 4 + i * 6;
        if (gdef.readUInt16BE(r + 4) === 3) for (let g = gdef.readUInt16BE(r); g <= gdef.readUInt16BE(r + 2); g++) class3.add(g);
      }
    } else throw new Error(`${path}: GDEF ClassDef format ${format}`);
  }
  const marks = new Map<number, number[]>();
  const lookupList = gpos.readUInt16BE(8);
  for (let l = 0; l < gpos.readUInt16BE(lookupList); l++) {
    const lookup = lookupList + gpos.readUInt16BE(lookupList + 2 + l * 2);
    const lookupType = gpos.readUInt16BE(lookup);
    for (let s = 0; s < gpos.readUInt16BE(lookup + 4); s++) {
      let sub = lookup + gpos.readUInt16BE(lookup + 6 + s * 2);
      let type = lookupType;
      if (type === 9) {
        type = gpos.readUInt16BE(sub + 2);
        sub += gpos.readUInt32BE(sub + 4);
      }
      if (type < 4 || type > 6) continue;
      for (const g of coverage(gpos, sub + gpos.readUInt16BE(sub + 2))) marks.set(g, [...(marks.get(g) ?? []), l]);
    }
  }
  return { class3, marks };
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
  const roots = [...pages, ...gitFiles('app/(public)/**/layout.tsx'), 'app/layout.tsx', 'app/not-found.tsx', 'app/error.tsx', 'app/global-error.tsx', 'app/(authenticated)/acceptances/page.tsx', 'app/help/page.tsx', 'app/help/layout.tsx'];
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
 * Code points that four lib files hold but never show, by file: regexes, a byte-order-mark check, a thrown error. Each
 * excuses only the code points named; any other rest-range character in the same file is reported like any copy.
 */
const LIB_NOT_COPY: Record<string, string> = {
  'lib/claims/pattern.ts': 'U+2010-2011,U+2015,U+2019', // the product-claims regexes and their test strings
  'lib/data/tenant.ts': 'U+2019', // the text of an Error thrown to a developer, never rendered
  'lib/evidence/format.ts': 'U+202A-202E,U+2066-2069', // BIDI_CONTROLS, the regex that strips them
  'lib/legal/registry.ts': 'U+FEFF', // the check that a legal text does not start with a byte order mark
};

/**
 * The characters of `entries` (file and text) that only the rest file holds: in the old latin range, not controls,
 * outside the core range, and not excused for that file by LIB_NOT_COPY. One `U+XXXX file` line per file and code point.
 */
function restOnlyCopy(entries: Array<[string, string]>): string[] {
  const core = callsOf('overpass').core.range;
  const out: string[] = [];
  for (const [f, raw] of entries) {
    const excused = f in LIB_NOT_COPY ? parseRange(LIB_NOT_COPY[f]) : [];
    const seen = new Set<number>();
    for (const ch of decoded(uncommented(raw, f), f)) {
      const cp = ch.codePointAt(0)!;
      if (seen.has(cp) || !inRanges(cp, OLD_LATIN) || isControl(cp) || inRanges(cp, core) || inRanges(cp, excused)) continue;
      seen.add(cp);
      out.push(`${hex(cp)} ${f}`);
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
  [hex(0x2713)]: "app/(public)/about/AboutPage.css: content: '✓ ' before a list item",
};

// ---------------------------------------------------------------------------------------------- the tests

describe('NFR-PERF-02: the preloaded font files hold printable ASCII and the pages’ punctuation', () => {
  it('NFR-PERF-02: the layout loads core, rest and latin-ext files per family, of which only the core file is preloaded', () => {
    for (const family of FAMILIES) {
      const { core, rest, ext } = callsOf(family);
      for (const c of [core, rest, ...ext]) expect(existsSync(join('app', c.file)), c.file).toBe(true);
      expect(core.file).toMatch(/-latin-core\.woff2$/);
    }
    expect(CALLS.filter((c) => c.preload).map((c) => c.constName).sort()).toEqual(['overpass']);
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

    it(`NFR-PERF-02: ${family}'s core and rest files split the old latin range between them, controls and U+2020 aside`, () => {
      const { core, rest, ext } = callsOf(family);
      const problems: string[] = [];
      for (const cp of codePoints(OLD_LATIN)) {
        const inCore = inRanges(cp, core.range);
        const inRest = inRanges(cp, rest.range);
        if (HANDED_TO_EXT.includes(cp)) {
          // Neither latin file maps the dagger; the latin-ext file of each family does, so a latin-ext face declares it.
          if (inCore || inRest) problems.push(`${hex(cp)} is declared by core or rest; a latin-ext face holds its glyph`);
          if (!ext.some((e) => inRanges(cp, e.range) && woff2CodePoints(join('app', e.file)).has(cp))) problems.push(`${hex(cp)}: no latin-ext face declares and maps it`);
        } else if (isControl(cp)) {
          if (inCore || inRest) problems.push(`${hex(cp)} is a control character and is declared`);
        } else if (inCore === inRest) problems.push(`${hex(cp)} is declared by ${inCore ? 'both files' : 'neither file'}`);
      }
      for (const cp of [...codePoints(core.range), ...codePoints(rest.range)]) {
        // The combining marks the latin file maps sit in core though Google's latin range omitted them (see the combining-marks case).
        if (!inRanges(cp, OLD_LATIN) && !(cp >= 0x300 && cp <= 0x36f)) problems.push(`${hex(cp)} is outside the old latin range`);
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
      for (const e of ext) {
        for (const latin of [rest, core]) {
          expect(LAYOUT.indexOf(`'./${e.file}'`), `${e.file} before ${latin.file}`).toBeLessThan(LAYOUT.indexOf(`'./${latin.file}'`));
        }
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

  /**
   * S-04 shows the inviter's name in Overpass. One latin-ext letter in it (Luganda's U+014B, say) fetched the
   * whole 60,048 B Source Sans latin-ext file (46,080 B for Overpass's) and put the page over the 220 KB cap. So the letters that
   * names commonly carry sit in a small face of their own, and the rest of latin-ext in another; neither is preloaded.
   * e2e/invitation-name-transfer.spec.ts measures the page with such a name.
   */
  const NAME_LETTERS = [
    // Luganda and other Ugandan and Kenyan orthographies, Akan and Ewe, and European names (the first set, 53 letters)
    0x14a, 0x14b, 0x100, 0x101, 0x112, 0x113, 0x12a, 0x12b, 0x14c, 0x14d, 0x16a, 0x16b, 0x160, 0x161, 0x17d, 0x17e, 0x141, 0x142,
    0x106, 0x107, 0x10c, 0x10d, 0x118, 0x119, 0x104, 0x105, 0x150, 0x151, 0x170, 0x171, 0x11e, 0x11f, 0x15e, 0x15f, 0x130, 0x158,
    0x159, 0x16e, 0x16f, 0x147, 0x148, 0x15a, 0x15b, 0x179, 0x17a, 0x17b, 0x17c, 0x143, 0x144, 0x186, 0x190, 0x254, 0x25b,
    // Kikuyu, Kamba and Meru: Ĩ ĩ Ũ ũ
    0x128, 0x129, 0x168, 0x169,
    // Hausa: Ɓ ɓ Ɗ ɗ (the file has no Ƙ ƙ)
    0x181, 0x253, 0x18a, 0x257,
    // Ewe: ɖ ʋ ƒ Ɣ ɣ (the file has no Ɖ Ʋ Ƒ)
    0x256, 0x28b, 0x192, 0x194, 0x263,
    // Yoruba: Ṣ ṣ (the file has no Ẹ ẹ Ọ ọ)
    0x1e62, 0x1e63,
    // Lithuanian Ė ė Ų ų Į į and Latvian Ģ ģ Ķ ķ Ļ ļ Ņ ņ. Croatian Đ đ are left out by the controller's ruling, and
    // Romanian Ș ș Ț ț Ă ă Ţ ţ by its fallback: with them S-04 measured 217,020 to 217,032 B, over 217,000 B.
    0x116, 0x117, 0x172, 0x173, 0x12e, 0x12f, 0x122, 0x123, 0x136, 0x137, 0x13b, 0x13c, 0x145, 0x146,
  ];
  const ORIGINAL_EXT = 'fonts/source/overpass-latin-ext.woff2';

  it('NFR-PERF-02: the latin-ext letters names commonly carry sit in a small Overpass face of their own, not preloaded', () => {
    const common = callsOf('overpass').ext.find((c) => c.file.endsWith('-latin-ext-common.woff2'));
    expect(common, 'an overpass-latin-ext-common.woff2 call').toBeDefined();
    expect(common!.preload).toBe(false);
    expect([...codePoints(common!.range)].sort((a, b) => a - b)).toEqual([...NAME_LETTERS].sort((a, b) => a - b));
    const map = woff2CodePoints(join('app', common!.file));
    expect(NAME_LETTERS.filter((cp) => !map.has(cp)).map(hex)).toEqual([]);
    // The face's cap is the controller's, set on 13 November 2026 for Overpass (14,100 B; Overpass's cut of these letters
    // is 13,952 B, and the 12,100 B set for Source Sans's 11,600 B did not carry over). The binding budget stays the
    // measured page: S-04 with such a name, which e2e/invitation-name-transfer.spec.ts measures against its own limits.
    expect(statSync(join('app', common!.file)).size).toBeLessThanOrEqual(14_100);
  });

  it('NFR-PERF-02: every Overpass code point a page can use lands in exactly one face, whose file maps it', () => {
    const { core, rest, ext } = callsOf('overpass');
    const faces = [core, rest, ...ext];
    const problems: string[] = [];
    // Declared ranges are disjoint, so no answer depends on the declaration order.
    for (let i = 0; i < faces.length; i++) {
      for (let j = i + 1; j < faces.length; j++) {
        const shared = [...codePoints(faces[i].range)].filter((cp) => inRanges(cp, faces[j].range));
        if (shared.length > 0) problems.push(`${faces[i].file} and ${faces[j].file} both declare ${shared.slice(0, 5).map(hex).join(' ')}`);
      }
    }
    // The two latin-ext faces declare exactly what their files map.
    for (const e of ext) {
      const declared = codePoints(e.range);
      const map = woff2CodePoints(join('app', e.file));
      const extra = [...declared].filter((cp) => !map.has(cp));
      const undeclared = [...map].filter((cp) => !declared.has(cp));
      if (extra.length || undeclared.length) problems.push(`${e.file}: declared without a glyph ${extra.slice(0, 5).map(hex)}; mapped, not declared ${undeclared.slice(0, 5).map(hex)}`);
    }
    // Every code point either source file maps (controls aside) is declared by exactly one face whose file holds its glyph.
    const owners = (cp: number) => faces.filter((f) => inRanges(cp, f.range) && woff2CodePoints(join('app', f.file)).has(cp)).map((f) => f.file);
    const wanted = new Set([...woff2CodePoints(ORIGINAL.overpass), ...woff2CodePoints(ORIGINAL_EXT)].filter((cp) => !isControl(cp)));
    for (const cp of wanted) {
      const o = owners(cp);
      if (o.length !== 1) problems.push(`${hex(cp)} is in ${o.length} faces: ${o.join(', ')}`);
    }
    expect(wanted.size, 'code points the two source files map').toBeGreaterThan(550);
    expect(problems).toEqual([]);
  });

  it('NFR-PERF-02: the characters listed as never covered were outside the old ranges too, and are still in the copy', () => {
    const present = charactersIn(publicCopyFiles());
    for (const key of Object.keys(NEVER_COVERED)) {
      const cp = parseInt(key.slice(2), 16);
      expect({ key, oldLatin: inRanges(cp, OLD_LATIN), oldExt: inRanges(cp, GOOGLE_EXT), present: present.has(cp) }).toEqual({ key, oldLatin: false, oldExt: false, present: true });
    }
  });

  it('NFR-PERF-02: no page needs the rest file for the copy of app, components, lib or data', () => {
    // A latin character outside printable ASCII that a page's own text uses belongs in the preloaded file; otherwise
    // that page fetches the rest file on every first visit and the cut buys nothing there. data/ holds the question
    // content and the citations report pages show (components/report/ReferencesList.tsx renders ref.citation).
    const sheets = gitFiles('app', 'components', 'lib', 'data').filter((f) => /\.(tsx?|css|json|md)$/.test(f) && !f.includes('__tests__'));
    expect(sheets.length).toBeGreaterThan(50);
    expect(sheets).toEqual(expect.arrayContaining(['data/credit.json', 'lib/http/messages.ts']));
    for (const f of Object.keys(LIB_NOT_COPY)) expect(existsSync(f), `${f} (LIB_NOT_COPY) exists`).toBe(true);
    expect(sheets).toEqual(expect.arrayContaining(Object.keys(LIB_NOT_COPY)));
    const needRest = restOnlyCopy(sheets.map((f) => [f, readFileSync(f, 'utf8')]));
    // To fix a failure here: rewrite the copy, or move the character into CORE in scripts/fonts/subset.sh and the four
    // core and rest ranges in app/layout.tsx, run the script, and re-pin the files in __tests__/unit/local-fonts.test.ts.
    expect(needRest, 'copy characters only the rest file holds (see the comment above this line)').toEqual([]);
  });

  it('(harness) a rest-range character added to the copy of a LIB_NOT_COPY file is reported; its excused code points are not', () => {
    const f = 'lib/evidence/format.ts';
    const real = readFileSync(f, 'utf8');
    expect(restOnlyCopy([[f, real]])).toEqual([]);
    expect(restOnlyCopy([[f, `${real}\nexport const label = 'Office document \u00e9';\n`]])).toEqual([`U+00E9 ${f}`]);
    // The same character outside the file's excused code points is reported for every other excluded file too.
    expect(restOnlyCopy([['lib/data/tenant.ts', "throw new Error('can\u2019t \u00a9');"]])).toEqual(['U+00A9 lib/data/tenant.ts']);
  });

  it('NFR-PERF-02: no code point either source file maps is left without a face', () => {
    const { core, rest, ext } = callsOf('overpass');
    const faces = [core, rest, ...ext];
    const mapped = new Set([...woff2CodePoints(ORIGINAL.overpass), ...woff2CodePoints(ORIGINAL_EXT)]);
    const unserved = [...mapped].filter((cp) => !isControl(cp) && !faces.some((f) => inRanges(cp, f.range))).sort((a, b) => a - b);
    expect(unserved.map(hex)).toEqual([]);
  });

  it('NFR-PERF-02: every combining mark (U+0300 to U+036F) that either source file maps is declared by the core or the rest face, never an extended-Latin face, and U+0300, U+0301, U+0303, U+0309 and U+0323 are not in core', () => {
    // Names are shown as typed, so a decomposed name (an e and then U+0301) must find the mark in a latin file, not in
    // the 37 KB ext-rest file. The five marks Google's latin range omitted sit in rest, not core: if core held both an
    // ASCII letter and one of them, the browser could compose an accented letter from the preloaded file and never
    // fetch the face that declares the designed precomposed glyph.
    const { core, rest, ext } = callsOf('overpass');
    const maps = (f: Call) => woff2CodePoints(join('app', f.file));
    const marks = [...new Set([...woff2CodePoints(ORIGINAL.overpass), ...woff2CodePoints(ORIGINAL_EXT)])].filter((cp) => cp >= 0x300 && cp <= 0x36f).sort((a, b) => a - b);
    expect(marks.length, 'combining marks the source files map').toBeGreaterThanOrEqual(7);
    const problems: string[] = [];
    for (const cp of marks) {
      const homes = [core, rest].filter((f) => inRanges(cp, f.range) && maps(f).has(cp));
      if (homes.length !== 1) problems.push(`${hex(cp)} is held by ${homes.length} of core and rest`);
      for (const e of ext) if (inRanges(cp, e.range)) problems.push(`${hex(cp)} is declared by ${e.file}`);
    }
    for (const cp of [0x300, 0x301, 0x303, 0x309, 0x323]) {
      if (inRanges(cp, core.range)) problems.push(`${hex(cp)} is declared by core`);
      if (!inRanges(cp, rest.range)) problems.push(`${hex(cp)} is not declared by rest`);
    }
    expect(problems).toEqual([]);
  });

  it('NFR-PERF-02: every CASES letter of e2e/invitation-name-transfer.spec.ts is declared by exactly one face or listed as uncovered', () => {
    const spec = readFileSync('e2e/invitation-name-transfer.spec.ts', 'utf8');
    const names = [...spec.matchAll(/inviter:\s*'([^']+)'/g)].map((m) => m[1]);
    // The spec has three cases (Luganda, Kikuyu, Hausa); a regex that read fewer would prove less.
    expect(names.length, 'inviter names in CASES').toBe(3);
    const { core, rest, ext } = callsOf('overpass');
    const faces = [core, rest, ...ext];
    /** Name letters no face is to declare; each is a name that would print in the fallback font. Empty today. */
    const UNCOVERED_NAME_LETTERS: number[] = [];
    const letters = new Set([...names.join('')].map((ch) => ch.codePointAt(0)!).filter((cp) => cp > 0x7e));
    expect(letters.size, 'non-ASCII letters in the names').toBeGreaterThan(4);
    const problems: string[] = [];
    for (const cp of letters) {
      const declaring = faces.filter((f) => inRanges(cp, f.range));
      if (UNCOVERED_NAME_LETTERS.includes(cp)) {
        if (declaring.length > 0) problems.push(`${hex(cp)} is listed as uncovered and a face declares it`);
      } else if (declaring.length !== 1) problems.push(`${hex(cp)} is declared by ${declaring.length} faces`);
      else if (!woff2CodePoints(join('app', declaring[0].file)).has(cp)) problems.push(`${hex(cp)} is declared by ${declaring[0].file}, which does not map it`);
    }
    expect(problems).toEqual([]);
  });

  it('NFR-PERF-02: scripts/fonts/subset.sh cuts the files with the ranges the layout declares', () => {
    const script = readFileSync('scripts/fonts/subset.sh', 'utf8');
    const core = /^CORE='([^']+)'$/m.exec(script)?.[1];
    const rest = /^REST='([^']+)'$/m.exec(script)?.[1];
    for (const family of FAMILIES) {
      const calls = callsOf(family);
      expect({ family, core, rest }).toEqual({ family, core: calls.core.rangeText, rest: calls.rest.rangeText });
    }
    const ext = callsOf('overpass').ext;
    const byFile = (suffix: string) => ext.find((c) => c.file.endsWith(suffix))?.rangeText;
    expect({
      common: /^EXT_COMMON='([^']+)'$/m.exec(script)?.[1],
      rest: /^EXT_REST='([^']+)'$/m.exec(script)?.[1],
    }).toEqual({ common: byFile('-latin-ext-common.woff2'), rest: byFile('-latin-ext-rest.woff2') });
  });

  it('(harness) the cmap reader and the range parser read what fontTools reads', () => {
    // len(TTFont(f).getBestCmap()) for each file, fontTools 4.46.0.
    const SIZES: Record<string, number> = {
      'fonts/source/overpass-latin.woff2': 232,
      'fonts/source/overpass-latin-ext.woff2': 439,
      'app/fonts/overpass-latin-ext-common.woff2': 82,
    };
    for (const [f, n] of Object.entries(SIZES)) expect({ f, n: woff2CodePoints(f).size }).toEqual({ f, n });
    // The original Overpass latin subset maps 232 code points (fontTools 4.46: len(TTFont(f).getBestCmap())).
    const orig = woff2CodePoints(ORIGINAL.overpass);
    expect(orig.size).toBe(232);
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

/**
 * Upstream Overpass (fonts/source/, as Google serves it) classes twelve mapped spacing glyphs as marks: the middle dot
 * U+00B7, the backtick U+0060 and the spacing accents (´ ¸ ¨ ¯ ˆ ˚ ˜ in the latin file, ˇ ˉ ˝ in latin-ext). They have
 * GDEF glyph class 3 and sit in the GPOS mark coverages, and the text shaper gives a mark no advance: the " · "
 * separator drew its dot on top of the space after it. scripts/fonts/subset.sh applies the rule "a mapped glyph that
 * Unicode does not class as a combining mark is not a mark" to the four files it writes. A glyph no code point maps
 * (the .dnom figures, the .case marks) is outside the rule and keeps its class.
 */
describe('the served font files: a character Unicode does not class as a combining mark is not a mark in the font', () => {
  const SERVED = ['core', 'rest', 'ext-common', 'ext-rest'].map((p) => `app/fonts/overpass-latin-${p}.woff2`);
  /** Unicode general category Mn, Mc or Me (Python's unicodedata.category, which subset.sh uses, agrees for these). */
  const isCombining = (cp: number) => /^\p{M}$/u.test(String.fromCodePoint(cp));

  /** Each mapped code point outside Mn, Mc and Me whose glyph has GDEF class 3 or is in a GPOS mark coverage. */
  function spacingMarks(path: string): string[] {
    const { class3, marks } = woff2MarkGlyphs(path);
    const out: string[] = [];
    for (const [cp, glyph] of woff2Cmap(path)) {
      if (isCombining(cp)) continue;
      if (class3.has(glyph)) out.push(`${hex(cp)} glyph ${glyph} has GDEF class 3`);
      if (marks.has(glyph)) out.push(`${hex(cp)} glyph ${glyph} is in the mark coverage of GPOS lookup ${marks.get(glyph)!.join(', ')}`);
    }
    return out;
  }

  for (const file of SERVED) {
    it(`${file}: no character outside Mn, Mc and Me has a mark glyph (GDEF class 3, or a GPOS mark coverage)`, () => {
      expect(spacingMarks(file)).toEqual([]);
    });
  }

  for (const [cp, name] of [[0xb7, 'the middle dot'], [0x60, 'the backtick']] as const) {
    it(`${hex(cp)}, ${name}, is a spacing glyph in the core file: not GDEF class 3, in no GPOS mark coverage`, () => {
      const file = 'app/fonts/overpass-latin-core.woff2';
      const glyph = woff2Cmap(file).get(cp);
      expect(glyph, `${file} maps ${hex(cp)}`).toBeDefined();
      const { class3, marks } = woff2MarkGlyphs(file);
      expect({ class3: class3.has(glyph!), markLookups: marks.get(glyph!) ?? [] }).toEqual({ class3: false, markLookups: [] });
    });
  }

  it('the combining marks the core and rest files map stay marks: GDEF class 3, and in a GPOS mark coverage', () => {
    const kept: string[] = [];
    for (const file of SERVED.slice(0, 2)) {
      const { class3, marks } = woff2MarkGlyphs(file);
      for (const [cp, glyph] of woff2Cmap(file)) {
        if (isCombining(cp)) kept.push(`${hex(cp)} ${class3.has(glyph) && marks.has(glyph)}`);
      }
    }
    expect(kept.sort()).toEqual(['U+0300 true', 'U+0301 true', 'U+0303 true', 'U+0304 true', 'U+0308 true', 'U+0309 true', 'U+0323 true']);
  });

  it('(harness) the GDEF and GPOS reader reads what fontTools reads, and finds the fault in the upstream file', () => {
    // fontTools 4.46.0 on fonts/source/overpass-latin.woff2: 32 glyphs of GDEF class 3, the same 32 in the GPOS mark
    // coverages; U+00B7 maps glyph 208, in lookup 1's MarkCoverage; U+0060 in lookup 1's and lookup 3's (Mark1Coverage).
    const upstream = 'fonts/source/overpass-latin.woff2';
    const { class3, marks } = woff2MarkGlyphs(upstream);
    expect({ class3: class3.size, marks: marks.size }).toEqual({ class3: 32, marks: 32 });
    const cmap = woff2Cmap(upstream);
    expect(cmap.get(0xb7)).toBe(208);
    expect(marks.get(cmap.get(0xb7)!)).toEqual([1]);
    expect(marks.get(cmap.get(0x60)!)).toEqual([1, 3]);
    expect(spacingMarks(upstream).filter((l) => l.includes('class 3')).map((l) => l.slice(0, 6)).sort()).toEqual(
      ['U+0060', 'U+00A8', 'U+00AF', 'U+00B4', 'U+00B7', 'U+00B8', 'U+02C6', 'U+02DA', 'U+02DC'],
    );
    expect(spacingMarks('fonts/source/overpass-latin-ext.woff2').filter((l) => l.includes('class 3')).map((l) => l.slice(0, 6)).sort()).toEqual(
      ['U+02C7', 'U+02C9', 'U+02DD'],
    );
  });

  it('scripts/fonts/subset.sh applies the rule to each file between fontTools.subset and the write, and checks what it wrote', () => {
    const script = readFileSync('scripts/fonts/subset.sh', 'utf8');
    // The rule: GDEF class 3 to 1, and out of the mark coverages with the MarkArray records, for every mapped glyph
    // whose code points are not all Mn, Mc or Me.
    const rule = /^def spacing_not_marks\(font\):\n([\s\S]*?)\n(?=\S)/m.exec(script)?.[1] ?? '';
    for (const part of ["unicodedata.category", "('Mn', 'Mc', 'Me')", 'GlyphClassDef', '= 1', 'MarkCoverage', 'Mark1Coverage', 'MarkArray.MarkRecord', 'Mark1Array.MarkRecord']) {
      expect(rule, `the rule holds ${part}`).toContain(part);
    }
    const order = ['subsetter.subset(font)', '= spacing_not_marks(font)', 'subset.save_font(font', '\n    check_written(path)\n'].map((s) => script.indexOf(s));
    expect(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `subset, rule, write, check in that order: ${order}`).toBe(true);
    // Each written file is re-read and refused if a spacing glyph is still a mark, before any replaces a committed one.
    expect(script.indexOf('def check_written(path):')).toBeGreaterThan(0);
    expect(order[3]).toBeLessThan(script.indexOf('mv "$f" app/fonts/'));
  });
});
