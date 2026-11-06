import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runningContent } from '@/lib/content/loader';
import type { ResourcesFile } from '@/types/content';

/**
 * The release resources file `data/resources.json` (FR-CNT-05, ADR-C9): which control has a reviewed template or
 * notebook, and where it is served. It sits outside every content version directory and is not hashed, so a newly
 * reviewed notebook ships without a new content version.
 *
 * Every `file` and `requirementsFile` is the URL path the file is served at; the file on disk is `public` followed by
 * that path (contract Services row "`data/resources.json` paths"). Those values become links on S-27, so each is held
 * to one served folder by a pattern that admits no `..`, no second slash and no scheme. A file that breaks a rule is a
 * defect of the release, so the parse throws on the first one, naming the entry and field; nothing is dropped or
 * defaulted, and a key the format does not have is refused rather than ignored, so a misspelled `released` cannot pass
 * as absent.
 */

type Json = Record<string, unknown>;
type Template = ResourcesFile['templates'][number];
type Notebook = ResourcesFile['notebooks'][number];
type Review = Template['review'];

const TEMPLATE_FILE = /^\/templates\/[A-Za-z0-9._-]+\.html$/;
const NOTEBOOK_FILE = /^\/notebooks\/[A-Za-z0-9._-]+\.ipynb$/;
const REQUIREMENTS_FILE = /^\/notebooks\/[A-Za-z0-9._-]+\.txt$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const OUTCOMES: readonly Review['outcome'][] = ['passed', 'failed'];

const TOP_KEYS = ['templates', 'notebooks'] as const;
const TEMPLATE_KEYS = ['controlId', 'file', 'kind', 'bytes', 'sha256', 'review'] as const satisfies readonly (keyof Template)[];
const NOTEBOOK_KEYS = ['controlId', 'file', 'requirementsFile', 'sha256', 'bytes', 'review', 'released'] as const satisfies readonly (keyof Notebook)[];
const REVIEW_KEYS = ['reviewer', 'date', 'outcome'] as const satisfies readonly (keyof Review)[];

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function refuse(where: string, what: string): never {
  throw new Error(`resources.json ${where}: ${what}`);
}

function onlyKeys(v: Json, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) refuse(where === '' ? key : `${where}.${key}`, 'is not a field of the format');
}

function text(v: unknown, where: string): string {
  return typeof v === 'string' && v !== '' ? v : refuse(where, 'must be a non-empty string');
}

function matching(v: unknown, pattern: RegExp, where: string, shape: string): string {
  return typeof v === 'string' && pattern.test(v) ? v : refuse(where, `${JSON.stringify(v)} must be ${shape}`);
}

/** A `YYYY-MM-DD` that names a real day: `2026-02-30` matches the pattern and is refused. */
function calendarDate(v: unknown, where: string): string {
  const d = matching(v, DATE, where, 'a date YYYY-MM-DD');
  const parsed = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === d ? d : refuse(where, `${d} is not a calendar date`);
}

function review(v: unknown, where: string): Review {
  if (!isRecord(v)) refuse(where, 'must be an object');
  onlyKeys(v, REVIEW_KEYS, where);
  const outcome = v.outcome;
  if (typeof outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(outcome)) refuse(`${where}.outcome`, `must be ${OUTCOMES.join(' or ')}`);
  return { reviewer: text(v.reviewer, `${where}.reviewer`), date: calendarDate(v.date, `${where}.date`), outcome: outcome as Review['outcome'] };
}

function entries(raw: Json, key: (typeof TOP_KEYS)[number]): Json[] {
  const v = raw[key];
  if (!Array.isArray(v)) refuse(key, 'must be a list');
  return v.map((e, i) => (isRecord(e) ? e : refuse(`${key}[${i}]`, 'must be an object')));
}

/**
 * Checks a parsed resources file against the format and returns a copy of it. `controlId` must name a control of the
 * running content. Throws an `Error` naming the first bad entry and field, for example `templates[0].file`.
 */
export function parseResources(raw: unknown): ResourcesFile {
  if (!isRecord(raw)) refuse('', 'the file must be an object with templates and notebooks');
  onlyKeys(raw, TOP_KEYS, '');
  const templates = entries(raw, 'templates');
  const notebooks = entries(raw, 'notebooks');
  const content = runningContent();
  const control = (v: unknown, where: string): string => {
    const id = text(v, where);
    return content.controls.has(id) ? id : refuse(where, `${id} is not a control of content ${content.semver}`);
  };
  const sha256 = (v: unknown, where: string): string => matching(v, SHA256, where, '64 lowercase hexadecimal digits');
  const bytes = (v: unknown, where: string): number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : refuse(where, 'must be a positive whole number');

  // A card links one template and one notebook per control (it takes the first passed or released entry), so a second entry of a kind
  // would be served and linked nowhere (G3). Checked after the field rules, so a bad field is still named first.
  const onePerControl = (list: Json[], key: string): void => {
    const seen = new Set<unknown>();
    list.forEach((e, i) => {
      if (seen.has(e.controlId)) refuse(`${key}[${i}].controlId`, `${String(e.controlId)} already has a ${key.slice(0, -1)} entry`);
      seen.add(e.controlId);
    });
  };

  const result = {
    templates: templates.map((t, i): Template => {
      const at = `templates[${i}]`;
      onlyKeys(t, TEMPLATE_KEYS, at);
      return {
        controlId: control(t.controlId, `${at}.controlId`),
        file: matching(t.file, TEMPLATE_FILE, `${at}.file`, 'a path /templates/<name>.html'),
        kind: text(t.kind, `${at}.kind`),
        bytes: bytes(t.bytes, `${at}.bytes`),
        sha256: sha256(t.sha256, `${at}.sha256`),
        review: review(t.review, `${at}.review`),
      };
    }),
    notebooks: notebooks.map((n, i): Notebook => {
      const at = `notebooks[${i}]`;
      onlyKeys(n, NOTEBOOK_KEYS, at);
      const checked = {
        controlId: control(n.controlId, `${at}.controlId`),
        file: matching(n.file, NOTEBOOK_FILE, `${at}.file`, 'a path /notebooks/<name>.ipynb'),
        requirementsFile: matching(n.requirementsFile, REQUIREMENTS_FILE, `${at}.requirementsFile`, 'a path /notebooks/<name>.txt'),
        sha256: sha256(n.sha256, `${at}.sha256`),
        bytes: bytes(n.bytes, `${at}.bytes`),
        review: review(n.review, `${at}.review`),
      };
      if (typeof n.released !== 'boolean') refuse(`${at}.released`, 'must be true or false');
      // NB-AC-10 (SRS line 4650): a notebook is released only after its review passed.
      if (n.released && checked.review.outcome !== 'passed') refuse(`${at}.released`, 'is true but the review outcome is not passed');
      return { ...checked, released: n.released };
    }),
  };
  onePerControl(templates, 'templates');
  onePerControl(notebooks, 'notebooks');
  return result;
}

let cached: ResourcesFile | undefined;

/**
 * The parsed `data/resources.json`, read on first call and kept for the process (the file ships with the release).
 * The path has a literal prefix after `process.cwd()`, so the build traces this one file (contract "Static read
 * paths"). A file that is not JSON throws an `Error` naming it, with the parse error as its cause; a file that breaks
 * the format throws from `parseResources`. Neither is cached, and a missing file throws `ENOENT` unchanged.
 */
export function loadResources(): ResourcesFile {
  if (cached !== undefined) return cached;
  const textOfFile = readFileSync(join(process.cwd(), 'data', 'resources.json'), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(textOfFile);
  } catch (e) {
    if (e instanceof SyntaxError) throw new Error('data/resources.json: not valid JSON', { cause: e });
    throw e;
  }
  cached = parseResources(raw);
  return cached;
}
