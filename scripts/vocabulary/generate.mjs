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
// `--allow-missing-rules` lets a retired item with no rule be written with `text` only. Since Task 8 filled
// lint-rules.json the committed files are generated WITHOUT it; only fixture tests still pass it.
//
// overrides.json (hand-written texts; the lint class of an item is NOT here):
//   terms.spec / terms.extract / terms.fromConcept   { "<id>": "<term>" }, and terms.labels { "<id>": ["<label>", ...] };
//       four kinds, one id in one kind:
//       spec         the design spec's own term (any text);
//       extract      a verbatim, case-sensitive substring of the row's Ruled-term cell;
//       labels       each label a verbatim, case-sensitive substring of the cell; the term is the labels joined by "; ";
//       fromConcept  the Concept column, lower-cased (for a cell that is only a cross-reference).
//   definitions     { "<id>": "<text>" | null }   replaces the parsed definition; null means there is none
//                   (decided by whether the key is present, never by the value being falsy)
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
// A pattern never names a code point (no `\u…` escape, no character outside printable ASCII): it is copied into
// data/vocabulary.json, and __tests__/unit/font-subsets.test.ts reads every file under data/ as page copy. The lint
// shows a template hole (`${…}`), or a masked proper name, to a pattern as one format character, so "before a hole"
// is written `(?=\p{Cf})`. Such a pattern, or one that does not compile with the `u` flag, is an error (exit 2).
//
// Unknown keys in overrides.json and in a lint rule are errors; a missing optional key is allowed. Every concept is
// validated after the merge (kebab-case id, non-empty group, concept and term, a definition of at most 20 words or null).
// Command line: only --allow-missing-rules and --out-dir <dir>, and at most one path; anything else exits 2 before any
// file is read or written. A missing or invalid input file exits 2 with `vocabulary: <path>: <reason>`.
//
// Retired-cell split: items are separated by commas and semicolons outside parentheses, double quotes and backticks.
// A cell that starts with `n/a` has no items. Surrounding quotes are stripped only when the whole item is one quoted
// string; an item's text is otherwise kept exactly.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SOURCE_RELATIVE = 'records/plans/2026-11-11-ux-redesign/copy-audit/CONSOLIDATED.md';
const OVERRIDES_PATH = 'scripts/vocabulary/overrides.json';
const LINT_RULES_PATH = 'scripts/vocabulary/lint-rules.json';
const COMMAND = 'node scripts/vocabulary/generate.mjs <CONSOLIDATED.md> [--allow-missing-rules]';
const HEADER = `Generated; do not edit by hand. Command: ${COMMAND}`;
const SECTION_START = '## 2. The vocabulary';
const SECTION_END = '### Terms the owner must decide';
const TERM_KINDS = ['spec', 'extract', 'labels', 'fromConcept'];
// The first table of section 2 spells two column names out; the other seven use the short names. Both are in the source.
const HEADERS = [
  ['Concept', 'Forms in use (one example each)', 'Ruled term', 'Definition (shown at first use)', 'Retire'],
  ['Concept', 'Forms in use', 'Ruled term', 'Definition', 'Retire'],
];
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_DEFINITION_WORDS = 20;
const OVERRIDE_KEYS = ['terms', 'definitions', 'retired', 'additions', 'historical', 'defineOnFirstUse'];
const ADDITION_KEYS = ['id', 'group', 'concept', 'term', 'definition', 'retired', 'defineOnFirstUse', 'source'];
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

const has = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const reason = (error) => (error.code === 'ENOENT' ? 'no such file' : error.code === 'EISDIR' ? 'is a directory' : error.message);

/** @param {string} file @param {string} [label] */
function readText(file, label = file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new VocabularyError(`${label}: ${reason(error)}`);
  }
}

/** @param {string} file @param {string} [label] */
function readJson(file, label = file) {
  const text = readText(file, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new VocabularyError(`${label}: ${reason(error)}`);
  }
}

/** @param {unknown} object @param {string[]} allowed @param {string} where */
function onlyKeys(object, allowed, where) {
  if (object === null || typeof object !== 'object' || Array.isArray(object)) throw new VocabularyError(`${where} must be an object`);
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw new VocabularyError(`${where}: unknown key "${key}"`);
  }
}

/**
 * The source file: VOCABULARY_SOURCE if set (an error unless it names a regular file), else walk up from `start` (at most four
 * levels above it) until the plan's path exists. Undefined when it is nowhere (CI).
 * @param {string} [start]
 * @returns {string | undefined}
 */
export function findSource(start = REPO_ROOT) {
  const env = process.env.VOCABULARY_SOURCE;
  if (env !== undefined) {
    if (env === '' || !existsSync(env) || !statSync(env).isFile()) {
      throw new VocabularyError('VOCABULARY_SOURCE is set but is empty or does not name a regular file');
    }
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
 * @param {string} [label] names the row in an error message
 * @returns {string[]}
 */
export function splitRetire(cell, label = '') {
  const text = cell.trim();
  if (/^n\/a/i.test(text)) return [];
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
  if (quoted || ticked || depth > 0) {
    throw new VocabularyError(`${label ? `${label}: ` : ''}the retired cell ends inside an open quote, parenthesis or backtick: ${cell}`);
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
  const lines = markdown.split(/\r?\n/).map((l) => l.trim());
  const start = lines.indexOf(SECTION_START);
  if (start < 0) throw new VocabularyError(`the source has no "${SECTION_START}" heading`);
  const end = lines.findIndex((l, i) => i > start && l === SECTION_END);
  if (end < 0) throw new VocabularyError(`the source has no "${SECTION_END}" heading after section 2`);
  const section = lines.slice(start + 1, end);
  const rows = [];
  let group = null;
  const separator = (l) => /^\|[\s|:-]+\|$/.test(l);
  const cellsOf = (l) => l.slice(1, l.lastIndexOf('|')).split('|').map((c) => c.trim());
  const isHeader = (cells) => HEADERS.some((h) => h.length === cells.length && h.every((name, k) => name === cells[k]));
  const spellings = HEADERS.map((h) => h.join(' | ')).join(' / ');
  // Position inside a table block (a run of consecutive table lines): 0 before its first line, 1 after the header, 2 after the separator.
  let position = 0;
  const endBlock = () => {
    if (position === 1) throw new VocabularyError('a table header is the last line of its table, with no separator line after it');
    position = 0;
  };
  for (const line of section) {
    if (!line.startsWith('|')) endBlock();
    if (line === '') continue;
    if (line.startsWith('#')) {
      const heading = /^### (\S.*)$/.exec(line);
      if (!heading) throw new VocabularyError(`section 2 holds a heading that is not "### ...": ${line}`);
      group = heading[1];
      continue;
    }
    if (/^(```|~~~)/.test(line)) throw new VocabularyError(`section 2 holds a code fence, and a table inside one would be read as concepts: ${line}`);
    if (line.includes('<!--')) throw new VocabularyError(`section 2 holds an HTML comment, and a table inside one would be read as concepts: ${line}`);
    if (line.startsWith('|') && !line.endsWith('|')) throw new VocabularyError(`a table line does not end with "|", so the text after its last pipe would be lost: ${line}`);
    if (!line.startsWith('|')) {
      if (line.includes('|')) throw new VocabularyError(`section 2 holds a prose line with a "|" that is not a table line (a row needs its leading "|", and a table is not a quotation): ${line}`);
      continue;
    }
    const cells = cellsOf(line);
    if (position === 0) {
      if (!isHeader(cells)) throw new VocabularyError(`a table must start with a header, one of the two known spellings of the five column names (${spellings}): ${line}`);
      position = 1;
      continue;
    }
    if (position === 1) {
      if (!separator(line)) throw new VocabularyError(`a table header must be followed by a separator line: ${line}`);
      position = 2;
      continue;
    }
    if (separator(line)) throw new VocabularyError(`a separator line inside a table, after its header: ${line}`);
    if (isHeader(cells)) throw new VocabularyError(`a second header inside a table: ${line}`);
    if (cells.length !== 5) throw new VocabularyError(`row "${cells[0]}" has ${cells.length} cells, not 5`);
    if (group === null) throw new VocabularyError(`row "${cells[0]}" comes before any group heading`);
    if (cells[0] === '') throw new VocabularyError(`a row has an empty Concept cell: ${line}`);
    const ownerDecision = /\*\*\[owner\]\*\*/.test(cells[0]);
    const concept = cells[0].replace(/\s*\*\*\[owner\]\*\*/g, '').trim();
    const id = kebab(concept);
    if (cells[2] === '') throw new VocabularyError(`concept "${id}": the Ruled-term cell is empty`);
    if (cells[3] === '') throw new VocabularyError(`concept "${id}": the Definition cell is empty`);
    rows.push({ id, group, concept, ownerDecision, ruled: cells[2], definition: cells[3], retire: cells[4] });
  }
  endBlock();
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
  const indexFile = 'data/content/index.json';
  const running = readJson(join(root, indexFile), indexFile).running;
  if (!isText(running)) throw new VocabularyError(`${indexFile}: "running" is not a version string`);
  const file = `data/content/${running}/assessmentAreas.json`;
  const areas = readJson(join(root, file), file);
  if (!Array.isArray(areas.controls)) throw new VocabularyError(`${file}: "controls" is not a list`);
  const names = [];
  const seen = new Set();
  areas.controls.forEach((control, i) => {
    (control.resources ?? []).forEach((resource, j) => {
      if (!isText(resource.title)) throw new VocabularyError(`${file}: controls[${i}].resources[${j}] has no title`);
      if (seen.has(resource.title)) return;
      seen.add(resource.title);
      names.push({ text: resource.title, source: `${file}:controls[${i}].resources[${j}].title` });
    });
  });
  return names;
}

/** @param {unknown} rule @param {string} where */
function checkRule(rule, where) {
  const r = /** @type {Record<string, unknown>} */ (rule);
  if (r === null || typeof r !== 'object') throw new VocabularyError(`lint rule for ${where} must be an object`);
  if (r.lint === 'phrase') {
    onlyKeys(r, ['lint', 'pattern', 'caseSensitive'], `lint rule for ${where}`);
    if (typeof r.pattern !== 'string' || typeof r.caseSensitive !== 'boolean') {
      throw new VocabularyError(`lint rule for ${where}: a "phrase" rule needs a string "pattern" and a boolean "caseSensitive"`);
    }
    // An unescaped `\u` or `\x` (an even run of backslashes before it is literal backslashes), or any character
    // outside printable ASCII, names a code point; see the header.
    if (/(^|[^\\])(\\\\)*\\[ux]/.test(r.pattern) || /[^\x20-\x7e]/.test(r.pattern)) {
      throw new VocabularyError(`lint rule for ${where}: the pattern names a code point (a \\u or \\x escape, or a character outside printable ASCII)`);
    }
    try {
      new RegExp(r.pattern, 'u');
    } catch (error) {
      throw new VocabularyError(`lint rule for ${where}: the pattern does not compile with the u flag: ${reason(error)}`);
    }
    return { lint: 'phrase', pattern: r.pattern, caseSensitive: r.caseSensitive };
  }
  if (r.lint === 'review') {
    onlyKeys(r, ['lint', 'why'], `lint rule for ${where}`);
    if (!isText(r.why)) throw new VocabularyError(`lint rule for ${where}: a "review" rule needs a "why"`);
    return { lint: 'review', why: r.why };
  }
  throw new VocabularyError(`lint rule for ${where}: "lint" must be "phrase" or "review"`);
}

/** @param {any} overrides */
function checkOverrides(overrides) {
  onlyKeys(overrides, OVERRIDE_KEYS, 'overrides.json');
  const map = (value, where) => {
    if (value === undefined) return {};
    onlyKeys(value, Object.keys(value ?? {}), where);
    return value;
  };
  if (overrides.terms !== undefined) {
    onlyKeys(overrides.terms, TERM_KINDS, 'overrides.terms');
    for (const kind of TERM_KINDS) {
      for (const [id, value] of Object.entries(map(overrides.terms[kind], `overrides.terms.${kind}`))) {
        const ok = kind === 'labels' ? Array.isArray(value) && value.length > 0 && value.every(isText) : isText(value);
        if (!ok) throw new VocabularyError(`overrides.terms.${kind}: "${id}" must be ${kind === 'labels' ? 'a non-empty list of texts' : 'a non-empty text'}`);
      }
    }
  }
  for (const [id, value] of Object.entries(map(overrides.definitions, 'overrides.definitions'))) {
    if (value !== null && !isText(value)) throw new VocabularyError(`overrides.definitions: "${id}" must be a non-empty text or null`);
  }
  if (overrides.retired !== undefined) {
    onlyKeys(overrides.retired, ['add'], 'overrides.retired');
    for (const [id, texts] of Object.entries(map(overrides.retired.add, 'overrides.retired.add'))) {
      if (!Array.isArray(texts) || !texts.every(isText)) throw new VocabularyError(`overrides.retired.add: "${id}" must be a list of texts`);
    }
  }
  for (const list of ['historical', 'defineOnFirstUse']) {
    if (overrides[list] !== undefined && !(Array.isArray(overrides[list]) && overrides[list].every(isText))) {
      throw new VocabularyError(`overrides.${list} must be a list of ids`);
    }
  }
  if (overrides.additions !== undefined && !Array.isArray(overrides.additions)) throw new VocabularyError('overrides.additions must be a list');
  for (const add of overrides.additions ?? []) {
    onlyKeys(add, ADDITION_KEYS, `overrides.additions (${add?.id ?? 'no id'})`);
    if (!isText(add.source)) throw new VocabularyError(`addition "${add.id}": a source citation is required`);
    if (add.retired !== undefined && !(Array.isArray(add.retired) && add.retired.every(isText))) {
      throw new VocabularyError(`addition "${add.id}": retired must be a list of texts`);
    }
  }
}

/** The one place a merged concept is validated. @param {Concept} c */
function checkConcept(c) {
  if (typeof c.id !== 'string' || !ID_PATTERN.test(c.id)) throw new VocabularyError(`concept "${c.id}": the id is not kebab case`);
  for (const key of ['group', 'concept', 'term']) {
    if (!isText(c[key])) throw new VocabularyError(`concept "${c.id}": ${key} must be a non-empty text`);
  }
  if (c.definition !== null) {
    if (!isText(c.definition)) throw new VocabularyError(`concept "${c.id}": the definition must be a non-empty text or null`);
    const words = c.definition.trim().split(/\s+/).length;
    if (words > MAX_DEFINITION_WORDS) throw new VocabularyError(`concept "${c.id}": the definition has ${words} words, over ${MAX_DEFINITION_WORDS}`);
  }
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
  checkOverrides(overrides);
  const rows = parseSection2(markdown);
  const parsedIds = new Set(rows.map((r) => r.id));
  const additions = overrides.additions ?? [];
  const known = new Set(parsedIds);
  for (const add of additions) {
    if (known.has(add.id)) throw new VocabularyError(`addition "${add.id}" clashes with a parsed concept id`);
    known.add(add.id);
  }
  /** @param {string} list @param {Iterable<string>} ids @param {Set<string>} within */
  const requireKnown = (list, ids, within = known) => {
    for (const id of ids) if (!within.has(id)) throw new VocabularyError(`overrides.${list} names unknown id "${id}"`);
  };
  const terms = overrides.terms ?? {};
  const definitions = overrides.definitions ?? {};
  const retiredAdd = overrides.retired?.add ?? {};
  const kindOf = new Map();
  for (const kind of TERM_KINDS) {
    const map = terms[kind] ?? {};
    requireKnown(`terms.${kind}`, Object.keys(map), parsedIds);
    for (const id of Object.keys(map)) {
      if (kindOf.has(id)) throw new VocabularyError(`concept "${id}" has a term override of two kinds (${kindOf.get(id)} and ${kind})`);
      kindOf.set(id, kind);
    }
  }
  requireKnown('definitions', Object.keys(definitions), parsedIds);
  requireKnown('retired.add', Object.keys(retiredAdd), parsedIds);
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
    if (kind === 'labels') {
      for (const label of value) {
        if (!row.ruled.includes(label)) throw new VocabularyError(`concept "${row.id}": label "${label}" is not a substring of the cell "${row.ruled}"`);
      }
      return value.join('; ');
    }
    if (kind === 'fromConcept' && value !== row.concept.toLowerCase()) {
      throw new VocabularyError(`concept "${row.id}": term "${value}" is not the Concept column lower-cased ("${row.concept.toLowerCase()}")`);
    }
    return value;
  };

  /** @type {Concept[]} */
  const concepts = rows.map((row) => {
    const retiredTexts = splitRetire(row.retire, `concept "${row.id}"`);
    for (const added of has(retiredAdd, row.id) ? retiredAdd[row.id] : []) if (!retiredTexts.includes(added)) retiredTexts.push(added);
    const definition = has(definitions, row.id) ? definitions[row.id] : /^n\/a/i.test(row.definition) ? null : row.definition;
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
    if (add.defineOnFirstUse !== undefined && add.defineOnFirstUse !== firstUse.has(add.id)) {
      throw new VocabularyError(`addition "${add.id}": defineOnFirstUse disagrees with the defineOnFirstUse list`);
    }
    /** @type {Concept} */
    const concept = {
      id: add.id, group: add.group, concept: add.concept, term: add.term, definition: add.definition,
      ownerDecision: false, defineOnFirstUse: firstUse.has(add.id),
    };
    if (historical.has(add.id)) concept.historical = true;
    concept.retired = (add.retired ?? []).map((text) => ({ text }));
    concept.source = add.source;
    concepts.push(concept);
  }
  for (const concept of concepts) {
    checkConcept(concept);
    if (concept.defineOnFirstUse && typeof concept.definition !== 'string') {
      throw new VocabularyError(`defineOnFirstUse id "${concept.id}" has no definition`);
    }
  }
  const byId = new Map(concepts.map((c) => [c.id, c]));

  if (!isPlainObject(rules)) throw new VocabularyError('lint-rules.json must be an object keyed by concept id');
  for (const [id, byText] of Object.entries(rules)) {
    if (!isPlainObject(byText)) throw new VocabularyError(`lint-rules.json: concept "${id}" must be an object keyed by retired item text`);
  }
  for (const [id, byText] of Object.entries(rules)) {
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
      if (!has(rules, concept.id) || !has(rules[concept.id], text)) { missing.push(`${concept.id}: "${text}"`); return { text }; }
      return { text, ...checkRule(rules[concept.id][text], `${concept.id}: "${text}"`) };
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
    return `export const ${name} = { id: ${JSON.stringify(c.id)}, term: ${JSON.stringify(c.term)}, definition: ${JSON.stringify(c.definition)}, defineOnFirstUse: ${c.defineOnFirstUse} } as const satisfies VocabularyEntry;`;
  });
  return `// ${HEADER}\n\nimport type { VocabularyEntry } from './types';\n\n${lines.join('\n')}\n`;
}

/** @param {string[]} args */
function parseArgs(args) {
  let allowMissingRules = false;
  let outDir = REPO_ROOT;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--allow-missing-rules') allowMissingRules = true;
    else if (arg === '--out-dir') {
      const value = args[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new VocabularyError('--out-dir needs a directory after it');
      outDir = resolve(value);
      i++;
    } else if (arg.startsWith('--')) throw new VocabularyError(`unknown argument ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new VocabularyError(`more than one source path: ${positional.join(' ')}`);
  return { allowMissingRules, outDir, sourcePath: positional[0] ?? findSource() };
}

function main() {
  const { allowMissingRules, outDir, sourcePath } = parseArgs(process.argv.slice(2));
  if (!sourcePath) throw new VocabularyError('no source file: pass the path to CONSOLIDATED.md');
  const markdown = readText(sourcePath);
  const overrides = readJson(join(REPO_ROOT, OVERRIDES_PATH), OVERRIDES_PATH);
  const rules = readJson(join(REPO_ROOT, LINT_RULES_PATH), LINT_RULES_PATH);
  const vocabulary = generate(markdown, overrides, rules, { allowMissingRules, properNames: readProperNames() });
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

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof VocabularyError)) throw error;
    console.error(`vocabulary: ${error.message}`);
    process.exit(2);
  }
}
