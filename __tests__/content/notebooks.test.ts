import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AreasFile, QuestionBankFile, ResourcesFile } from '@/types/content';
import { CLAIMS_CORE, isClaim } from '@/lib/claims/pattern';
import { linkedContentMarkdown } from '../../notebooks/tools/linkedContent';
import { writeLinkedContent } from '../../notebooks/tools/writeLinkedContent';

/**
 * Checks on the ten technical notebooks (SRS 10.5) and their locked
 * environment. Every check reads files with `fs`; none starts a server or a
 * database (content unit, no slot). A test that reads the running content
 * bundle names no question id literal (contract "Content bundle", gap G088).
 * The when-to-use and claims tests here use lib/claims/pattern.ts: a unit that
 * widens that list should run this file.
 */
const ROOT = process.cwd();
const LOCK = join(ROOT, 'notebooks', 'requirements.txt');
const PINS = join(ROOT, 'notebooks', 'requirements.in');
/** The running content version, read from the index (RE-3): no version is written in this file. */
const RUNNING = (JSON.parse(readFileSync(join(ROOT, 'data', 'content', 'index.json'), 'utf8')) as { running: string }).running;

/** Normalise a PyPI name the way pip does, so `scikit_learn` equals `scikit-learn`. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

describe('locked notebook environment', () => {
  it('FR-SUG-07: the lock is universal, so a team on Windows or macOS can install it', () => {
    const lock = readFileSync(LOCK, 'utf8');
    expect(lock, 'the lock carries a win32-marked package, so it was compiled --universal').toMatch(/^colorama==\S+ ; .*sys_platform == 'win32'/m);
    expect(lock, 'the header does not say --universal').toContain('--universal');
  });

  it('FR-SUG-07: every requirement is pinned with == and a sha256 hash', () => {
    expect(existsSync(LOCK), 'notebooks/requirements.txt is missing').toBe(true);
    expect(existsSync(PINS), 'notebooks/requirements.in is missing').toBe(true);

    const lines = readFileSync(LOCK, 'utf8').split('\n');
    const packages = new Map<string, { version: string; hashes: number }>();
    let current: string | null = null;

    for (const raw of lines) {
      if (raw.trim() === '' || /^\s*#/.test(raw)) continue;
      const hash = /^\s+--hash=sha256:([0-9a-f]{64})(?: \\)?$/.exec(raw);
      if (hash) {
        expect(current, `hash line before any package: ${raw}`).not.toBeNull();
        packages.get(current as string)!.hashes += 1;
        continue;
      }
      // A universal lock may carry an environment marker: `name==version ; sys_platform == 'win32' \`.
      const pin = /^([A-Za-z0-9._-]+)==([^\s;]+)(?: ; [^\\]+?)? \\$/.exec(raw);
      expect(pin, `line is neither "name==version [; marker] \\" nor a sha256 hash: ${raw}`).not.toBeNull();
      current = normaliseName(pin![1]);
      // The same package may appear again for another marker; its hashes add up, its version must agree.
      const seen = packages.get(current);
      if (seen) expect(seen.version, `${current} is locked at two versions`).toBe(pin![2]);
      else packages.set(current, { version: pin![2], hashes: 0 });
    }

    expect(packages.size).toBeGreaterThan(0);
    for (const [name, p] of packages) {
      expect(p.hashes, `${name}==${p.version} has no sha256 hash`).toBeGreaterThan(0);
    }

    // Every direct pin in requirements.in is in the lock at the same version.
    const direct = readFileSync(PINS, 'utf8')
      .split('\n')
      .map((l) => l.replace(/#.*/, '').trim())
      .filter((l) => l !== '');
    expect(direct.length).toBeGreaterThan(0);
    for (const line of direct) {
      const m = /^([A-Za-z0-9._-]+)==([^\s]+)$/.exec(line);
      expect(m, `requirements.in line is not name==version: ${line}`).not.toBeNull();
      const locked = packages.get(normaliseName(m![1]));
      expect(locked, `${m![1]} is in requirements.in but not in the lock`).toBeDefined();
      expect(locked!.version).toBe(m![2]);
    }
  });
});

// ---------------------------------------------------------------------------
// The ten notebooks (SRS 10.5.2). One entry per control; a missing file fails
// its tests by name, so a half-written unit cannot pass.
// ---------------------------------------------------------------------------

const TECHNICAL = join(ROOT, 'notebooks', 'technical');

const FILES = {
  'C-03': 'C-03_data-quality-audit.ipynb',
  'C-04': 'C-04_bias-detection.ipynb',
  'C-05': 'C-05_data-distribution.ipynb',
  'C-10': 'C-10_privacy-anonymization.ipynb',
  'C-13': 'C-13_subgroup-fairness.ipynb',
  'C-14': 'C-14_disaggregated-performance.ipynb',
  'C-15': 'C-15_bias-mitigation.ipynb',
  'C-16': 'C-16_stratified-evaluation.ipynb',
  'C-18': 'C-18_explainability-analysis.ipynb',
  'C-21': 'C-21_monitoring-drift.ipynb',
} as const;
type Control = keyof typeof FILES;
const CONTROLS = Object.keys(FILES) as Control[];

/** Closed tag set of the skeleton (SRS lines 4623-4633) plus `optional` (cells CI skips). */
const SKELETON = [
  'title',
  'linked-content',
  'when-to-use',
  'setup',
  'load-data',
  'adapt-here',
  'method',
  'stop-and-decide',
  'evidence-summary',
  'not-shown',
] as const;
type Tag = (typeof SKELETON)[number];

interface Cell {
  id?: string;
  cell_type: 'markdown' | 'code' | 'raw';
  metadata: { tags?: string[]; widgets?: unknown; [k: string]: unknown };
  source: string[] | string;
  outputs?: unknown[];
  execution_count?: number | null;
}
interface Notebook {
  nbformat: number;
  metadata: { widgets?: unknown; [k: string]: unknown };
  cells: Cell[];
}

function readNotebook(c: Control): Notebook {
  const path = join(TECHNICAL, FILES[c]);
  expect(existsSync(path), `notebooks/technical/${FILES[c]} is missing`).toBe(true);
  return JSON.parse(readFileSync(path, 'utf8')) as Notebook;
}
const text = (cell: Cell): string => (Array.isArray(cell.source) ? cell.source.join('') : cell.source);
const tagsOf = (cell: Cell): string[] => cell.metadata.tags ?? [];
const isOptional = (cell: Cell): boolean => tagsOf(cell).includes('optional');
const primaryTag = (cell: Cell): string | undefined => tagsOf(cell).find((t) => t !== 'optional');
const codeCells = (nb: Notebook): Cell[] => nb.cells.filter((x) => x.cell_type === 'code');
/** Code cells CI runs: everything not tagged optional. */
const runCode = (nb: Notebook): Cell[] => codeCells(nb).filter((x) => !isOptional(x));
const cellsTagged = (nb: Notebook, tag: Tag): Cell[] => nb.cells.filter((x) => primaryTag(x) === tag);

/** A line of Python without its `#` comment: the `#` counts only outside a quoted string. */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '#') return line.slice(0, k);
  }
  return line;
}

/** Python string literals of one source text ('...' or "...", one line each), comments left out. */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9_])(?:[rbfRBF]{0,2})('([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*")/g;
  const code = src.split('\n').map(withoutComment).join('\n');
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1].slice(1, -1));
  return out;
}

describe('NB-AC-01: sources carry no outputs, execution counts or widget state', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata.widgets, 'notebook metadata.widgets').toBeUndefined();
    // Nothing else rides along: no local path, user name, timestamp or attachment (N3, SO-4).
    expect(Object.keys(nb.metadata).filter((k) => !['kernelspec', 'language_info'].includes(k)), 'notebook metadata keys').toEqual([]);
    for (const [i, cell] of nb.cells.entries()) {
      expect(Object.keys(cell.metadata).filter((k) => k !== 'tags'), `cell ${i} metadata keys`).toEqual([]);
      expect((cell as Cell & { attachments?: unknown }).attachments, `cell ${i} attachments`).toBeUndefined();
      expect(cell.metadata.widgets, `cell ${i} metadata.widgets`).toBeUndefined();
      if (cell.cell_type === 'code') {
        expect(cell.outputs, `cell ${i} outputs`).toEqual([]);
        expect(cell.execution_count, `cell ${i} execution_count`).toBeNull();
      }
    }
    expect(JSON.stringify(nb)).not.toMatch(/application\/vnd\.jupyter\.widget/);
  });
});

describe('NB-AC-01: the cells follow the ten-part skeleton in order', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const order = (t: string): number => (t === 'stop-and-decide' ? SKELETON.indexOf('method') : SKELETON.indexOf(t as Tag));
    let last = -1;
    const seen = new Map<string, number>();
    for (const [i, cell] of nb.cells.entries()) {
      const tags = tagsOf(cell);
      const primary = tags.filter((t) => t !== 'optional');
      expect(primary.length, `cell ${i} must carry exactly one skeleton tag, has [${tags}]`).toBe(1);
      expect(SKELETON as readonly string[], `cell ${i} tag ${primary[0]}`).toContain(primary[0]);
      expect(order(primary[0]), `cell ${i} (${primary[0]}) is out of skeleton order`).toBeGreaterThanOrEqual(last);
      last = order(primary[0]);
      seen.set(primary[0], (seen.get(primary[0]) ?? 0) + 1);
    }
    for (const t of ['title', 'linked-content', 'when-to-use', 'setup', 'adapt-here', 'evidence-summary', 'not-shown'] as const) {
      expect(seen.get(t), `exactly one cell tagged ${t}`).toBe(1);
    }
    for (const t of ['load-data', 'method', 'stop-and-decide'] as const) {
      expect(seen.get(t) ?? 0, `at least one cell tagged ${t}`).toBeGreaterThan(0);
    }
    // Cell types the skeleton fixes: prose cells are markdown, working cells are code.
    for (const t of ['title', 'linked-content', 'when-to-use', 'not-shown'] as const) {
      expect(cellsTagged(nb, t)[0].cell_type, `${t} is a markdown cell`).toBe('markdown');
    }
    for (const t of ['setup', 'load-data', 'adapt-here', 'evidence-summary'] as const) {
      for (const cell of cellsTagged(nb, t)) expect(cell.cell_type, `${t} is a code cell`).toBe('code');
    }
  });
});

describe('NB-AC-05: one adapt-here cell, and no later cell repeats a column name from it', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const adapt = nb.cells.map((x, i) => ({ x, i })).filter(({ x }) => tagsOf(x).includes('adapt-here'));
    expect(adapt.length, 'exactly one adapt-here cell').toBe(1);
    expect(adapt[0].x.cell_type).toBe('code');
    // String literals of the adapt-here cell are the column and group names.
    const names = [...new Set(stringLiterals(text(adapt[0].x)))].filter((s) => s.length >= 2 && /[A-Za-z0-9]/.test(s));
    expect(names.length, 'the adapt-here cell holds at least one column or group name').toBeGreaterThan(0);
    for (const { x, i } of nb.cells.map((x, i) => ({ x, i })).filter(({ i }) => i > adapt[0].i)) {
      if (x.cell_type !== 'code') continue;
      const later = new Set(stringLiterals(text(x)));
      for (const n of names) {
        expect(later.has(n), `cell ${i} quotes "${n}", which the adapt-here cell already holds`).toBe(false);
      }
    }
  });
});

/** What the title cell must credit: dataset name, licence and DOI or revision, or 'synthetic' (NB-AC-07). */
const ATTRIBUTION: Record<Control, string[][]> = {
  'C-03': [['Diabetes 130-US Hospitals', 'CC BY 4.0', '10.24432/C5230J'], ['World Bank', 'CC BY 4.0']],
  'C-04': [['UCI Adult', 'CC BY 4.0', '10.24432/C5XW20'], ['synthetic']],
  'C-05': [['Statlog (German Credit Data)', 'CC BY 4.0', '10.24432/C5NC77']],
  'C-10': [['UCI Adult', 'CC BY 4.0', '10.24432/C5XW20'], ['synthetic']],
  'C-13': [['UCI Adult', 'CC BY 4.0', '10.24432/C5XW20']],
  'C-14': [['Diabetes 130-US Hospitals', 'CC BY 4.0', '10.24432/C5230J']],
  'C-15': [['UCI Adult', 'CC BY 4.0', '10.24432/C5XW20']],
  'C-16': [['MasakhaNEWS', 'afl-3.0', 'fa3b5ff']],
  'C-18': [['Statlog (German Credit Data)', 'CC BY 4.0', '10.24432/C5NC77']],
  'C-21': [['Bike Sharing', 'CC BY 4.0', '10.24432/C5W894']],
};

describe('NB-AC-07: licence header and dataset attribution in the title cell', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const title = cellsTagged(nb, 'title');
    expect(title.length, 'exactly one title cell').toBe(1);
    const body = text(title[0]);
    expect(body, 'licence of the notebook').toContain('Apache-2.0');
    expect(body, 'control id').toContain(c);
    for (const group of ATTRIBUTION[c]) {
      for (const needle of group) expect(body, `title cell must contain "${needle}"`).toContain(needle);
    }
  });
});

/** Python standard library top-level modules a notebook may import (written out, NB-AC-08). */
const STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'ast', 'base64', 'bisect', 'collections', 'contextlib', 'copy', 'csv',
  'dataclasses', 'datetime', 'decimal', 'difflib', 'enum', 'fractions', 'functools', 'gzip', 'hashlib',
  'heapq', 'hmac', 'importlib', 'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'operator',
  'os', 'pathlib', 'platform', 'pprint', 'random', 're', 'resource', 'secrets', 'shutil', 'statistics',
  'string', 'sys', 'tempfile', 'textwrap', 'time', 'typing', 'unicodedata', 'urllib', 'warnings',
  'zipfile', 'zlib',
]);
/** Import name -> distribution name, where they differ (the rest are the same name). */
const MODULE_TO_DIST: Record<string, string> = {
  sklearn: 'scikit-learn',
  PIL: 'pillow',
  yaml: 'pyyaml',
  dateutil: 'python-dateutil',
  mpl_toolkits: 'matplotlib',
  IPython: 'ipython',
};

function importedModules(src: string): string[] {
  const mods: string[] = [];
  for (const line of src.split('\n')) {
    const from = /^\s*from\s+([A-Za-z_][\w]*)(?:\.[\w.]*)?\s+import\s/.exec(line);
    if (from) {
      mods.push(from[1]);
      continue;
    }
    const imp = /^\s*import\s+(.+)$/.exec(line);
    if (imp) {
      for (const part of imp[1].split(',')) {
        const m = /^\s*([A-Za-z_][\w]*)/.exec(part);
        if (m) mods.push(m[1]);
      }
    }
  }
  return mods;
}

function lockedDistributions(): Set<string> {
  expect(existsSync(LOCK), 'notebooks/requirements.txt is missing, so NB-AC-08 cannot be checked').toBe(true);
  const names = new Set<string>();
  for (const line of readFileSync(LOCK, 'utf8').split('\n')) {
    const m = /^([A-Za-z0-9._-]+)==/.exec(line);
    if (m) names.add(normaliseName(m[1]));
  }
  return names;
}

describe('NB-AC-08: no import outside requirements.txt and the standard library, except in optional cells', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const locked = lockedDistributions();
    for (const cell of runCode(nb)) {
      for (const mod of importedModules(text(cell))) {
        if (STDLIB.has(mod)) continue;
        const dist = normaliseName(MODULE_TO_DIST[mod] ?? mod);
        expect(locked.has(dist), `import ${mod} (distribution ${dist}) is not in notebooks/requirements.txt`).toBe(true);
      }
    }
    // An install inside a cell is an import outside the lock, whatever it is called.
    for (const [i, cell] of codeCells(nb).entries()) {
      expect(text(cell), `code cell ${i}`).not.toMatch(/^\s*(%pip|%conda|!\s*pip|!\s*conda|!\s*apt|%%bash|%%sh)\b/m);
    }
  });
});

/** Constructs a notebook must not use on a file it downloaded or on any text (N2, N3). */
const UNSAFE = /\b(pickle|read_pickle|joblib\.load|eval|exec|os\.system|subprocess|__import__)\s*[(.]/;

describe('NB-AC-03: every dataset fetch is https with a sha256 check, or seeded synthetic', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const loads = cellsTagged(nb, 'load-data').filter((x) => !isOptional(x));
    expect(loads.length).toBeGreaterThan(0);
    const body = loads.map(text).join('\n');
    const urls = body.match(/['"]https?:\/\/[^'"\s]+['"]/g) ?? [];
    const fixedHashes = body.match(/['"][0-9a-f]{64}['"]/g) ?? [];
    if (urls.length > 0) {
      for (const u of urls) expect(u, 'dataset address must be https').toMatch(/^['"]https:\/\//);
      expect(fixedHashes.length, 'one 64-hex SHA-256 per dataset address').toBeGreaterThanOrEqual(urls.length);
      expect(body, 'DATA_URL constant').toMatch(/DATA_URL\w*\s*=|_URL\s*=|URL\s*=/);
      expect(body, 'DATA_SHA256 constant').toMatch(/SHA256\w*\s*=/);
      expect(body, 'hash computed before use').toMatch(/hashlib\.sha256\(/);
      expect(body, 'a hash mismatch stops the notebook').toMatch(/!=[^\n]*:\s*\n\s*raise\s+\w*Error/);
      expect(body, 'cache folder').toContain("'.cache' / 'makrai-notebooks'");
      // The bytes the notebook uses are the checked bytes (SF-7): they come from fetch_checked, and only it opens a connection.
      expect(body, 'the data is read from fetch_checked').toMatch(/=\s*fetch_checked\(/);
      const outside = body.replace(/def fetch_checked[\s\S]*?\n {4}return data\n/, '');
      expect(outside, 'a connection opened outside fetch_checked').not.toMatch(/urlopen\(/);
      expect(outside, 'a file read straight from an address').not.toMatch(/read_(csv|table|excel|json)\(\s*(\w*URL\w*|f?['"]https?:)/);
      // The cache file name is fixed in the notebook, never taken from the address.
      expect(body).not.toMatch(/urlparse|\.split\(\s*['"]\/['"]\s*\)\s*\[\s*-1\s*\]|basename\(\s*url/i);
    } else {
      expect(body, 'a table without a fetch must say it is synthetic').toMatch(/SYNTHETIC\s*=\s*True/);
      expect(body, 'seeded generator').toMatch(/default_rng\(|RandomState\(|random\.seed\(/);
    }
    for (const [i, cell] of codeCells(nb).entries()) {
      expect(text(cell), `code cell ${i} uses an unsafe construct`).not.toMatch(UNSAFE);
      if (!isOptional(cell)) expect(text(cell), `code cell ${i} fetches over http`).not.toMatch(/['"]http:\/\//);
    }
  });
});

/** Lines where a dataset hash is assigned; a hash is not a key (N5). The only lines the key scan skips. */
const DATASET_HASH_LINE = /^\s*DATA_SHA256\w*\s*=/;

/** Hex or base64 literals of 32 or more characters in the code, outside the dataset-hash assignments. */
function keyLiterals(code: string): string[] {
  const found: string[] = [];
  for (const line of code.split('\n')) {
    if (DATASET_HASH_LINE.test(line)) continue;
    for (const lit of stringLiterals(line)) {
      if (/^[0-9a-fA-F]{32,}$/.test(lit) || /^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(lit)) found.push(lit);
    }
  }
  return found;
}

/** The text of the first argument of the call that opens at `open` (the index just after the bracket), or null if it never closes. */
function firstArgument(src: string, open: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let k = open; k < src.length; k++) {
    const ch = src[k];
    if (quote) {
      if (ch === '\\') k++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return src.slice(open, k).trim();
      depth--;
    } else if (ch === ',' && depth === 0) return src.slice(open, k).trim();
  }
  return null;
}

/** The key calls: hmac.new(, hmac.digest( and hmac.HMAC(. */
const KEY_CALLS = /\bhmac\s*\.\s*(new|digest|HMAC)\s*\(/g;

/**
 * What is wrong with how the code makes and uses its key: one key made with secrets.token_bytes(32) and never
 * assigned again, and every key call (hmac.new, hmac.digest, hmac.HMAC) given exactly that variable as its first
 * argument, read with brackets and quotes. A call whose argument cannot be read is a problem, not a skip.
 */
function keyUseProblems(code: string): string[] {
  const problems: string[] = [];
  const made = [...code.matchAll(/^\s*(\w+)\s*=\s*secrets\.token_bytes\(\s*32\s*\)/gm)].map((m) => m[1]);
  if (made.length !== 1) problems.push(`expected one key made with secrets.token_bytes(32), found ${made.length}`);
  if (made.length === 1) {
    const assigned = [...code.matchAll(new RegExp(`^\\s*${made[0]}\\s*(?::[^=\\n]*)?(?:[-+*|&^%@]|//|<<|>>)?=(?!=)`, 'gm'))].length;
    if (assigned !== 1) problems.push(`the key variable ${made[0]} is assigned ${assigned} times; it must be assigned once, from secrets.token_bytes(32)`);
  }
  const calls = [...code.matchAll(KEY_CALLS)];
  const readable = calls.map((m) => firstArgument(code, (m.index as number) + m[0].length));
  if (!calls.some((m) => m[1] === 'new')) problems.push('no hmac.new( call found');
  calls.forEach((m, i) => {
    const first = readable[i];
    if (first === null) problems.push(`hmac.${m[1]}( has an argument list that cannot be read`);
    else if (made.length !== 1 || first !== made[0]) problems.push(`hmac.${m[1]}( is given \`${first}\`, not the key made at run time`);
  });
  return problems;
}

/** Names the evidence summary must not mention: the key variable and anything that makes bytes at random. */
function summaryNamesTheKey(code: string, summary: string): boolean {
  const made = [...code.matchAll(/^\s*(\w+)\s*=\s*secrets\.token_bytes\(\s*32\s*\)/gm)].map((m) => m[1]);
  return made.some((name) => new RegExp(`\\b${name}\\b`).test(summary)) || /token_bytes|PSEUDONYM_KEY/.test(summary);
}

describe('NB-AC-04 C-10: no literal key, the key never reaches the summary', () => {
  const nb = readNotebook('C-10');
  const code = runCode(nb).map(text).join('\n');
  const summary = cellsTagged(nb, 'evidence-summary').map(text).join('\n');

  it('C-10', () => {
    expect(keyUseProblems(code), 'key made at run time and used in every hmac.new(').toEqual([]);
    expect(keyLiterals(code), 'a literal of 32 or more hex or base64 characters would be a key written into the file').toEqual([]);
    expect(summaryNamesTheKey(code, summary), 'the summary cell must not name the key variable').toBe(false);
  });

  it('C-10: the checks catch a key planted on the hmac line, a swapped argument and a key variable in the summary; a renamed alias in the summary is a known limit', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const hmacLine = code.split('\n').find((l) => l.includes('hmac.new('));
    expect(hmacLine, 'the notebook has an hmac.new( line').toBeDefined();
    const planted = code.replace(hmacLine as string, (hmacLine as string).replace(/hmac\.new\(\s*\w+/, `hmac.new(bytes.fromhex('${hex}')`));
    expect(keyLiterals(planted), 'hard-coded key on the hmac line').toContain(hex);
    expect(keyUseProblems(planted).length, 'hmac.new( not given the run-time key').toBeGreaterThan(0);
    const swapped = code.replace(/hmac\.new\(\s*\w+/, 'hmac.new(OTHER_KEY');
    expect(keyUseProblems(swapped).length).toBeGreaterThan(0);
    const alias = `${code}\nKEY_ALIAS = ${(code.match(/^\s*(\w+)\s*=\s*secrets\.token_bytes/m) as RegExpMatchArray)[1]}`;
    expect(summaryNamesTheKey(alias, 'the key is {KEY_ALIAS}'), 'an alias is not caught by name alone').toBe(false);
    const keyName = (code.match(/^\s*(\w+)\s*=\s*secrets\.token_bytes/m) as RegExpMatchArray)[1];
    expect(summaryNamesTheKey(code, `print(${keyName}.hex())`), 'the key variable in the summary').toBe(true);
    expect(keyLiterals(`DATA_SHA256 = '${hex}'`), 'a dataset hash assignment is not a key').toEqual([]);
    expect(keyLiterals(`DATA_SHA256 = {('lug', 'train'): '${hex}'}`).length, 'only an assignment line of its own is skipped').toBe(0);
  });

  it('C-10: the key check also catches a second call, a second assignment, a key built from a hash name, hmac.digest and hmac.HMAC', () => {
    const keyName = (code.match(/^\s*(\w+)\s*=\s*secrets\.token_bytes/m) as RegExpMatchArray)[1];
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const probes: Record<string, string> = {
      'a second hmac.new( whose first argument holds a bracket': `${code}\nweak = hmac.new(bytes(32), b'x', hashlib.sha256)`,
      'a second assignment to the key variable': `${code}\n${keyName} = b'this is my fixed key, see it here'`,
      'a key built from a name that starts with DATA_SHA256': `${code}\nDATA_SHA256_K = '${hex}'\n${keyName} = bytes.fromhex(DATA_SHA256_K)`,
      'hmac.digest with another key': `${code}\nd = hmac.digest(b'weak', b'x', 'sha256')`,
      'hmac.HMAC with another key': `${code}\nh = hmac.HMAC(OTHER, b'x', 'sha256')`,
      'a call the parser cannot close': `${code}\nbroken = hmac.new((bytes(32), b'x'`,
    };
    for (const [what, planted] of Object.entries(probes)) {
      expect(keyUseProblems(planted).length, what).toBeGreaterThan(0);
    }
    expect(keyUseProblems(code), 'the real notebook is clean').toEqual([]);
  });
});

/** Every `print(...)` call in a source, each up to its matching bracket. */
function printCalls(src: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf('print(', from);
    if (at === -1) return calls;
    let depth = 0;
    let quote: string | null = null;
    let end = at + 5;
    for (let k = at + 5; k < src.length; k++) {
      const ch = src[k];
      if (quote) {
        if (ch === '\\') k++;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) {
        end = k;
        break;
      }
    }
    calls.push(src.slice(at, end + 1));
    from = end + 1;
  }
}

describe('C-10: the never-upload warning is printed', () => {
  it('C-10', () => {
    const nb = readNotebook('C-10');
    const calls = runCode(nb).flatMap((x) => printCalls(text(x)));
    expect(
      calls.some((p) => /never upload/i.test(p) && /platform/i.test(p)),
      'a print call whose text says never upload and names the platform',
    ).toBe(true);
  });
});

describe('D8: each evidence-summary cell writes one ZIP outside evidence/ and tells the reader to attach it', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const cell = cellsTagged(nb, 'evidence-summary')[0];
    const body = text(cell);
    // The ZIP holds only the files this cell wrote: an explicit list of names, no glob over the folder.
    expect(body, `${c}: no shutil.make_archive (it archives the whole folder)`).not.toContain('make_archive');
    expect(body, `${c}: no glob( (a person's own file with this prefix would be zipped)`).not.toContain('glob(');
    // One archive call, built under a .part name that is removed first and created exclusively, then moved into place
    // only once complete (so an error while it is built leaves no ZIP under the final name).
    expect(body.split('zipfile.ZipFile(').length - 1, `${c}: exactly one zipfile.ZipFile( call`).toBe(1);
    const zipAt = body.indexOf(`zipfile.ZipFile('${c}_evidence.zip.part', 'x', zipfile.ZIP_DEFLATED)`);
    expect(zipAt, `${c}: the cell opens '${c}_evidence.zip.part' with mode 'x' (exclusive creation)`).toBeGreaterThan(-1);
    const removeAt = body.indexOf(`Path('${c}_evidence.zip').unlink(missing_ok=True)`);
    expect(removeAt, `${c}: an earlier ZIP is removed first`).toBeGreaterThan(-1);
    const removePartAt = body.indexOf(`Path('${c}_evidence.zip.part').unlink(missing_ok=True)`);
    expect(removePartAt, `${c}: an existing .part (a file or a link) is removed first`).toBeGreaterThan(-1);
    expect(removeAt, `${c}: the ZIP is removed before the .part`).toBeLessThan(removePartAt);
    expect(removePartAt, `${c}: the .part is removed before it is created`).toBeLessThan(zipAt);
    const moveAt = body.indexOf(`os.replace('${c}_evidence.zip.part', '${c}_evidence.zip')`);
    expect(moveAt, `${c}: os.replace moves the .part file onto ${c}_evidence.zip`).toBeGreaterThan(-1);
    expect(moveAt, `${c}: the move comes after the archive block`).toBeGreaterThan(body.indexOf('archive.write(path, name)'));
    nb.cells.forEach((x, i) => {
      if (x !== cell) expect(text(x), `${c}: cell ${i} mentions zipfile`).not.toContain('zipfile');
    });
    // The list in the archive step equals, name for name, the set the cell writes into EVIDENCE_DIR (quoted literals).
    const listed = /for name in \[([^\]]*)\]:/.exec(body);
    expect(listed, `${c}: the archive step loops over a literal list of names`).not.toBeNull();
    const names = [...listed![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const written = [...body.matchAll(/EVIDENCE_DIR \/ '([^']+)'/g)].map((m) => m[1]);
    expect(written.length, `${c}: the cell writes files into EVIDENCE_DIR`).toBeGreaterThan(0);
    expect(new Set(written).size, `${c}: no name is written twice`).toBe(written.length);
    expect(names.filter((n) => !written.includes(n)), `${c}: listed but not written`).toEqual([]);
    expect(written.filter((n) => !names.includes(n)), `${c}: written but not listed`).toEqual([]);
    expect(names, `${c}: the list is in sorted order, without repeats`).toEqual([...new Set(names)].sort());
    for (const name of written) expect(name.startsWith(`${c}_`), `${c}: ${name} must start with ${c}_`).toBe(true);
    // Each listed file is checked when archived, and added under its bare name.
    expect(body, `${c}: a listed file must be a regular file and not a link`).toContain('if not path.is_file() or path.is_symlink():');
    expect(body, `${c}: a missing or linked file raises`).toContain('raise RuntimeError(');
    expect(body, `${c}: the error says what to do`).toContain(
      "is missing or is a link, so no ZIP was made. Run this notebook again from the top; if the file is a link, delete it first.')",
    );
    expect(body, `${c}: members are added under their bare file names`).toContain('archive.write(path, name)');
    // Written after the summary, so the ZIP holds the summary (a ZIP made first would leave it out).
    const summaryWritten = body.indexOf(`'${c}_summary.md').write_text(`);
    expect(summaryWritten, `${c}: the cell writes the summary file`).toBeGreaterThan(-1);
    expect(zipAt, `${c}: the archive is written after the summary`).toBeGreaterThan(summaryWritten);
    // The ZIP sits beside evidence/, not inside it: the checker allows only .md, .csv and .png in the folder.
    expect(body, `${c}: the summary tells the reader which file to attach`).toContain(`\`${c}_evidence.zip\``);
    expect(
      nb.cells.some((x) => /^\s*import\s+(?:[\w.]+\s*,\s*)*zipfile\b/m.test(text(x))),
      `${c}: zipfile is imported`,
    ).toBe(true);
    expect(
      nb.cells.some((x) => /^\s*import\s+(?:[\w.]+\s*,\s*)*os\b/m.test(text(x))),
      `${c}: os is imported (the archive step calls os.replace)`,
    ).toBe(true);
    for (const old of ['CSV and PNG files beside it', 'CSV files beside it', 'plan files beside it']) {
      for (const [i, x] of nb.cells.entries()) expect(text(x), `${c}: cell ${i} still says "${old}"`).not.toContain(old);
    }
  });

  it('C-10: the never-upload warning names the ZIP, not the summary', () => {
    const calls = runCode(readNotebook('C-10')).flatMap((x) => printCalls(text(x)));
    const warning = calls.find((p) => /never upload/i.test(p) && /\battach\b/i.test(p));
    expect(warning, 'a never-upload print call that says what to attach').toBeDefined();
    expect(warning).toContain('C-10_evidence.zip');
    expect(warning).not.toMatch(/Attach this summary only/);
  });
});

describe('NB-AC-09 (floor): each notebook uses the methods SRS 10.5.2 names', () => {
  const NAMES: Record<Control, string[]> = {
    'C-03': ['chisquare'],
    'C-04': ['chi2_contingency', 'mutual_info_classif', 'cohen_kappa_score', 'fleiss_kappa'],
    'C-05': ['crosstab'],
    'C-10': ['hmac', 'k_anonymity', 'l_diversity'],
    'C-13': ['MetricFrame', 'demographic_parity_difference', 'equalized_odds_difference', 'calibration_curve'],
    'C-14': ['MetricFrame', 'resample'],
    'C-15': ['CorrelationRemover', 'ExponentiatedGradient', 'ThresholdOptimizer', 'plot_model_comparison'],
    'C-16': ['TfidfVectorizer', 'StratifiedKFold', 'MetricFrame'],
    'C-18': ['permutation_importance', 'TreeExplainer', 'waterfall', 'PartialDependenceDisplay'],
    'C-21': ['ks_2samp'],
  };
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const code = runCode(nb).map(text).join('\n');
    for (const name of NAMES[c]) {
      expect(code, `${c} must call ${name} in a cell CI runs`).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});

// ---------------------------------------------------------------------------
// NB-AC-06 (CG-16): the linked areas and questions come from the content files
// ---------------------------------------------------------------------------

const readJson = <T>(...parts: string[]): T => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8')) as T;

describe('NB-AC-06: the linked content', () => {
  it('NB-AC-06: linkedContentMarkdown reproduces the 10.5.2 index on the v0.5.0 mapping', () => {
    // The fixture bundle copies v0.5.0's mapping. The ids are those of the SRS 10.5.2 index table (lines 4656-4669).
    const dir = ['__tests__', 'fixtures', 'content', '0.0.1-fixture'];
    const bank = readJson<QuestionBankFile>(...dir, 'questionBank.json');
    const areas = readJson<AreasFile>(...dir, 'assessmentAreas.json');
    const expected: Record<string, { areas: string[]; questions: string[] }> = {
      'C-13': {
        areas: ['IP-01', 'IP-02', 'IP-04', 'IP-05'],
        questions: ['Q-PP-23', 'Q-IP-01', 'Q-IP-02', 'Q-IP-03', 'Q-IP-04', 'Q-IP-05', 'Q-IP-06', 'Q-IP-08', 'Q-IP-16', 'Q-IP-17', 'Q-IP-18', 'Q-IP-13', 'Q-IP-14', 'Q-IP-15', 'Q-IP-19', 'Q-IP-22', 'Q-IP-24', 'Q-IP-EXTRA-01'],
      },
      'C-21': {
        areas: ['PO-01', 'PO-02', 'PO-03'],
        questions: ['Q-PP-20', 'Q-PP-21', 'Q-IP-24', 'Q-PO-01', 'Q-PO-02', 'Q-PO-03', 'Q-PO-04', 'Q-PO-05', 'Q-PO-16', 'Q-PO-17', 'Q-PO-18', 'Q-PO-11', 'Q-PO-12', 'Q-PO-14', 'Q-PO-21', 'Q-PO-22', 'Q-PO-23', 'Q-PO-EXTRA-01', 'Q-PO-EXTRA-02', 'Q-PO-EXTRA-03', 'Q-PO-EXTRA-04'],
      },
    };
    for (const [control, want] of Object.entries(expected)) {
      const md = linkedContentMarkdown(control, bank, areas);
      expect(md, `${control}: the generated line`).toContain('Generated from content 0.0.1-fixture. Do not edit by hand.');
      const areaLines = md.split('\n').filter((l) => /^- [A-Z]{2}-\d{2}: /.test(l));
      expect(areaLines.map((l) => l.slice(2, 7)), `${control}: areas`).toEqual(want.areas);
      for (const id of want.areas) {
        const name = areas.areas.find((a) => a.id === id)!.name;
        expect(areaLines.find((l) => l.startsWith(`- ${id}: `)), `${control}: name of ${id}`).toBe(`- ${id}: ${name}`);
      }
      const qLine = md.split('\n').find((l) => l.startsWith('Questions: '));
      expect(qLine, `${control}: the questions line`).toBe(`Questions: ${want.questions.length}: ${want.questions.join(', ')}`);
    }
  });

  it('NB-AC-06: a control no area lists gets no invented content', () => {
    const dir = ['__tests__', 'fixtures', 'content', '0.0.1-fixture'];
    const bank = readJson<QuestionBankFile>(...dir, 'questionBank.json');
    const areas = readJson<AreasFile>(...dir, 'assessmentAreas.json');
    const md = linkedContentMarkdown('C-99', bank, areas);
    expect(md).toContain('No risk area lists this control.');
    expect(md).not.toMatch(/^- [A-Z]{2}-\d{2}: /m);
    expect(md).toContain('Questions: 0');
  });

  it.each(CONTROLS)("NB-AC-06: each notebook's linked-content cell equals the generator's output for the running content, %s", (c) => {
    const dir = ['data', 'content', RUNNING];
    const bank = readJson<QuestionBankFile>(...dir, 'questionBank.json');
    const areas = readJson<AreasFile>(...dir, 'assessmentAreas.json');
    expect(areas.meta.version, 'the running version is the one the cells say they were generated from').toBe(RUNNING);
    const cells = cellsTagged(readNotebook(c), 'linked-content');
    expect(cells, `${c}: one linked-content cell`).toHaveLength(1);
    expect(text(cells[0])).toBe(linkedContentMarkdown(c, bank, areas));
  });
});

// ---------------------------------------------------------------------------
// No cell may name a question that is gone from the running content or that its control does not reach
// (coordinator ruling, 5 Nov 2026; every cell, fix round 1)
// ---------------------------------------------------------------------------

/** A question id: Q, a stage, then one or more parts (Q-IP-24, Q-IP-EXTRA-01, Q-PP-GATE-SENSITIVE). */
const QUESTION_ID = /\bQ-[A-Z]+(?:-[A-Z0-9]+)+\b/g;

describe('NB-AC-06: every question a cell names is real and linked', () => {
  const dir = ['data', 'content', RUNNING];
  const bank = readJson<QuestionBankFile>(...dir, 'questionBank.json');
  const areas = readJson<AreasFile>(...dir, 'assessmentAreas.json');
  const exists = new Set(Object.values(bank.stages).flatMap((st) => st.modules.flatMap((m) => m.questions.map((q) => q.id))));

  it('the id pattern matches every id of the running bank, whole', () => {
    for (const id of exists) expect([...id.matchAll(QUESTION_ID)].map((m) => m[0]), id).toEqual([id]);
  });

  /** Each id named, with the line that names it. An id outside the control's linked list needs "does not link" on its own line. */
  function problems(c: Control, cellText: string, where: string): string[] {
    const linked = new Set(linkedContentMarkdown(c, bank, areas).match(QUESTION_ID) ?? []);
    const out: string[] = [];
    for (const line of cellText.split('\n')) {
      for (const id of new Set(line.match(QUESTION_ID) ?? [])) {
        if (!exists.has(id)) out.push(`${where}: ${id} is not in content ${RUNNING}`);
        else if (!linked.has(id) && !/does not link/.test(line)) out.push(`${where}: ${id} is not linked to ${c}, and its line does not say "does not link"`);
      }
    }
    return out;
  }

  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    const found: string[] = [];
    for (const [i, cell] of nb.cells.entries()) {
      if (primaryTag(cell) === 'linked-content') continue; // generated from the same files
      found.push(...problems(c, text(cell), `${c} cell ${i} (${primaryTag(cell)})`));
    }
    expect(found).toEqual([]);
    const when = cellsTagged(nb, 'when-to-use');
    expect(when, `${c}: one when-to-use cell`).toHaveLength(1);
    expect(text(when[0]).match(QUESTION_ID)?.length ?? 0, `${c}: the when-to-use cell names at least one question`).toBeGreaterThan(0);
    expect(isClaim(text(when[0])), `${c}: the when-to-use cell makes a claim the platform may not make`).toBe(false);
  });

  it('a gone id, an unlinked id, and an unlinked id marked "does not link" are told apart', () => {
    const linkedC13 = [...(linkedContentMarkdown('C-13', bank, areas).match(QUESTION_ID) ?? [])];
    const unlinked = [...exists].find((id) => !linkedC13.includes(id)) as string;
    expect(problems('C-13', 'see Q-ZZ-99 here', 'x').join()).toContain('is not in content');
    expect(problems('C-13', `see ${unlinked} here`, 'x').join()).toContain('is not linked to C-13');
    expect(problems('C-13', `${unlinked}, which the framework does not link`, 'x')).toEqual([]);
    expect(problems('C-13', `${unlinked} here.\nThe framework does not link another.`, 'x').length, 'the phrase must be on the same line').toBe(1);
    expect(problems('C-13', `${linkedC13[0]} is fine`, 'x')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No claim in the words of the notebook (CC-3)
// ---------------------------------------------------------------------------

describe('NB-AC-09: no non-code cell makes a claim the platform may not make', () => {
  const areas = readJson<AreasFile>('data', 'content', RUNNING, 'assessmentAreas.json');
  /** Control and area names are the framework's own and are allowed as whole names (a name may hold a word like "Audit"). */
  const names = [...areas.areas.map((a) => a.name), ...areas.controls.map((k) => k.name)].sort((a, b) => b.length - a.length);
  /**
   * FR-PUB-01's core pattern, less its "score" alternatives. The platform shows no score of its own; these notebooks use
   * "score" for what a model outputs, which is not the platform's. Every other core alternative stays.
   */
  const CORE_SOURCE = CLAIMS_CORE.source;
  const WITHOUT_SCORE = new RegExp(CORE_SOURCE.replace('|\\bscores?\\b|\\bscored\\b', ''), 'i');

  it('the pattern kept every alternative except the score words', () => {
    expect(CORE_SOURCE).toContain('\\bscores?\\b|\\bscored\\b');
    expect(WITHOUT_SCORE.source).not.toContain('scores?');
    expect(WITHOUT_SCORE.test('this is audit-ready')).toBe(true);
    expect(WITHOUT_SCORE.test('fully compliant')).toBe(true);
    expect(WITHOUT_SCORE.test('a certified model')).toBe(true);
    expect(WITHOUT_SCORE.test('the model score')).toBe(false);
  });

  it.each(CONTROLS)('%s', (c) => {
    const hits: string[] = [];
    for (const [i, cell] of readNotebook(c).cells.entries()) {
      if (cell.cell_type === 'code') continue;
      let body = text(cell);
      for (const name of names) body = body.split(name).join(' ');
      for (const line of body.split('\n')) if (WITHOUT_SCORE.test(line)) hits.push(`cell ${i}: ${line.trim().slice(0, 80)}`);
    }
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The generator (SC-3, SF-10)
// ---------------------------------------------------------------------------

describe('the linked-content generator', () => {
  const copyRoot = (): string => {
    const tmp = mkdtempSync(join(tmpdir(), 'nb-linked-'));
    cpSync(join(ROOT, 'data', 'content'), join(tmp, 'data', 'content'), { recursive: true });
    cpSync(TECHNICAL, join(tmp, 'notebooks', 'technical'), { recursive: true });
    return tmp;
  };

  it('rewrites only the linked-content cell and writes every other byte back as it was', () => {
    const tmp = copyRoot();
    try {
      for (const c of CONTROLS) {
        const path = join(tmp, 'notebooks', 'technical', FILES[c]);
        const nb = JSON.parse(readFileSync(path, 'utf8')) as Notebook;
        for (const cell of nb.cells) if (primaryTag(cell) === 'linked-content') cell.source = ['stale text'];
        writeFileSync(path, `${JSON.stringify(nb, null, 1)}\n`);
      }
      writeLinkedContent(tmp);
      for (const c of CONTROLS) {
        expect(readFileSync(join(tmp, 'notebooks', 'technical', FILES[c]), 'utf8'), `${c} is byte-equal to the committed notebook`).toBe(
          readFileSync(join(TECHNICAL, FILES[c]), 'utf8'),
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('takes the running version from the index and refuses a version that is not in it', () => {
    const tmp = copyRoot();
    try {
      expect(() => writeLinkedContent(tmp, '../..')).toThrow(/not a content version/);
      expect(() => writeLinkedContent(tmp, '9.9.9')).toThrow(/not in data\/content\/index.json/);
      expect(() => writeLinkedContent(tmp, RUNNING)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Release (Task 17): the owner's pass is recorded, and only passed notebooks are served
// ---------------------------------------------------------------------------

describe('release of the reviewed notebooks', () => {
  const resources = readJson<ResourcesFile>('data', 'resources.json');
  const PUBLIC = join(ROOT, 'public', 'notebooks');
  const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
  const entryFor = (c: Control) => resources.notebooks.find((n) => n.controlId === c);
  /** What a review record says about the domain review (Task 16 Step 2). `reviewed` is false without that section. */
  function record(c: Control): { reviewed: boolean; reviewer?: string; qualifier?: string; date?: string; outcome?: string; sha?: string; body: string } {
    const whole = readFileSync(join(ROOT, 'docs', 'content', 'notebooks-review', `${c}.md`), 'utf8');
    const at = whole.lastIndexOf('## Domain review');
    const body = at === -1 ? '' : whole.slice(at);
    const line = /^- Reviewer: (.+)$/m.exec(body)?.[1];
    // The Reviewer line is the name, and may end in a note in brackets (C-10: as the privacy-competent reviewer, OD-03).
    const note = /\s*\(([^)]*)\)\s*$/.exec(line ?? '');
    return {
      reviewed: at !== -1,
      body,
      reviewer: line === undefined ? undefined : line.replace(/\s*\([^)]*\)\s*$/, ''),
      qualifier: note?.[1],
      date: /^- Date: (\d{4}-\d{2}-\d{2})$/m.exec(body)?.[1],
      outcome: /^- Outcome: (\w+)$/m.exec(body)?.[1],
      sha: /^- SHA-256: `([0-9a-f]{64})`/m.exec(body)?.[1],
    };
  }

  it('FR-SUG-04 FR-SUG-05: public/notebooks holds exactly the released notebooks, byte-equal to their sources', () => {
    const released = resources.notebooks.filter((n) => n.released);
    for (const c of CONTROLS) {
      const rec = record(c);
      const entry = entryFor(c);
      if (!rec.reviewed) {
        expect(entry, `${c}: no domain review, so no entry`).toBeUndefined();
        continue;
      }
      expect(rec.outcome, `${c}: the review record has a domain outcome`).toBeDefined();
      // A notebook is released only if its review passed. A passed one may be held back (a failed CI run on its hash).
      if (entry?.released) expect(rec.outcome, `${c}: released needs a passed review`).toBe('passed');
    }
    // Every entry carries the hash its review passed, released or not.
    for (const n of resources.notebooks) {
      expect(n.sha256, `${n.controlId}: the entry holds the hash the owner passed`).toBe(record(n.controlId as Control).sha);
    }
    const served = existsSync(PUBLIC) ? readdirSync(PUBLIC).filter((f) => f !== 'requirements.txt').sort() : [];
    expect(served, 'public/notebooks holds exactly the released copies').toEqual(released.map((n) => n.file.replace('/notebooks/', '')).sort());
    for (const n of released) {
      const c = n.controlId as Control;
      const name = FILES[c];
      expect(n.file, `${c}: URL path`).toBe(`/notebooks/${name}`);
      expect(n.requirementsFile).toBe('/notebooks/requirements.txt');
      const copy = readFileSync(join(PUBLIC, name));
      const source = readFileSync(join(TECHNICAL, name));
      expect(copy.equals(source), `${c}: the served copy is byte-equal to its source`).toBe(true);
      expect(n.bytes, `${c}: bytes`).toBe(source.length);
      expect(n.sha256, `${c}: sha256`).toBe(sha256(source));
    }
    if (released.length > 0) {
      expect(readFileSync(join(PUBLIC, 'requirements.txt')).equals(readFileSync(LOCK)), 'the served lock equals the lock').toBe(true);
    } else {
      expect(existsSync(join(PUBLIC, 'requirements.txt')), 'no lock is served while nothing is released').toBe(false);
    }
  });

  it('FR-SUG-04: no notebook file is served from anywhere in public/ but public/notebooks', () => {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.ipynb$/i.test(entry.name) && !path.startsWith(`${PUBLIC}/`)) found.push(path.slice(ROOT.length + 1));
      }
    };
    walk(join(ROOT, 'public'));
    expect(found, 'a notebook outside public/notebooks').toEqual([]);
  });

  it('NB-AC-10: a released notebook has outcome passed, and C-10\'s review is the privacy review', () => {
    for (const n of resources.notebooks) {
      const c = n.controlId as Control;
      expect(CONTROLS, `${c} is one of the ten`).toContain(c);
      if (n.released) expect(n.review.outcome, `${c}: released needs passed`).toBe('passed');
      expect(n.review.reviewer.trim().length, `${c}: a named reviewer`).toBeGreaterThan(0);
      expect(n.review.date, `${c}: a date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const rec = record(c);
      expect(rec.reviewed, `${c}: an entry needs a domain review record`).toBe(true);
      expect(n.review.reviewer, `${c}: the entry's reviewer is the record's Reviewer line without its note`).toBe(rec.reviewer);
      expect({ date: n.review.date, outcome: n.review.outcome }, `${c}: the entry matches its review record`).toEqual({ date: rec.date, outcome: rec.outcome });
    }
    // The privacy review of C-10 is stated on the Reviewer line itself, not anywhere in the record.
    expect(record('C-10').qualifier, 'the C-10 Reviewer line names the privacy-competent reviewer').toMatch(/privacy-competent reviewer/);
  });
});
