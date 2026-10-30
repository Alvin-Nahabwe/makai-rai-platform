import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildLoadedContent } from '@/lib/content/loader';
import { SEMVER_RE } from '@/lib/content/semver';
import { signOffHash, signOffItems, signOffPayload, type SignOffBatch } from '@/lib/content/signoffs';
import type { LoadedContent, LoadedQuestion, RevisionAction } from '@/types/content';
import { STAGES } from '@/types/record';

/**
 * The content check of a version directory (FR-CNT-01, FR-CNT-02; SRS 10.1.0, 10.1.1, 10.1.10 QC-01, QC-02, QC-05,
 * QC-06; call R-61). Scripts and tests only: CI's content test, CNT's release command (NFR-MNT-07) and C-TXT's
 * sign-off script call it, and no module under `app/`, `lib/` or `components/` imports it, because it reads files
 * by computed paths that a route must never carry into its build trace (contract "Static read paths"). Each such
 * argument carries the `turbopackIgnore` directive all the same.
 *
 * It returns one line per problem; an empty list means the version is valid. Nothing it finds is thrown: a file that
 * is missing, unreadable or not JSON, a bundle the loader refuses and a payload that cannot be hashed are each a line,
 * so a caller that gets an empty list knows every rule ran. The version is built with the loader's own parser
 * (`buildLoadedContent`), never a second one; the 4.0.0 baseline and the proposal, which are not content bundles, are
 * read as plain JSON.
 */

type Json = Record<string, unknown>;
type Read = Parameters<typeof buildLoadedContent>[1];
type Mapping = string | { area?: unknown };

/** The backbone that does not change (FR-CNT-01, SRS 10.1.1): 3 stages, 6 modules, 21 risk areas, 28 controls. */
const MODULE_COUNT = 6;
const AREA_COUNT = 21;
const CONTROL_COUNT = 28;
/** QC-05 (SRS line 4229) and 10.1.5: the code the gate rule writes, and "other" for each status. */
const REQUIRED_CODES = ['na_no_personal_data', 'na_other', 'ny_other'] as const;
const BATCHES: readonly SignOffBatch[] = [...STAGES, 'help-and-reason-codes', ...STAGES.map((s) => `question-set:${s}` as const)];
const PROPOSAL_STATUSES = ['draft', 'checked', 'revised', 'approved'] as const;
const ACTION_KINDS = ['keep', 'reword', 'merge', 'cut', 'replace'] as const;
/** An ISO 8601 time with a zone: a sign-off time without one would mean a different instant on each machine. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const codePoints = (s: string): number => [...s].length;
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const errorCode = (e: unknown): string => (e as NodeJS.ErrnoException).code ?? (e as Error).message;

/** The number of sentence ends in a text: runs of `.`, `!` or `?` followed by white space or the end. */
export function sentenceCount(text: string): number {
  return (text.match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

/** A file's text, or the problem of reading it. */
function readText(path: string, label: string): { text: string } | { problem: string } {
  try {
    return { text: readFileSync(/*turbopackIgnore: true*/ path, 'utf8') };
  } catch (e) {
    return { problem: `${label} cannot be read (${errorCode(e)})` };
  }
}

/** A file's parsed JSON, or the problem of reading or parsing it. */
function readJson(path: string, label: string): { value: unknown } | { problem: string } {
  const r = readText(path, label);
  if ('problem' in r) return r;
  try {
    return { value: JSON.parse(r.text) };
  } catch {
    return { problem: `${label} is not valid JSON` };
  }
}

/** The risk areas a question maps to, through `gaps` and every option of `optionGapMap` (QC-02's FULL reading). */
function areasOf(q: { gaps?: unknown; optionGapMap?: unknown }): Set<string> {
  const out = new Set<string>(Array.isArray(q.gaps) ? q.gaps.filter((a): a is string => typeof a === 'string') : []);
  if (isRecord(q.optionGapMap)) {
    for (const list of Object.values(q.optionGapMap)) {
      if (!Array.isArray(list)) continue;
      for (const e of list as Mapping[]) {
        const area = typeof e === 'string' ? e : e?.area;
        if (typeof area === 'string') out.add(area);
      }
    }
  }
  return out;
}

/** The (risk area, control) pairs of a question, as `area>control` strings, through the areas' control lists. */
function pairsOf(q: { gaps?: unknown; optionGapMap?: unknown }, areaControls: ReadonlyMap<string, readonly string[]>): Set<string> {
  const out = new Set<string>();
  for (const area of areasOf(q)) for (const control of areaControls.get(area) ?? []) out.add(`${area}>${control}`);
  return out;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((x) => b.has(x));
const sameList = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

interface BaseQuestion { id: string; stage: string; moduleId: string; type: unknown; principle: unknown; options: unknown; text: unknown; pairs: Set<string> }

/** The 4.0.0 questions of `baselineDir` (its `questionBank.json` and `assessmentAreas.json`), or the problems of reading them. */
function readBaseline(baselineDir: string): { questions: Map<string, BaseQuestion>; bankBytes: Buffer } | { problems: string[] } {
  const bankPath = join(/*turbopackIgnore: true*/ baselineDir, 'questionBank.json');
  let bankBytes: Buffer;
  try {
    bankBytes = readFileSync(/*turbopackIgnore: true*/ bankPath);
  } catch (e) {
    return { problems: [`baseline ${bankPath} cannot be read (${errorCode(e)})`] };
  }
  const areasFile = readJson(join(/*turbopackIgnore: true*/ baselineDir, 'assessmentAreas.json'), `baseline ${baselineDir}/assessmentAreas.json`);
  if ('problem' in areasFile) return { problems: [areasFile.problem] };
  let bank: unknown;
  try {
    bank = JSON.parse(bankBytes.toString('utf8'));
  } catch {
    return { problems: [`baseline ${bankPath} is not valid JSON`] };
  }
  if (!isRecord(bank) || !isRecord(bank.stages) || !isRecord(areasFile.value) || !Array.isArray(areasFile.value.areas)) {
    return { problems: [`baseline ${baselineDir} does not hold a 4.0.0 question bank and areas file`] };
  }
  const areaControls = new Map<string, string[]>();
  for (const a of areasFile.value.areas) if (isRecord(a) && typeof a.id === 'string') areaControls.set(a.id, Array.isArray(a.controls) ? a.controls : []);
  const questions = new Map<string, BaseQuestion>();
  for (const [stage, s] of Object.entries(bank.stages)) {
    for (const m of isRecord(s) && Array.isArray(s.modules) ? s.modules : []) {
      for (const q of isRecord(m) && Array.isArray(m.questions) ? m.questions : []) {
        if (!isRecord(q) || typeof q.id !== 'string') continue;
        questions.set(q.id, { id: q.id, stage, moduleId: String(m.id), type: q.type, principle: q.principle, options: q.options, text: q.text, pairs: pairsOf(q, areaControls) });
      }
    }
  }
  return { questions, bankBytes };
}

type Action = RevisionAction;

/**
 * The approved proposal's actions, or `null` when there is no proposal file or its status is not `'approved'` (then
 * the version must be the 4.0.0 set). Reading, parsing and shape problems go to `say`.
 */
function readProposal(file: string, base: { questions: Map<string, BaseQuestion>; bankBytes: Buffer }, say: (p: string) => void): Action[] | null {
  const r = readJson(file, `proposal ${file}`);
  if ('problem' in r) {
    say(r.problem);
    return null;
  }
  const p = r.value;
  const where = `proposal ${file}`;
  if (!isRecord(p) || !(PROPOSAL_STATUSES as readonly unknown[]).includes(p.status)) {
    say(`${where}: status is not one of ${PROPOSAL_STATUSES.join(', ')}`);
    return null;
  }
  if (p.status !== 'approved') return null;
  const baseSha = isRecord(p.base) ? p.base.sha256 : undefined;
  if (baseSha !== sha256Hex(base.bankBytes)) say(`${where}: base.sha256 is not the sha256 of the 4.0.0 question bank it revises`);
  if (!Array.isArray(p.actions)) {
    say(`${where}: actions is not a list`);
    return [];
  }
  const actions: Action[] = [];
  const seen = new Map<string, number>();
  p.actions.forEach((a: unknown, i: number) => {
    const at = `${where}: actions[${i}]`;
    if (!isRecord(a) || !(ACTION_KINDS as readonly unknown[]).includes(a.action) || typeof a.id !== 'string') {
      say(`${at} is not a keep, reword, merge, cut or replace action with an id`);
      return;
    }
    const extra = a.action === 'reword' ? 'text' : a.action === 'merge' ? 'into' : a.action === 'replace' ? 'newId' : null;
    if (extra !== null && (typeof a[extra] !== 'string' || a[extra] === '')) {
      say(`${at} (${a.id}): a ${String(a.action)} action needs ${extra}`);
      return;
    }
    const baseQ = base.questions.get(a.id);
    if (baseQ === undefined) say(`${at}: ${a.id} is not a 4.0.0 question`);
    else if (a.originalText !== baseQ.text) say(`${at} (${a.id}): originalText is not the 4.0.0 stem`);
    seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
    actions.push(a as unknown as Action);
  });
  for (const id of base.questions.keys()) {
    const n = seen.get(id) ?? 0;
    if (n === 0) say(`question ${id}: the approved proposal gives it no action`);
    if (n > 1) say(`question ${id}: the approved proposal gives it more than one action`);
  }
  return actions;
}

/**
 * Checks one content version directory and returns its problems, one line each; `[]` means valid. Always: the
 * structure of SRS 10.1.1 and Task 1's rules (stages, modules, areas, controls, mapping, conditions, the gate, reason
 * codes, links, `meta.version`, `signoffs.json` present), and the ids, stems and (risk area, control) pairs against
 * `baselineDir`'s 4.0.0 files: without an approved proposal the version is the 4.0.0 set, kept whole; with one, it is
 * the set the proposal's actions make (R-61, QC-02). With `completeness`: QC-01's lengths, QC-06, and for each of the
 * seven batches a latest sign-off record whose sha256 and items match the current texts.
 */
export function validateContentVersion(versionDir: string, opts: { baselineDir: string; proposalFile: string | null; completeness: boolean }): string[] {
  const semver = basename(versionDir);
  if (!SEMVER_RE.test(semver)) return [`${versionDir}: the directory name is not a content version`];
  const problems: string[] = [];
  const say = (p: string): void => {
    problems.push(`${semver}: ${p}`);
  };

  const bytes = new Map<string, Buffer>();
  const read: Read = (file) => {
    const b = readFileSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ versionDir, file));
    bytes.set(file, b);
    return b;
  };
  let c: LoadedContent;
  try {
    c = buildLoadedContent(semver, read);
  } catch (e) {
    // The loader names the version and what is wrong; nothing else can be checked on a bundle it refuses.
    return [`${semver}: cannot be loaded: ${(e as Error).message}`];
  }
  const rawBank = JSON.parse(bytes.get('questionBank.json')!.toString('utf8')) as Json;
  const rawAreas = JSON.parse(bytes.get('assessmentAreas.json')!.toString('utf8')) as Json;
  const questions = [...c.questions.values()];

  checkStructure(c, rawBank, rawAreas, questions, say);

  const signoffs = readJson(join(/*turbopackIgnore: true*/ versionDir, 'signoffs.json'), 'signoffs.json');
  let records: unknown[] | null = null;
  if ('problem' in signoffs) say(signoffs.problem);
  else if (!isRecord(signoffs.value) || !Array.isArray(signoffs.value.records)) say('signoffs.json: records is not a list');
  else records = signoffs.value.records;

  const base = readBaseline(opts.baselineDir);
  if ('problems' in base) base.problems.forEach(say);
  else {
    const actions = opts.proposalFile === null ? null : readProposal(opts.proposalFile, base, say);
    checkIds(questions, base.questions, actions, c, say);
  }

  if (opts.completeness) {
    for (const q of questions) checkTexts(q, say);
    if (records !== null) checkSignOffs(c, records, say);
  }
  return problems;
}

function checkStructure(c: LoadedContent, rawBank: Json, rawAreas: Json, questions: readonly LoadedQuestion[], say: (p: string) => void): void {
  if (!sameList(Object.keys(rawBank), ['meta', 'stages'])) say(`questionBank.json holds ${Object.keys(rawBank).join(', ')}; only meta and stages are allowed (FR-CNT-06)`);
  if (!sameList(Object.keys(rawBank.stages as Json), STAGES)) say(`questionBank.json stages are not in the order ${STAGES.join(', ')}`);
  for (const [file, raw] of [['questionBank.json', rawBank], ['assessmentAreas.json', rawAreas]] as const) {
    if (!isRecord(raw.meta) || raw.meta.version !== c.semver) say(`${file}: meta.version is not ${c.semver}`);
  }
  const stagesWithModules = Object.values(rawBank.stages as Json).flatMap((s) => (s as { modules: unknown[] }).modules);
  if (stagesWithModules.length !== MODULE_COUNT) say(`questionBank.json has ${stagesWithModules.length} modules; ${MODULE_COUNT} required (FR-CNT-01)`);
  if (c.areas.size !== AREA_COUNT) say(`assessmentAreas.json has ${c.areas.size} risk areas; ${AREA_COUNT} required (FR-CNT-01)`);
  if (c.controls.size !== CONTROL_COUNT) say(`assessmentAreas.json has ${c.controls.size} controls; ${CONTROL_COUNT} required (FR-CNT-01)`);

  // Mapping (FR-CNT-01, QC-02): no dangling id under gaps or optionGapMap, every area mapped, every control reached.
  const mapped = new Set<string>();
  for (const q of questions) {
    for (const area of areasOf(q)) {
      if (!c.areas.has(area)) say(`question ${q.id}: maps to ${area}, which is not a risk area`);
      mapped.add(area);
    }
  }
  const reached = new Set<string>();
  for (const a of c.areas.values()) {
    if (!mapped.has(a.id)) say(`risk area ${a.id}: no question maps to it`);
    for (const control of a.controls ?? []) {
      if (!c.controls.has(control)) say(`risk area ${a.id}: lists ${control}, which is not a control`);
      if (mapped.has(a.id)) reached.add(control);
    }
  }
  for (const id of c.controls.keys()) if (!reached.has(id)) say(`control ${id}: no question reaches it`);

  for (const q of questions) {
    for (const field of ['crossStageCondition', 'weight', 'scale']) if (Object.hasOwn(q, field)) say(`question ${q.id}: has ${field}, which 5.0.0 removes (FR-CNT-06)`);
    if (q.type === 'gate') {
      if (q.options !== undefined) say(`question ${q.id}: a gate carries no options (FR-CNT-04)`);
      if (areasOf(q).size > 0) say(`question ${q.id}: a gate maps to no risk area (FR-CNT-04)`);
    }
    if (q.type === 'checklist' && (!Array.isArray(q.options) || q.options.length === 0)) say(`question ${q.id}: a checklist needs its options (FR-CNT-03)`);
  }

  for (const k of c.controls.values()) {
    for (const field of ['notebook', 'template']) if (Object.hasOwn(k, field)) say(`control ${k.id}: has ${field}, which lives in data/resources.json (FR-CNT-05)`);
    for (const r of k.resources ?? []) {
      let protocol: string | null = null;
      try {
        protocol = new URL(String(r.url)).protocol;
      } catch {
        protocol = null;
      }
      if (protocol !== 'https:') say(`control ${k.id}: resource link ${JSON.stringify(r.url)} is not https (NFR-SEC-11)`);
    }
  }

  for (const r of c.reasonCodes) {
    if (!/^(na|ny)_[a-z_]+$/.test(r.code)) say(`reason code ${r.code}: not na_ or ny_ followed by lower-case words`);
    else if (r.status !== (r.code.startsWith('na_') ? 'not_applicable' : 'not_yet')) say(`reason code ${r.code}: its status does not match its prefix`);
    for (const field of ['label', 'useWhen', 'reasonMustSay'] as const) {
      const v: unknown = r[field];
      if (typeof v !== 'string' || (field === 'label' && v === '')) say(`reason code ${r.code}: ${field} is not ${field === 'label' ? 'a non-empty text' : 'text'} (QC-05)`);
    }
  }
  const codes = new Set(c.reasonCodes.map((r) => r.code));
  for (const code of REQUIRED_CODES) if (!codes.has(code)) say(`reasonCodes.json has no ${code} (QC-05)`);
}

/** Ids, stems, kept fields and (risk area, control) pairs against the 4.0.0 set (FR-CNT-01, SRS 10.1.1, QC-02, R-61). */
function checkIds(questions: readonly LoadedQuestion[], base: Map<string, BaseQuestion>, actions: Action[] | null, c: LoadedContent, say: (p: string) => void): void {
  const areaControls = new Map([...c.areas.values()].map((a) => [a.id, a.controls ?? []] as const));
  const inBank = new Map(questions.map((q) => [q.id, q]));
  // For every id the version must hold: the 4.0.0 questions whose pairs it carries, and the stem it must have.
  const expected = new Map<string, { sources: string[]; text: unknown; kept: boolean }>();
  const removed = new Map<string, string>();
  if (actions === null) {
    for (const b of base.values()) expected.set(b.id, { sources: [b.id], text: b.text, kept: true });
    for (const q of questions) if (!base.has(q.id)) say(`question ${q.id}: not a 4.0.0 question, and no approved proposal adds it`);
    for (const id of base.keys()) if (!inBank.has(id)) say(`question ${id}: a 4.0.0 question missing from the bank, and no approved proposal removes it`);
  } else {
    const target = (id: string): { sources: string[]; text: unknown; kept: boolean } => {
      let t = expected.get(id);
      if (t === undefined) expected.set(id, (t = { sources: [], text: undefined, kept: false }));
      return t;
    };
    for (const a of actions) {
      if (a.action === 'keep') Object.assign(target(a.id), { text: base.get(a.id)?.text, kept: true }).sources.push(a.id);
      if (a.action === 'reword') Object.assign(target(a.id), { text: a.text, kept: true }).sources.push(a.id);
      if (a.action === 'cut') removed.set(a.id, 'the approved proposal cuts it');
      if (a.action === 'merge') {
        removed.set(a.id, `the approved proposal merges it into ${a.into}`);
        target(a.into).sources.push(a.id);
      }
      if (a.action === 'replace') {
        removed.set(a.id, `the approved proposal replaces it with ${a.newId}`);
        if (base.has(a.newId)) say(`question ${a.newId}: a replace action names it as a new id, but it is a 4.0.0 id, and an id is never reused (R-61)`);
        target(a.newId).sources.push(a.id);
      }
    }
    for (const [id, why] of removed) {
      if (inBank.has(id)) say(`question ${id}: in the bank, but ${why}`);
      if (expected.has(id)) say(`question ${id}: the approved proposal both keeps it and removes it`);
    }
    for (const q of questions) if (!expected.has(q.id) && !removed.has(q.id)) say(`question ${q.id}: not in the approved proposal`);
    for (const id of expected.keys()) if (!inBank.has(id) && !removed.has(id)) say(`question ${id}: the approved proposal keeps or adds it, but the bank does not hold it`);
  }

  for (const [id, want] of expected) {
    const q = inBank.get(id);
    if (q === undefined || removed.has(id)) continue;
    if (want.kept && q.text !== want.text) {
      say(actions === null || base.get(id)?.text === want.text
        ? `question ${id}: text differs from the 4.0.0 stem; only an approved reword changes it`
        : `question ${id}: text is not the stem its approved reword gives it`);
    }
    // A kept or reworded question that absorbs nothing keeps its 4.0.0 place, type, principle and options (10.1.1);
    // the gate's 4.0.0 yes and no options are replaced by the scope answer (FR-CNT-04).
    const b = base.get(id);
    if (want.kept && b !== undefined && want.sources.length === 1) {
      if (q.stage !== b.stage || q.moduleId !== b.moduleId) say(`question ${id}: moved from ${b.stage} module ${b.moduleId}; a kept question keeps its place`);
      if (q.type !== b.type) say(`question ${id}: type changed from ${String(b.type)}; a kept question keeps its type`);
      if (q.principle !== b.principle) say(`question ${id}: principle changed; a kept question keeps its principle`);
      if (b.type !== 'gate' && !sameList(q.options, b.options)) say(`question ${id}: options changed; a kept question keeps its options`);
    }
    const sources = want.sources.map((s) => base.get(s)).filter((s): s is BaseQuestion => s !== undefined);
    if (sources.length === 0) continue;
    const wanted = new Set(sources.flatMap((s) => [...s.pairs]));
    const actual = pairsOf(q, areaControls);
    if (!sameSet(wanted, actual)) {
      const missing = [...wanted].filter((p) => !actual.has(p));
      const extra = [...actual].filter((p) => !wanted.has(p));
      say(`question ${id}: (risk area, control) pairs differ from the 4.0.0 pairs of ${want.sources.join(', ')} (QC-02): missing [${missing.join(' ')}], extra [${extra.join(' ')}]`);
    }
  }
}

/** QC-01 (SRS line 4225; IC-6) and QC-06 (line 4231) for one question. */
function checkTexts(q: LoadedQuestion, say: (p: string) => void): void {
  const limit = (field: 'expectedPractice' | 'whyAsked' | 'reasonPrompt', min: number, max: number, sentences: number | null): void => {
    const v: unknown = q[field];
    if (typeof v !== 'string') return say(`question ${q.id}: ${field} is not text (QC-01)`);
    const n = codePoints(v);
    if (n < min || n > max) return say(`question ${q.id}: ${field} has ${n} characters; ${min} to ${max} required (QC-01)`);
    if (sentences !== null && sentenceCount(v) > sentences) say(`question ${q.id}: ${field} has ${sentenceCount(v)} sentences; at most ${sentences} allowed (QC-01)`);
  };
  limit('expectedPractice', 40, 400, null);
  limit('whyAsked', 1, 300, 2);
  limit('reasonPrompt', 1, 400, 4);
  const ex: unknown = q.evidenceExamples;
  if (!Array.isArray(ex) || ex.length < 1 || ex.length > 4) {
    say(`question ${q.id}: evidenceExamples has ${Array.isArray(ex) ? ex.length : 'no list of'} items; 1 to 4 required (QC-01)`);
  } else {
    const empty = ex.findIndex((e) => typeof e !== 'string' || e.trim() === '');
    if (empty >= 0) say(`question ${q.id}: evidenceExamples[${empty}] is empty (QC-01)`);
  }
  if (q.id.includes('-EXTRA-') && typeof q.helpText === 'string' && q.helpText.startsWith('When ')) {
    say(`question ${q.id}: helpText begins with "When " (QC-06)`);
  }
}

/** For each batch, its latest record (by `at`) must match the current texts (FR-CNT-02); malformed records are named. */
function checkSignOffs(c: LoadedContent, records: readonly unknown[], say: (p: string) => void): void {
  const latest = new Map<SignOffBatch, { at: number; record: Json; index: number }>();
  records.forEach((r, i) => {
    const where = `signoffs.json records[${i}]`;
    if (!isRecord(r)) return say(`${where} is not an object`);
    const batch = r.batch;
    if (typeof batch !== 'string' || !(BATCHES as readonly string[]).includes(batch)) return say(`${where}: batch ${JSON.stringify(batch)} is not one of the seven batches`);
    const label = `${where} (${batch})`;
    let ok = true;
    if (typeof r.approver !== 'string' || r.approver.trim() === '') { say(`${label}: approver is empty`); ok = false; }
    const at = typeof r.at === 'string' && ISO_TIME.test(r.at) ? Date.parse(r.at) : NaN;
    if (Number.isNaN(at)) { say(`${label}: at ${JSON.stringify(r.at)} is not an ISO time with a zone`); ok = false; }
    if (typeof r.sha256 !== 'string' || !SHA256.test(r.sha256)) { say(`${label}: sha256 is not 64 lowercase hexadecimal digits`); ok = false; }
    if (!Array.isArray(r.items) || r.items.some((x) => typeof x !== 'string')) { say(`${label}: items is not a list of texts`); ok = false; }
    if (!ok) return;
    const prev = latest.get(batch as SignOffBatch);
    if (prev === undefined || at >= prev.at) latest.set(batch as SignOffBatch, { at, record: r, index: i });
  });
  for (const batch of BATCHES) {
    const l = latest.get(batch);
    if (l === undefined) {
      say(`sign-off ${batch}: no record`);
      continue;
    }
    let payload: ReturnType<typeof signOffPayload>;
    let hash: string;
    try {
      payload = signOffPayload(c, batch);
      hash = signOffHash(payload);
    } catch (e) {
      say(`sign-off ${batch}: the current texts cannot be hashed (${(e as Error).message})`);
      continue;
    }
    if (l.record.sha256 !== hash) say(`sign-off ${batch}: sha256 of records[${l.index}] does not match the current texts`);
    if (!sameList(l.record.items, signOffItems(payload))) say(`sign-off ${batch}: items of records[${l.index}] do not match the batch`);
  }
}

