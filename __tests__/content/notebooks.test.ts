import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Checks on the ten technical notebooks (SRS 10.5) and their locked
 * environment. Every check reads files with `fs`; none starts a server or a
 * database (content unit, no slot). A test that reads `data/content/5.0.0`
 * names no question id literal (contract "Content bundle", gap G088).
 */
const ROOT = process.cwd();
const LOCK = join(ROOT, 'notebooks', 'requirements.txt');
const PINS = join(ROOT, 'notebooks', 'requirements.in');

/** Normalise a PyPI name the way pip does, so `scikit_learn` equals `scikit-learn`. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

describe('locked notebook environment', () => {
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
      const pin = /^([A-Za-z0-9._-]+)==([^\s]+) \\$/.exec(raw);
      expect(pin, `line is neither "name==version \\" nor a sha256 hash: ${raw}`).not.toBeNull();
      current = normaliseName(pin![1]);
      expect(packages.has(current), `${current} appears twice`).toBe(false);
      packages.set(current, { version: pin![2], hashes: 0 });
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

/** Python string literals of one source text ('...' or "...", one line each). */
function stringLiterals(src: string): string[] {
  const out: string[] = [];
  const re = /(?<![A-Za-z0-9_])(?:[rbfRBF]{0,2})('([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*")/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1].slice(1, -1));
  return out;
}

describe('NB-AC-01: sources carry no outputs, execution counts or widget state', () => {
  it.each(CONTROLS)('%s', (c) => {
    const nb = readNotebook(c);
    expect(nb.nbformat).toBe(4);
    expect(nb.metadata.widgets, 'notebook metadata.widgets').toBeUndefined();
    for (const [i, cell] of nb.cells.entries()) {
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
      expect(body, 'a mismatch stops the notebook').toMatch(/raise\s+\w*Error/);
      expect(body, 'cache folder').toContain("'.cache' / 'makrai-notebooks'");
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

describe('NB-AC-04 C-10: no literal key, the key never reaches the summary', () => {
  it('C-10', () => {
    const nb = readNotebook('C-10');
    const code = runCode(nb);
    const all = code.map(text).join('\n');
    expect(all, 'key made at run time').toMatch(/secrets\.token_bytes\(\s*32\s*\)/);
    // A literal of 32 or more hex or base64 characters would be a key written into the file;
    // a SHA-256 constant of a dataset (DATA_SHA256) is a hash, not a key.
    for (const cell of code) {
      for (const line of text(cell).split('\n')) {
        if (/SHA256/i.test(line)) continue;
        for (const lit of stringLiterals(line)) {
          expect(lit, `literal "${lit.slice(0, 12)}..." looks like a key`).not.toMatch(/^[0-9a-fA-F]{32,}$/);
          expect(lit, `literal "${lit.slice(0, 12)}..." looks like a key`).not.toMatch(/^[A-Za-z0-9+/_-]{32,}={0,2}$/);
        }
      }
    }
    const summary = cellsTagged(nb, 'evidence-summary').map(text).join('\n');
    expect(summary, 'the summary cell must not name the key variable').not.toMatch(/PSEUDONYM_KEY|token_bytes/);
  });
});

/** The calls that follow the first `print(` of a source, up to its matching bracket. */
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
