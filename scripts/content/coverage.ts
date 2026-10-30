/**
 * Coverage proof for the question-set revision (SRS 10.1.0 step 2, CW-00; acceptance QC-02).
 *
 * Reads the v0.5.0 bank, the areas file, a `QuestionSetProposal` and the document field maps,
 * and reports (a) what fails the SRS 10.1.0 step 2 list and (b) what it only lists. It keeps no
 * state and writes no file; `question-set-coverage.ts` is its command line.
 *
 * The inputs are typed structurally (the fields the check reads), so the d13be0c files, which have
 * no `expectedPractice` and the like, and the 5.0.0 `QuestionBankFile`, `AreasFile` and `FieldMap`
 * of `types/content.ts` and `types/documents.ts` (K0b-1) all fit.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DocumentType, OptionMapping, QuestionSetProposal, RevisionAction, Stage } from './types';

export const STAGES: readonly Stage[] = ['pre-processing', 'in-processing', 'post-processing'];
/** The three documents of v1 (SRS 10.3.2 to 10.3.4); the data-sharing annex is out of v1. */
export const DOCUMENT_TYPES: readonly DocumentType[] = ['data_card', 'model_card', 'mitigation_plan'];

/** The five things a proposal can do to a v0.5.0 question. */
export const ACTION_KINDS: readonly string[] = ['keep', 'reword', 'merge', 'cut', 'replace'];
/** The source kinds of a field map (contract `FieldSource`, `types/documents.ts`). */
export const FIELD_SOURCE_KINDS: readonly string[] = [
  'record',
  'record_option',
  'findings',
  'mitigations',
  'accepted_risks',
  'project',
  'typed',
  'meta',
  'mapping',
];
const QUESTION_TYPES: readonly string[] = ['likert-5', 'checklist', 'gate'];

export interface CoverageQuestion {
  id: string;
  type: string;
  text: string;
  gaps: string[];
  options?: string[];
  optionGapMap?: Record<string, Array<string | OptionMapping>>;
  condition?: { questionId: string };
}
export interface CoverageBank {
  stages: Record<Stage, { modules: Array<{ id: string; questions: CoverageQuestion[] }> }>;
}
export interface CoverageArea {
  id: string;
  stage: Stage;
  controls?: string[];
}
export interface CoverageAreas {
  areas: CoverageArea[];
  controls: Array<{ id: string }>;
}
export interface CoverageFieldSource {
  kind: string;
  questionId?: string;
  option?: string;
  /** The rest of the contract's `FieldSource` (types/documents.ts), read only to show a field's sources. */
  parts?: string[];
  field?: string;
  structured?: string;
  stage?: string;
  filter?: string;
  areas?: string[];
  item?: string;
}
export interface CoverageFieldMap {
  documentType: string;
  fields: Array<{ fieldId: string; label: string; sources: CoverageFieldSource[] }>;
}

export interface CoverageInput {
  bank: CoverageBank;
  areas: CoverageAreas;
  proposal: QuestionSetProposal;
  maps: CoverageFieldMap[];
  srsText?: string;
}
export interface CoverageResult {
  failures: string[];
  affectedSrsIds: string[];
  thinnedAreas: Array<{ area: string; stage: Stage; before: number; after: number }>;
}

type Mapping = { gaps: string[]; optionGapMap?: Record<string, Array<string | OptionMapping>> };

/** The risk areas a question maps to, the FULL reading: its `gaps` and every area of its `optionGapMap`. */
export function questionAreas(m: Mapping): Set<string> {
  const out = new Set<string>(m.gaps);
  if (m.optionGapMap) {
    for (const entries of Object.values(m.optionGapMap)) {
      for (const e of entries) out.add(typeof e === 'string' ? e : e.area);
    }
  }
  return out;
}

export interface BaseQuestion {
  id: string;
  stage: Stage;
  type: string;
  text: string;
  areas: Set<string>;
  options?: string[];
  conditionOn?: string;
}

/** Every question of the bank in content order: stage, module, question. */
export function baseQuestions(bank: CoverageBank): BaseQuestion[] {
  const out: BaseQuestion[] = [];
  for (const stage of STAGES) {
    for (const mod of bank.stages[stage].modules) {
      for (const q of mod.questions) {
        out.push({
          id: q.id,
          stage,
          type: q.type,
          text: q.text,
          areas: questionAreas(q),
          options: q.options,
          conditionOn: q.condition?.questionId,
        });
      }
    }
  }
  return out;
}

function areaControlLists(areas: CoverageAreas): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const a of areas.areas) {
    if (a.controls === undefined) throw new Error(`area ${a.id} has no controls list`);
    out.set(a.id, a.controls);
  }
  return out;
}

function pairsOf(id: string, mapped: Set<string>, controlsOf: Map<string, string[]>): Set<string> {
  const controls = new Set<string>();
  for (const area of mapped) {
    const list = controlsOf.get(area);
    if (list === undefined) throw new Error(`question ${id} maps to risk area ${area}, which the areas file lacks`);
    for (const c of list) controls.add(c);
  }
  return controls;
}

/** Question id to the controls reachable from it through its risk areas (315 pairs in v0.5.0). */
export function questionControlPairs(bank: CoverageBank, areas: CoverageAreas): Map<string, Set<string>> {
  const controlsOf = areaControlLists(areas);
  const out = new Map<string, Set<string>>();
  for (const q of baseQuestions(bank)) out.set(q.id, pairsOf(q.id, q.areas, controlsOf));
  return out;
}

function unknownKindMessage(a: { id: string }): string {
  return `action of ${a.id} is '${String((a as { action?: unknown }).action)}', not one of ${ACTION_KINDS.join(', ')}`;
}

/**
 * Actions by question id for a caller that needs a clean proposal (the table renderer): throws on a question
 * with two actions and on an action kind that is none of the five, so a typo cannot drop a question quietly.
 */
export function indexActions(proposal: QuestionSetProposal): Map<string, RevisionAction> {
  const out = new Map<string, RevisionAction>();
  for (const a of proposal.actions) {
    if (!ACTION_KINDS.includes(a.action)) throw new Error(unknownKindMessage(a));
    if (out.has(a.id)) throw new Error(`${a.id} has more than one action`);
    out.set(a.id, a);
  }
  return out;
}

export interface RevisedQuestion {
  id: string;
  stage: Stage;
  areas: Set<string>;
}

/**
 * The questions content 5.0.0 would hold, in content order. A kept or reworded question keeps its
 * mapping, a merge survivor takes its `survivors` entry, a replacement takes the `NewQuestion` in its
 * predecessor's place; a cut or merged-away question is gone. A malformed proposal still resolves
 * (the structural checks of `checkCoverage` report what is wrong with it).
 */
export function reviseQuestions(bank: CoverageBank, proposal: QuestionSetProposal): RevisedQuestion[] {
  const actionById = new Map<string, RevisionAction>();
  for (const a of proposal.actions) {
    if (!ACTION_KINDS.includes(a.action)) throw new Error(unknownKindMessage(a));
    if (!actionById.has(a.id)) actionById.set(a.id, a);
  }
  const survivorById = new Map(proposal.survivors.map((s) => [s.id, s]));
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const absorbers = new Set<string>();
  for (const a of proposal.actions) if (a.action === 'merge') absorbers.add(a.into);

  const out: RevisedQuestion[] = [];
  for (const q of baseQuestions(bank)) {
    const a = actionById.get(q.id);
    if (a === undefined) continue;
    if (a.action === 'keep' || a.action === 'reword') {
      const survivor = absorbers.has(q.id) ? survivorById.get(q.id) : undefined;
      out.push({ id: q.id, stage: q.stage, areas: survivor ? questionAreas(survivor) : q.areas });
    } else if (a.action === 'replace') {
      const n = newById.get(a.newId);
      if (n !== undefined) out.push({ id: n.id, stage: n.stage, areas: questionAreas(n) });
    }
  }
  return out;
}

/** Question id to controls, for the questions of the revised set. Throws on a risk area the areas file lacks. */
export function revisedQuestionControlPairs(
  bank: CoverageBank,
  areas: CoverageAreas,
  proposal: QuestionSetProposal,
): Map<string, Set<string>> {
  const controlsOf = areaControlLists(areas);
  const out = new Map<string, Set<string>>();
  for (const q of reviseQuestions(bank, proposal)) out.set(q.id, pairsOf(q.id, q.areas, controlsOf));
  return out;
}

const SRS_SCANNED_SECTION = /^## (?:3|4|7|12)\. /;
const SRS_QUESTION_ID = /Q-[A-Z]{1,2}-[A-Z0-9]+(?:-[A-Z0-9]+)*/g;

/** `Q-IP-EXTRA-01/02` names two ids and `Q-PO-EXTRA-01..04` four; a plain scan would see one of each. */
function expandShorthand(id: string, rest: string): string[] {
  const m = /^(.*-)(\d+)$/.exec(id);
  if (m === null) return [id];
  const [, prefix, digits] = m;
  const width = digits.length;
  const slash = /^((?:\/\d+)+)/.exec(rest);
  if (slash !== null) {
    return [id, ...slash[1].split('/').filter((d) => d !== '').map((d) => prefix + d.padStart(width, '0'))];
  }
  const range = /^\.\.(\d+)/.exec(rest);
  if (range !== null && Number(range[1]) >= Number(digits)) {
    const ids: string[] = [];
    for (let n = Number(digits); n <= Number(range[1]); n += 1) ids.push(prefix + String(n).padStart(width, '0'));
    return ids;
  }
  return [id];
}

/**
 * Question ids named in sections 3, 4, 7 and 12 of the SRS (the `## N.` headings; a section runs to the
 * next `## ` heading, sub-sections included), each with the 1-based lines that name it.
 */
export function scanSrsIds(srsText: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  let inScope = false;
  srsText.split('\n').forEach((line, index) => {
    if (line.startsWith('## ')) inScope = SRS_SCANNED_SECTION.test(line);
    if (!inScope) return;
    for (const m of line.matchAll(SRS_QUESTION_ID)) {
      for (const id of expandShorthand(m[0], line.slice((m.index as number) + m[0].length))) {
        const lines = found.get(id);
        if (lines === undefined) found.set(id, [index + 1]);
        else if (lines[lines.length - 1] !== index + 1) lines.push(index + 1);
      }
    }
  });
  return found;
}

/** Which of the sections 3, 4, 7 and 12 the text has (`## N.` headings), so a wrong file is told from a clean result. */
export function scanSrsSections(srsText: string): number[] {
  const found = new Set<number>();
  for (const line of srsText.split('\n')) {
    const m = /^## (3|4|7|12)\. /.exec(line);
    if (m !== null) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** True when this module is the one `node`/`tsx` was started on, also through a symlinked path. */
export function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
}

function removalOf(a: RevisionAction): string | null {
  switch (a.action) {
    case 'cut':
      return 'cut';
    case 'merge':
      return `merged into ${a.into}`;
    case 'replace':
      return `replaced by ${a.newId}`;
    case 'keep':
    case 'reword':
      return null;
    default:
      throw new Error(unknownKindMessage(a));
  }
}

const shown = (id: string): string => (/\s/.test(id) ? `'${id}'` : id);

/**
 * An `optionGapMap` is read by the engine only on a checklist (components/report/useFindingsData.ts:269), and
 * only options the question offers can be ticked, so a map elsewhere maps areas no answer can evidence.
 */
function optionMapProblems(
  who: string,
  type: string,
  options: string[] | undefined,
  optionGapMap: Record<string, unknown> | undefined,
): string[] {
  if (optionGapMap === undefined) return [];
  if (type !== 'checklist') return [`${who} carries an optionGapMap, but it is not a checklist`];
  const offered = new Set(options);
  return Object.keys(optionGapMap)
    .filter((k) => !offered.has(k))
    .map((k) => `${who} maps option '${k}', which the question does not offer`);
}

/**
 * Checks a proposal against the base. It does not check that the bank is the file the proposal names
 * (`proposal.base.sha256`) or that every document has a field map: those belong to the command line, and a
 * caller that skips them with `maps: []` gets a field check that has nothing to read.
 */
export function checkCoverage(i: CoverageInput): CoverageResult {
  const { bank, areas, proposal, maps, srsText } = i;
  const failures: string[] = [];
  const fail = (message: string): void => {
    if (!failures.includes(message)) failures.push(message);
  };

  // A base question that maps to an unknown area is corrupt input, not a proposal defect: stop.
  questionControlPairs(bank, areas);
  const controlsOf = areaControlLists(areas);
  const areaIds = new Set(areas.areas.map((a) => a.id));
  const base = baseQuestions(bank);
  const baseById = new Map(base.map((q) => [q.id, q]));

  // 1. One action per base id, exactly.
  const actionById = new Map<string, RevisionAction>();
  const duplicated = new Set<string>();
  let unknownKind = false;
  for (const a of proposal.actions) {
    if (!baseById.has(a.id)) fail(`action names ${a.id}, which is not a v0.5.0 question`);
    if (!ACTION_KINDS.includes(a.action)) {
      fail(unknownKindMessage(a));
      unknownKind = true;
    }
    if (actionById.has(a.id)) duplicated.add(a.id);
    else actionById.set(a.id, a);
  }
  for (const id of duplicated) fail(`${id} has more than one action`);
  for (const q of base) if (!actionById.has(q.id)) fail(`no action for v0.5.0 question ${q.id}`);
  // An action of unknown kind cannot be resolved into a revised set: report it and stop here.
  if (unknownKind) return { failures, affectedSrsIds: [], thinnedAreas: [] };
  for (const a of actionById.values()) {
    if (a.action === 'reword' && (typeof a.text !== 'string' || a.text.trim() === '')) fail(`reword of ${a.id} has no text`);
  }
  // R-61: a proposal states the stem it revises; a stem that is not the v0.5.0 one means the wrong input.
  for (const a of actionById.values()) {
    const q = baseById.get(a.id);
    if (q !== undefined && q.text !== a.originalText) fail(`originalText of ${a.id} is not the v0.5.0 stem`);
  }

  // 2. Replacements: a new id is new, appears once, has its NewQuestion, and stays in its stage's series.
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const replaceCount = new Map<string, number>();
  for (const a of proposal.actions) {
    if (a.action === 'replace') replaceCount.set(a.newId, (replaceCount.get(a.newId) ?? 0) + 1);
  }
  for (const a of proposal.actions) {
    if (a.action !== 'replace') continue;
    if ((replaceCount.get(a.newId) as number) > 1) fail(`new id ${a.newId} is named by more than one replace`);
    const series = /^(Q-[A-Z]{1,2}-)/.exec(a.id);
    if (series === null) throw new Error(`cannot read the id series of v0.5.0 question ${a.id}`);
    if (!new RegExp(`^${series[1]}\\d+$`).test(a.newId)) {
      fail(`new id ${shown(a.newId)} is not in the ${series[1]}nn series of ${a.id}`);
    }
    const n = newById.get(a.newId);
    if (n === undefined) {
      fail(`replace of ${a.id} names new id ${a.newId}, but newQuestions has no entry for it`);
      continue;
    }
    const replaced = baseById.get(a.id);
    if (replaced !== undefined && replaced.stage !== n.stage) {
      fail(`new id ${n.id} is in stage ${n.stage} but replaces ${a.id} of ${replaced.stage}`);
    }
  }
  const seenNew = new Set<string>();
  for (const n of proposal.newQuestions) {
    if (seenNew.has(n.id)) fail(`newQuestions holds ${n.id} more than once`);
    seenNew.add(n.id);
    if (baseById.has(n.id)) fail(`new id ${n.id} reuses a v0.5.0 id`);
    if (!replaceCount.has(n.id)) fail(`newQuestions holds ${n.id}, which no replace names`);
    if (typeof n.text !== 'string' || n.text.trim() === '') fail(`new question ${n.id} has no text`);
    // Content 5.0.0 requires a principle label on every question (contract ContentQuestion and NewQuestion).
    if (typeof n.principle !== 'string' || n.principle.trim() === '') fail(`new question ${n.id} has no principle`);
    if (!Array.isArray(n.gaps)) fail(`new question ${n.id} has no gaps list`);
    if (!QUESTION_TYPES.includes(n.type)) {
      fail(`new question ${n.id} has type '${String(n.type)}', which is not likert-5, checklist or gate`);
    }
    const stageModules = bank.stages[n.stage];
    if (stageModules === undefined) fail(`new question ${n.id} has stage '${String(n.stage)}', which is not a stage`);
    else if (!stageModules.modules.some((m) => m.id === n.moduleId)) {
      fail(`new question ${n.id} names module ${n.moduleId}, which ${n.stage} does not have`);
    }
    for (const area of questionAreas(n)) {
      if (!areaIds.has(area)) fail(`new question ${n.id} maps risk area ${area}, which is not in the areas file`);
    }
    optionMapProblems(`new question ${n.id}`, n.type, n.options, n.optionGapMap).forEach(fail);
  }

  // 3. Merges: the survivor is kept, has an entry, and maps exactly the union of what it absorbs.
  const absorbedInto = new Map<string, string[]>();
  for (const a of actionById.values()) {
    if (a.action !== 'merge') continue;
    const list = absorbedInto.get(a.into);
    if (list === undefined) absorbedInto.set(a.into, [a.id]);
    else list.push(a.id);
    const target = actionById.get(a.into);
    if (a.into === a.id) fail(`merge of ${a.id} names itself as survivor`);
    else if (!baseById.has(a.into)) fail(`merge of ${a.id} into ${a.into}, which is not a v0.5.0 question`);
    else if (target !== undefined && target.action === 'cut') fail(`merge of ${a.id} into ${a.into}, which the proposal cuts`);
    else if (target !== undefined && target.action === 'merge') fail(`merge of ${a.id} into ${a.into}, which the proposal merges away`);
    else if (target !== undefined && target.action === 'replace') fail(`merge of ${a.id} into ${a.into}, which the proposal replaces`);
    // The owner approves, and each stage is sealed, stage by stage: a merge across stages is in no one sitting whole.
    const from = baseById.get(a.id);
    const to = baseById.get(a.into);
    if (from !== undefined && to !== undefined && from.stage !== to.stage) {
      fail(`merge of ${a.id} (${from.stage}) into ${a.into} (${to.stage}) crosses stages`);
    }
  }
  const survivorById = new Map<string, (typeof proposal.survivors)[number]>();
  for (const s of proposal.survivors) {
    if (survivorById.has(s.id)) fail(`survivors names ${s.id} more than once`);
    else survivorById.set(s.id, s);
    if (!absorbedInto.has(s.id)) fail(`survivors names ${s.id}, which no merge absorbs into`);
  }
  for (const [into, absorbed] of absorbedInto) {
    const target = actionById.get(into);
    if (target === undefined || (target.action !== 'keep' && target.action !== 'reword')) continue;
    const entry = survivorById.get(into);
    if (entry === undefined) {
      fail(`merge survivor ${into} has no entry in survivors`);
      continue;
    }
    const actual = questionAreas(entry);
    const survivorBase = baseById.get(into);
    if (survivorBase !== undefined) {
      optionMapProblems(`merge survivor ${into}`, survivorBase.type, survivorBase.options, entry.optionGapMap).forEach(fail);
    }
    for (const area of actual) {
      if (!areaIds.has(area)) fail(`merge survivor ${into} maps risk area ${area}, which is not in the areas file`);
    }
    const union = new Map<string, string>(); // area -> the question that brought it
    for (const id of [into, ...absorbed]) {
      for (const area of baseById.get(id)?.areas ?? []) if (!union.has(area)) union.set(area, id);
    }
    for (const [area, source] of union) {
      if (!actual.has(area)) fail(`merge survivor ${into} lacks risk area ${area} of ${source}`);
    }
    for (const area of actual) {
      if (areaIds.has(area) && !union.has(area)) {
        fail(`merge survivor ${into} maps risk area ${area}, outside the union of the merged questions`);
      }
    }
  }

  // 4. Coverage: every risk area mapped from a kept question, every control reachable from one.
  const revised = reviseQuestions(bank, proposal);
  const covered = new Set<string>();
  for (const q of revised) for (const area of q.areas) covered.add(area);
  for (const a of areas.areas) if (!covered.has(a.id)) fail(`risk area ${a.id} is mapped from no kept question`);
  const reachable = new Set<string>();
  for (const area of covered) for (const c of controlsOf.get(area) ?? []) reachable.add(c);
  for (const c of areas.controls) if (!reachable.has(c.id)) fail(`control ${c.id} is unreachable from the kept questions`);

  // 5. Document fields: none reads a removed question without a re-point; every re-point is sound.
  const removal = new Map<string, string>();
  for (const a of actionById.values()) {
    const why = removalOf(a);
    if (why !== null) removal.set(a.id, why);
  }
  const finalIds = new Set(revised.map((q) => q.id));
  // The gate-dependent questions keep their condition in 5.0.0 (SRS line 3916); the other unlock rules go.
  for (const q of base) {
    const gate = q.conditionOn === undefined ? undefined : baseById.get(q.conditionOn);
    if (gate !== undefined && gate.type === 'gate' && finalIds.has(q.id) && removal.has(gate.id)) {
      fail(`question ${q.id} depends on gate ${gate.id}, which the proposal removes`);
    }
  }
  const repointKeys = new Set(proposal.repoints.map((r) => `${r.documentType}|${r.fieldId}|${r.from}`));
  const fieldReads = new Map<string, Set<string>>(); // "doc|field" -> question ids it reads
  for (const map of maps) {
    for (const field of map.fields) {
      const reads = new Set<string>();
      const where = `field ${map.documentType} ${field.fieldId}`;
      for (const s of field.sources) {
        if (!FIELD_SOURCE_KINDS.includes(s.kind)) {
          fail(`${where} has a source of kind '${s.kind}', which is not a field-source kind`);
        } else if (s.kind === 'record' || s.kind === 'record_option') {
          if (typeof s.questionId !== 'string') fail(`${where} has a ${s.kind} source with no questionId`);
          else reads.add(s.questionId);
          if (s.kind === 'record_option' && typeof s.option !== 'string') fail(`${where} has a record_option source with no option`);
        }
      }
      fieldReads.set(`${map.documentType}|${field.fieldId}`, reads);
      for (const qid of reads) {
        const why = removal.get(qid);
        if (!baseById.has(qid) && !finalIds.has(qid)) {
          fail(`field ${map.documentType} ${field.fieldId} reads ${qid}, which is not a v0.5.0 question`);
        } else if (why !== undefined && !repointKeys.has(`${map.documentType}|${field.fieldId}|${qid}`)) {
          fail(`field ${map.documentType} ${field.fieldId} reads ${qid} (${why}) and has no re-point`);
        }
      }
    }
  }
  const seenRepoints = new Set<string>();
  for (const r of proposal.repoints) {
    const key = `${r.documentType}|${r.fieldId}|${r.from}`;
    const head = `re-point ${r.documentType} ${r.fieldId}`;
    if (seenRepoints.has(key)) fail(`${head} from ${r.from} is listed twice`);
    seenRepoints.add(key);
    const reads = fieldReads.get(`${r.documentType}|${r.fieldId}`);
    if (reads === undefined) fail(`${head} names a field no field map holds`);
    else if (!reads.has(r.from)) fail(`${head} takes the field from ${r.from}, which the field does not read`);
    else if (!removal.has(r.from)) fail(`${head} takes the field from ${r.from}, which the proposal keeps`);
    if (r.to !== 'typed_only' && !finalIds.has(r.to)) fail(`${head} points to ${r.to}, which is not a kept question`);
  }

  // 6. Listed, not failed: risk areas whose question count falls in a stage. Counted per stage of the questions,
  // because questions reach areas of other stages (SRS CG-13) and the owner reads the list stage by stage.
  const count = (questions: Array<{ stage: Stage; areas: Set<string> }>, stage: Stage, area: string): number =>
    questions.filter((q) => q.stage === stage && q.areas.has(area)).length;
  const thinnedAreas: CoverageResult['thinnedAreas'] = [];
  for (const stage of STAGES) {
    for (const a of areas.areas) {
      const before = count(base, stage, a.id);
      const after = count(revised, stage, a.id);
      if (after < before) thinnedAreas.push({ area: a.id, stage, before, after });
    }
  }

  // 7. Listed, not failed: SRS-named ids the proposal cuts, merges or replaces.
  const affectedSrsIds: string[] = [];
  if (srsText !== undefined) {
    for (const id of scanSrsIds(srsText).keys()) if (removal.has(id)) affectedSrsIds.push(id);
    affectedSrsIds.sort();
  }

  return { failures, affectedSrsIds, thinnedAreas };
}

/** Reads every `*.json` of a field-map directory (C-MAP's `data/fieldmaps/`), sorted by file name. */
export function readFieldMaps(dir: string): CoverageFieldMap[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      const m = parsed as Partial<CoverageFieldMap> | null;
      if (m === null || typeof m !== 'object' || typeof m.documentType !== 'string' || !Array.isArray(m.fields)) {
        throw new Error(`${path.join(dir, f)} is not a field map (documentType and fields are required)`);
      }
      return m as CoverageFieldMap;
    });
}
