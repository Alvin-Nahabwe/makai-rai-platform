// The vocabulary generator (plan 1A, Task 7).
//
//   node scripts/vocabulary/generate.mjs <CONSOLIDATED.md> [--allow-missing-rules] [--out-dir <dir>]
//
// Reads section 2 of copy-audit/CONSOLIDATED.md (`## 2. The vocabulary` up to `### Terms the owner must decide`),
// merges scripts/vocabulary/overrides.json and scripts/vocabulary/lint-rules.json, and writes three files under the
// repository root (or under --out-dir): data/vocabulary.json, lib/vocabulary/ids.ts, lib/vocabulary/terms.ts.
// CONSOLIDATED.md lives outside the application repository, so its path is an argument and its sha256 is recorded.
// With no argument the file is looked for as findSource() does. CI does not have it: the tests then compare the
// committed ids.ts and terms.ts against a fresh emit from the committed data/vocabulary.json.
// Exit codes: 0 written; 2 for every validation failure (the message names the concept id). Nothing is written on 2.
// `--allow-missing-rules` is used only until Task 8 fills lint-rules.json; it lets a retired item with no rule be
// written with `text` only.
//
// overrides.json (hand-written texts; the lint class of an item is NOT here):
//   terms.spec / terms.extract / terms.whole / terms.fromConcept   { "<id>": "<term>" } four kinds, one id in one kind:
//       spec         the design spec's own term (any text);
//       extract      a verbatim, case-sensitive substring of the row's Ruled-term cell;
//       whole        equals the Ruled-term cell (records that someone looked);
//       fromConcept  the Concept column, lower-cased (for a cell that is only a cross-reference).
//   definitions     { "<id>": "<text>" }          replaces the parsed definition
//   retired.add     { "<id>": ["<text>", ...] }   retired items the table does not hold
//   additions       [ { id, group, concept, term, definition, retired, defineOnFirstUse, source } ]
//   historical      [ "<id>" ]                    concepts kept for records that predate a change
//   defineOnFirstUse [ "<id>" ]                   the only ids whose flag is true
//
// lint-rules.json (Task 8 fills it): keyed by concept id, then by the retired item's text exactly as the generator
// writes it (the `text` of the item in data/vocabulary.json):
//   { "<concept id>": { "<item text>": { "lint": "phrase", "pattern": "<regex source>", "caseSensitive": false }
//                                    | { "lint": "review", "why": "<reason>" } } }
// A key naming an unknown id, or a text the concept does not retire, is an error (exit 2).
//
// Retired-cell split: items are separated by commas and semicolons outside parentheses, double quotes and backticks.
// A cell that starts with `n/a` has no items. Surrounding quotes are stripped only when the whole item is one quoted
// string; an item's text is otherwise kept exactly.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SOURCE_RELATIVE = 'records/plans/2026-11-11-ux-redesign/copy-audit/CONSOLIDATED.md';
const OVERRIDES_PATH = 'scripts/vocabulary/overrides.json';
const LINT_RULES_PATH = 'scripts/vocabulary/lint-rules.json';
const COMMAND = 'node scripts/vocabulary/generate.mjs <CONSOLIDATED.md> [--allow-missing-rules]';
const HEADER = `Generated; do not edit by hand. Command: ${COMMAND}`;
const SECTION_START = '## 2. The vocabulary';
const SECTION_END = '### Terms the owner must decide';
const TERM_KINDS = ['spec', 'extract', 'whole', 'fromConcept'];
const GUARD = /[;:("]/;

/**
 * @typedef {{ text: string, lint?: string, pattern?: string, caseSensitive?: boolean, why?: string }} RetiredItem
 * @typedef {{ id: string, group: string, concept: string, term: string, definition: string | null, ownerDecision: boolean,
 *   defineOnFirstUse: boolean, historical?: true, retired: RetiredItem[], source?: string }} Concept
 * @typedef {{ _generated: string, source: string, sourceSha256: string, overrides: string, lintRules: string,
 *   concepts: Concept[], properNames: Array<{ text: string, source: string }> }} Vocabulary
 */

/** A validation failure. The command line turns it into exit code 2. */
export class VocabularyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'VocabularyError';
  }
}

/**
 * The source file: VOCABULARY_SOURCE if set (an error if that file is missing), else walk up from `start` (at most four
 * levels above it) until the plan's path exists. Undefined when it is nowhere (CI).
 * @param {string} [start]
 * @returns {string | undefined}
 */
export function findSource(start = REPO_ROOT) {
  const env = process.env.VOCABULARY_SOURCE;
  if (env) {
    if (!existsSync(env)) throw new VocabularyError('VOCABULARY_SOURCE is set but names no file');
    return resolve(env);
  }
  let dir = resolve(start);
  for (let level = 0; level <= 4; level++) {
    const candidate = join(dir, SOURCE_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** @param {string} text */
const kebab = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Split a Retire cell into its items (see the header).
 * @param {string} cell
 * @returns {string[]}
 */
export function splitRetire(cell) {
  const text = cell.trim();
  if (text.startsWith('n/a')) return [];
  const items = [];
  let depth = 0;
  let quoted = false;
  let ticked = false;
  let current = '';
  for (const ch of text) {
    if (ch === '`' && !quoted) ticked = !ticked;
    else if (ch === '"' && !ticked) quoted = !quoted;
    else if (!quoted && !ticked) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if ((ch === ',' || ch === ';') && depth === 0) {
        items.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  items.push(current);
  return items
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => (/^"[^"]*"$/.test(item) ? item.slice(1, -1) : item));
}

/**
 * The rows of section 2, in file order.
 * @param {string} markdown
 * @returns {Array<{ id: string, group: string, concept: string, ownerDecision: boolean, ruled: string, definition: string, retire: string }>}
 */
export function parseSection2(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === SECTION_START);
  if (start < 0) throw new VocabularyError(`the source has no "${SECTION_START}" heading`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === SECTION_END);
  if (end < 0) throw new VocabularyError(`the source has no "${SECTION_END}" heading after section 2`);
  const rows = [];
  let group = null;
  for (const line of lines.slice(start + 1, end)) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    if (heading) { group = heading[1]; continue; }
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, line.lastIndexOf('|')).split('|').map((c) => c.trim());
    if (cells[0] === 'Concept' || /^[\s|:-]+$/.test(line)) continue;
    if (cells.length !== 5) throw new VocabularyError(`row "${cells[0]}" has ${cells.length} cells, not 5`);
    if (group === null) throw new VocabularyError(`row "${cells[0]}" comes before any group heading`);
    const ownerDecision = /\*\*\[owner\]\*\*/.test(cells[0]);
    const concept = cells[0].replace(/\s*\*\*\[owner\]\*\*/g, '').trim();
    rows.push({ id: kebab(concept), group, concept, ownerDecision, ruled: cells[2], definition: cells[3], retire: cells[4] });
  }
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.id)) throw new VocabularyError(`concept id "${r.id}" is produced by two rows`);
    seen.add(r.id);
  }
  return rows;
}

/** One entry per unique resource title of the running content, in file order.
 * @param {string} [root]
 * @returns {Array<{ text: string, source: string }>}
 */
export function readProperNames(root = REPO_ROOT) {
  const running = JSON.parse(readFileSync(join(root, 'data/content/index.json'), 'utf8')).running;
  const file = `data/content/${running}/assessmentAreas.json`;
  const areas = JSON.parse(readFileSync(join(root, file), 'utf8'));
  const names = [];
  const seen = new Set();
  areas.controls.forEach((control, i) => {
    (control.resources ?? []).forEach((resource, j) => {
      if (seen.has(resource.title)) return;
      seen.add(resource.title);
      names.push({ text: resource.title, source: `${file}:controls[${i}].resources[${j}].title` });
    });
  });
  return names;
}

/** @param {unknown} rule @param {string} where */
function checkRule(rule, where) {
  const r = /** @type {Record<string, unknown>} */ (rule ?? {});
  if (r.lint === 'phrase') {
    if (typeof r.pattern !== 'string' || typeof r.caseSensitive !== 'boolean') {
      throw new VocabularyError(`lint rule for ${where}: a "phrase" rule needs a string "pattern" and a boolean "caseSensitive"`);
    }
    return { lint: 'phrase', pattern: r.pattern, caseSensitive: r.caseSensitive };
  }
  if (r.lint === 'review') {
    if (typeof r.why !== 'string' || r.why === '') throw new VocabularyError(`lint rule for ${where}: a "review" rule needs a "why"`);
    return { lint: 'review', why: r.why };
  }
  throw new VocabularyError(`lint rule for ${where}: "lint" must be "phrase" or "review"`);
}

/**
 * Build the vocabulary object.
 * @param {string} markdown CONSOLIDATED.md
 * @param {any} overrides overrides.json
 * @param {any} rules lint-rules.json
 * @param {{ allowMissingRules?: boolean, properNames: Array<{ text: string, source: string }> }} options
 * @returns {Vocabulary}
 */
export function generate(markdown, overrides, rules, options) {
  if (!options || !Array.isArray(options.properNames)) throw new VocabularyError('generate needs options.properNames');
  const rows = parseSection2(markdown);
  const parsed = new Map(rows.map((r) => [r.id, r]));
  const additions = overrides.additions ?? [];
  const known = new Set(parsed.keys());
  for (const add of additions) {
    if (known.has(add.id)) throw new VocabularyError(`addition "${add.id}" clashes with a parsed concept id`);
    known.add(add.id);
  }
  /** @param {string} list @param {Iterable<string>} ids @param {Set<string>} within */
  const requireKnown = (list, ids, within = known) => {
    for (const id of ids) if (!within.has(id)) throw new VocabularyError(`overrides.${list} names unknown id "${id}"`);
  };
  const terms = overrides.terms ?? {};
  const kindOf = new Map();
  for (const kind of TERM_KINDS) {
    const map = terms[kind] ?? {};
    requireKnown(`terms.${kind}`, Object.keys(map), new Set(parsed.keys()));
    for (const id of Object.keys(map)) {
      if (kindOf.has(id)) throw new VocabularyError(`concept "${id}" has a term override of two kinds (${kindOf.get(id)} and ${kind})`);
      kindOf.set(id, kind);
    }
  }
  requireKnown('definitions', Object.keys(overrides.definitions ?? {}), new Set(parsed.keys()));
  requireKnown('retired.add', Object.keys(overrides.retired?.add ?? {}), new Set(parsed.keys()));
  requireKnown('historical', overrides.historical ?? []);
  requireKnown('defineOnFirstUse', overrides.defineOnFirstUse ?? []);
  const historical = new Set(overrides.historical ?? []);
  const firstUse = new Set(overrides.defineOnFirstUse ?? []);

  const termOf = (row) => {
    const kind = kindOf.get(row.id);
    if (!kind) {
      if (GUARD.test(row.ruled)) {
        throw new VocabularyError(`concept "${row.id}": the Ruled-term cell "${row.ruled}" holds ; : ( or " and has no term override`);
      }
      return row.ruled;
    }
    const value = terms[kind][row.id];
    if (kind === 'extract' && !row.ruled.includes(value)) {
      throw new VocabularyError(`concept "${row.id}": term "${value}" is not a substring of the cell "${row.ruled}"`);
    }
    if (kind === 'whole' && value !== row.ruled) {
      throw new VocabularyError(`concept "${row.id}": term "${value}" does not equal the cell "${row.ruled}"`);
    }
    if (kind === 'fromConcept' && value !== row.concept.toLowerCase()) {
      throw new VocabularyError(`concept "${row.id}": term "${value}" is not the Concept column lower-cased ("${row.concept.toLowerCase()}")`);
    }
    return value;
  };

  /** @type {Concept[]} */
  const concepts = rows.map((row) => {
    const retiredTexts = splitRetire(row.retire);
    for (const added of overrides.retired?.add?.[row.id] ?? []) if (!retiredTexts.includes(added)) retiredTexts.push(added);
    const definition = overrides.definitions?.[row.id] ?? (row.definition.startsWith('n/a') ? null : row.definition);
    /** @type {Concept} */
    const concept = {
      id: row.id, group: row.group, concept: row.concept, term: termOf(row), definition,
      ownerDecision: row.ownerDecision, defineOnFirstUse: firstUse.has(row.id),
    };
    if (historical.has(row.id)) concept.historical = true;
    concept.retired = retiredTexts.map((text) => ({ text }));
    return concept;
  });
  for (const add of additions) {
    if (add.defineOnFirstUse !== firstUse.has(add.id)) {
      throw new VocabularyError(`addition "${add.id}": defineOnFirstUse disagrees with the defineOnFirstUse list`);
    }
    /** @type {Concept} */
    const concept = {
      id: add.id, group: add.group, concept: add.concept, term: add.term, definition: add.definition,
      ownerDecision: false, defineOnFirstUse: add.defineOnFirstUse,
    };
    if (historical.has(add.id)) concept.historical = true;
    concept.retired = (add.retired ?? []).map((text) => ({ text }));
    concept.source = add.source;
    concepts.push(concept);
  }
  const byId = new Map(concepts.map((c) => [c.id, c]));
  for (const id of firstUse) {
    if (byId.get(id).definition === null) throw new VocabularyError(`defineOnFirstUse id "${id}" has a null definition`);
  }

  for (const [id, byText] of Object.entries(rules ?? {})) {
    const concept = byId.get(id);
    if (!concept) throw new VocabularyError(`lint-rules.json names unknown id "${id}"`);
    for (const text of Object.keys(byText)) {
      if (!concept.retired.some((r) => r.text === text)) {
        throw new VocabularyError(`lint-rules.json: concept "${id}" does not retire "${text}"`);
      }
    }
  }
  const missing = [];
  for (const concept of concepts) {
    concept.retired = concept.retired.map(({ text }) => {
      const rule = rules?.[concept.id]?.[text];
      if (rule === undefined) { missing.push(`${concept.id}: "${text}"`); return { text }; }
      return { text, ...checkRule(rule, `${concept.id}: "${text}"`) };
    });
  }
  if (missing.length && !options.allowMissingRules) {
    throw new VocabularyError(`${missing.length} retired item(s) have no lint rule (lint-rules.json):\n  ${missing.join('\n  ')}`);
  }

  return {
    _generated: HEADER,
    source: SOURCE_RELATIVE,
    sourceSha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    overrides: OVERRIDES_PATH,
    lintRules: LINT_RULES_PATH,
    concepts,
    properNames: options.properNames,
  };
}

/** @param {unknown} vocabulary */
export const serialise = (vocabulary) => `${JSON.stringify(vocabulary, null, 2)}\n`;

/** @param {{ concepts: Array<{ id: string }> }} vocabulary */
export function emitIds(vocabulary) {
  const ids = vocabulary.concepts.map((c) => `  ${JSON.stringify(c.id)},`).join('\n');
  return `// ${HEADER}\n\nexport const VOCABULARY_IDS = [\n${ids}\n] as const;\n\nexport type VocabularyId = (typeof VOCABULARY_IDS)[number];\n`;
}

/** @param {{ concepts: Array<{ id: string, term: string, definition: string | null, defineOnFirstUse: boolean }> }} vocabulary */
export function emitTerms(vocabulary) {
  const lines = vocabulary.concepts.map((c) => {
    const name = `TERM_${c.id.replace(/-/g, '_').toUpperCase()}`;
    return `export const ${name}: VocabularyEntry = { id: ${JSON.stringify(c.id)}, term: ${JSON.stringify(c.term)}, definition: ${JSON.stringify(c.definition)}, defineOnFirstUse: ${c.defineOnFirstUse} };`;
  });
  return `// ${HEADER}\n\nimport type { VocabularyEntry } from './types';\n\n${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--') && a !== '--out-dir'));
  const outAt = args.indexOf('--out-dir');
  const outDir = outAt >= 0 ? resolve(args[outAt + 1] ?? '') : REPO_ROOT;
  const positional = args.filter((a, i) => !a.startsWith('--') && !(outAt >= 0 && i === outAt + 1));
  const sourcePath = positional[0] ?? findSource();
  if (!sourcePath) throw new VocabularyError('no source file: pass the path to CONSOLIDATED.md');
  const markdown = readFileSync(sourcePath, 'utf8');
  const overrides = JSON.parse(readFileSync(join(REPO_ROOT, OVERRIDES_PATH), 'utf8'));
  const rules = JSON.parse(readFileSync(join(REPO_ROOT, LINT_RULES_PATH), 'utf8'));
  const vocabulary = generate(markdown, overrides, rules, {
    allowMissingRules: flags.has('--allow-missing-rules'),
    properNames: readProperNames(),
  });
  const outputs = {
    'data/vocabulary.json': serialise(vocabulary),
    'lib/vocabulary/ids.ts': emitIds(vocabulary),
    'lib/vocabulary/terms.ts': emitTerms(vocabulary),
  };
  for (const [relative, content] of Object.entries(outputs)) {
    const target = join(outDir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof VocabularyError)) throw error;
    console.error(`vocabulary: ${error.message}`);
    process.exit(2);
  }
}
