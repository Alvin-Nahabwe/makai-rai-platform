/**
 * Readable tables of the question-set proposal, one Markdown file per stage, for the owner's sitting
 * (SRS 10.1.0 step 4). Each file ends with the stage's batch hash: the SHA-256 of the canonical JSON of the
 * `question-set:<stage>` sign-off payload, the approved stems in content order (contract
 * `lib/content/signoffs.ts`, `SignOffPayload`; FR-CNT-02).
 *
 *   npx tsx scripts/content/render-tables.ts question-set <proposal> <out-dir> [--bank <f>] [--fieldmaps <dir>] [--areas <f>]
 *   npx tsx scripts/content/render-tables.ts texts <version> <out-dir>
 *
 * `texts` renders, from the loaded content `<version>`, one file per stage with each question's texts, and
 * `help-and-reason-codes.md` with the document help lines and the reason codes. Every file is built from
 * `signOffPayload` of its batch and ends with that batch's hash, so a table shows exactly what the owner's approval signs.
 *
 * Without `--bank` the v0.5.0 bank is read with `git show <base.commit>:<base.file>` and must hash to
 * `proposal.base.sha256`. `--fieldmaps` adds the field labels to the re-pointed fields. `--areas` runs the coverage
 * check first (with the field maps, when given) and refuses to render a proposal that fails it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '@/lib/integrity/canonical.mjs';
import { loadContent } from '@/lib/content/loader';
import { signOffHash, signOffPayload, type QuestionSetBatch, type SignOffPayload } from '@/lib/content/signoffs';
import type { AnswerKey, LoadedContent } from '@/types/content';
import type { Stage } from '@/types/record';

import {
  baseQuestions,
  checkCoverage,
  indexActions,
  isMainModule,
  readFieldMaps,
  STAGES,
  type BaseQuestion,
  type CoverageAreas,
  type CoverageBank,
  type CoverageFieldMap,
  type CoverageFieldSource,
} from './coverage';
import type { FieldRepoint, QuestionSetProposal, RevisionAction } from './types';

export interface QuestionSetPayload {
  batch: `question-set:${Stage}`;
  questions: Array<{ id: string; text: string }>;
}

/**
 * The approved stems of a stage in content order: v0.5.0 order with merged and cut questions gone and a
 * replacement standing in its predecessor's place. Throws on a question with no action, two actions, an action
 * of unknown kind or a replace with no new question; it does not run the coverage check itself.
 */
export function questionSetPayload(bank: CoverageBank, proposal: QuestionSetProposal, stage: Stage): QuestionSetPayload {
  const actionById = indexActions(proposal);
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const questions: QuestionSetPayload['questions'] = [];
  for (const q of baseQuestions(bank).filter((b) => b.stage === stage)) {
    const a = actionById.get(q.id);
    if (a === undefined) throw new Error(`no action for ${q.id}`);
    if (a.action === 'keep') questions.push({ id: q.id, text: q.text });
    else if (a.action === 'reword') questions.push({ id: q.id, text: a.text });
    else if (a.action === 'replace') {
      const n = newById.get(a.newId);
      if (n === undefined) throw new Error(`no new question ${a.newId} for the replace of ${q.id}`);
      questions.push({ id: n.id, text: n.text });
    }
  }
  return { batch: `question-set:${stage}`, questions };
}

export function questionSetBatchHash(bank: CoverageBank, proposal: QuestionSetProposal, stage: Stage): string {
  return createHash('sha256').update(canonicalJson(questionSetPayload(bank, proposal, stage)), 'utf8').digest('hex');
}

const ANSWER_KEYS: readonly AnswerKey[] = ['done', 'partly', 'not_yet', 'not_applicable'];

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

/**
 * The kind of a v0.5.0 question as SRS 10.1.8 names it, which the owner reads to see what OD-08 and OD-09
 * touch: a follow-up (an `-EXTRA-` id), a gate-dependent question (its condition names the gate), the gate,
 * a checklist, or a practice question.
 */
export function questionKind(q: BaseQuestion, baseById: ReadonlyMap<string, BaseQuestion>): string {
  if (q.id.includes('-EXTRA-')) return 'follow-up';
  if (q.conditionOn !== undefined && baseById.get(q.conditionOn)?.type === 'gate') return 'gate-dependent';
  if (q.type === 'gate') return 'gate';
  if (q.type === 'checklist') return 'checklist';
  return 'practice';
}

/**
 * A field's sources after the proposal's re-points of that field, by C-MAP's rule (units/C-MAP.md, CW-11b): a
 * re-point to a question replaces the question id and keeps the parts and the option; a re-point to
 * `typed_only` removes the sources naming the old question and adds one typed source unless one remains.
 */
export function sourcesAfterRepoints(sources: readonly CoverageFieldSource[], repoints: readonly FieldRepoint[]): CoverageFieldSource[] {
  let out = sources.map((s) => ({ ...s }));
  for (const r of repoints) {
    if (r.to === 'typed_only') {
      out = out.filter((s) => s.questionId !== r.from);
      if (!out.some((s) => s.kind === 'typed')) out.push({ kind: 'typed' });
    } else {
      out = out.map((s) => (s.questionId === r.from ? { ...s, questionId: r.to } : s));
    }
  }
  return out;
}

/** One field source in words, for the owner's table. */
export function describeSource(s: CoverageFieldSource): string {
  switch (s.kind) {
    case 'record':
      return s.parts === undefined || s.parts.length === 0 ? `${s.questionId}` : `${s.questionId} ${s.parts.join(', ')}`;
    case 'record_option':
      return `${s.questionId} option '${s.option}'`;
    case 'typed':
      return s.structured === undefined ? 'typed' : `typed (${s.structured})`;
    case 'project':
      return `project: ${s.field}`;
    case 'findings':
      return `findings (${s.stage}, ${s.filter}${s.areas === undefined ? '' : `, ${s.areas.join(', ')}`})`;
    case 'mitigations':
      return `mitigations (${s.stage}, ${s.filter})`;
    case 'accepted_risks':
      return `accepted risks (${s.stage})`;
    case 'meta':
      return `meta: ${s.item}`;
    case 'mapping':
      return 'framework mapping';
    default:
      throw new Error(`field source of kind '${s.kind}' is not a field-source kind`);
  }
}

export function renderQuestionSetTables(i: {
  bank: CoverageBank;
  proposal: QuestionSetProposal;
  maps?: CoverageFieldMap[];
  /** When given, the coverage check runs first and a failing proposal is not rendered. */
  areas?: CoverageAreas;
}): Record<Stage, string> {
  const { bank, proposal } = i;
  if (i.areas !== undefined) {
    const { failures } = checkCoverage({ bank, areas: i.areas, proposal, maps: i.maps ?? [] });
    if (failures.length > 0) throw new Error(`the proposal fails the coverage check:\n${failures.join('\n')}`);
  }
  const base = baseQuestions(bank);
  const baseById = new Map(base.map((q) => [q.id, q]));
  const stageOf = new Map(base.map((q) => [q.id, q.stage]));
  const actionById = indexActions(proposal);
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const fieldOf = new Map<string, CoverageFieldMap['fields'][number]>();
  for (const m of i.maps ?? []) for (const f of m.fields) fieldOf.set(`${m.documentType}|${f.fieldId}`, f);
  // With field maps given, a re-point must name a field they hold; without them the table says the maps are missing.
  const afterOf = (r: FieldRepoint): string => {
    if (i.maps === undefined) return 'field maps not given';
    const field = fieldOf.get(`${r.documentType}|${r.fieldId}`);
    if (field === undefined) throw new Error(`re-point ${r.documentType} ${r.fieldId} names a field the field maps lack`);
    const ofField = proposal.repoints.filter((x) => x.documentType === r.documentType && x.fieldId === r.fieldId);
    return sourcesAfterRepoints(field.sources, ofField).map(describeSource).join('; ');
  };

  // A disputed item belongs to the stage of its question (a replacement's new id to the new question's stage);
  // a decision (OD-08, OD-09, OD-C3) belongs to every stage; anything else is a mistake in the proposal.
  const disputedStages = (id: string): readonly Stage[] => {
    const own = stageOf.get(id) ?? newById.get(id)?.stage;
    if (own !== undefined) return [own];
    if (Object.keys(proposal.decisions).includes(id)) return STAGES;
    throw new Error(`disputed item ${id} is neither a question of the proposal nor one of its decisions`);
  };
  for (const d of proposal.disputed) disputedStages(d.id);

  const out = {} as Record<Stage, string>;
  for (const stage of STAGES) {
    const rows = base.filter((q) => q.stage === stage);
    const stageActions = rows.map((q) => actionById.get(q.id) as RevisionAction);
    const tally = (action: string): number => stageActions.filter((a) => a.action === action).length;
    const payload = questionSetPayload(bank, proposal, stage);
    const lines: string[] = [];

    lines.push(`# Question set 5.0.0, ${stage}: proposed revision`, '');
    lines.push(
      `Proposal status: ${proposal.status}. Base: ${proposal.base.commit} ${proposal.base.file} (sha256 ${proposal.base.sha256}).`,
      '',
      `${rows.length} questions in v0.5.0, ${payload.questions.length} proposed: keep ${tally('keep')}, reword ${tally('reword')}, ` +
        `merge ${tally('merge')}, cut ${tally('cut')}, replace ${tally('replace')}.`,
      '',
      '| Id | Kind | Action | Reason | New stem or survivor |',
      '|---|---|---|---|---|',
    );
    for (const q of rows) {
      const a = actionById.get(q.id) as RevisionAction;
      let detail = '';
      if (a.action === 'reword') detail = a.text;
      else if (a.action === 'merge') detail = `Merged into ${a.into}`;
      else if (a.action === 'cut') detail = 'Removed';
      else if (a.action === 'replace') detail = `${a.newId}: ${newById.get(a.newId)?.text}`;
      lines.push(`| ${q.id} | ${questionKind(q, baseById)} | ${a.action} | ${cell(a.reason)} | ${cell(detail)} |`);
    }
    lines.push('');

    const repoints = proposal.repoints.filter((r) => stageOf.get(r.from) === stage);
    lines.push('## Document fields re-pointed in this stage', '');
    if (repoints.length === 0) {
      lines.push('No document field is re-pointed in this stage.', '');
    } else {
      lines.push(
        '| Document | Field | Label | Old source | New source | Sources after the re-point |',
        '|---|---|---|---|---|---|',
      );
      for (const r of repoints) {
        const label = fieldOf.get(`${r.documentType}|${r.fieldId}`)?.label ?? '-';
        const to = r.to === 'typed_only' ? 'typed only' : r.to;
        lines.push(`| ${r.documentType} | ${r.fieldId} | ${cell(label)} | ${r.from} | ${to} | ${cell(afterOf(r))} |`);
      }
      lines.push('');
    }

    lines.push('## Proposed decisions', '');
    for (const [id, text] of Object.entries(proposal.decisions)) lines.push(`**${id}.** ${cell(text)}`, '');

    const disputed = proposal.disputed.filter((d) => disputedStages(d.id).includes(stage));
    if (disputed.length > 0) {
      lines.push('## Still disputed after the revision', '', '| Id | Proposer | Checker |', '|---|---|---|');
      for (const d of disputed) lines.push(`| ${d.id} | ${cell(d.proposer)} | ${cell(d.checker)} |`);
      lines.push('');
    }

    lines.push(
      `Batch hash (question-set:${stage}, SHA-256 of the canonical JSON of its ${payload.questions.length} approved stems): ` +
        `\`${questionSetBatchHash(bank, proposal, stage)}\``,
    );
    out[stage] = `${lines.join('\n')}\n`;
  }
  return out;
}

/**
 * The text tables of `c`, content `version`: `<stage>` for each stage and `help-and-reason-codes`, each a Markdown file built from the
 * batch's sign-off payload and ending with its SHA-256.
 */
export function renderTextTables(c: LoadedContent, version: string): Record<Stage | 'help-and-reason-codes', string> {
  const out = {} as Record<Stage | 'help-and-reason-codes', string>;
  for (const stage of STAGES) {
    const p = signOffPayload(c, stage) as Extract<SignOffPayload, { batch: Stage }>;
    const lines = [`# The ${stage} texts of content ${version}`, '', `${p.questions.length} questions, in the order S-12 shows them.`, ''];
    // practiceSameAs is signed in the stage's question-set batch, so it is read from there and shown beside the texts.
    const qs = signOffPayload(c, `question-set:${stage}`) as Extract<SignOffPayload, { batch: QuestionSetBatch }>;
    const sameAs = new Map(qs.questions.map((x) => [x.id, x.practiceSameAs]));
    for (const q of p.questions) {
      lines.push(`## ${q.id}`, '', `**Question:** ${q.text}`, '', '| Text | Wording |', '|---|---|');
      lines.push(`| Expected practice | ${cell(q.expectedPractice)} |`, `| Why this is asked | ${cell(q.whyAsked)} |`);
      // Only what the question has: a question with per-question wording has no reason prompt, the gate has no labels or prompts.
      if (q.reasonPrompt !== undefined) lines.push(`| Reason prompt | ${cell(q.reasonPrompt)} |`);
      if (q.answerLabels !== undefined) for (const k of ANSWER_KEYS) lines.push(`| Answer label, ${k} | ${cell(q.answerLabels[k])} |`);
      if (q.answerPrompts !== undefined) for (const k of ANSWER_KEYS) lines.push(`| Answer prompt, ${k} | ${cell(q.answerPrompts[k])} |`);
      const same = sameAs.get(q.id);
      if (same !== undefined) lines.push(`| Practice same as | ${same.length === 0 ? 'none' : cell(same.join(', '))} |`);
      q.evidenceExamples.forEach((e, i) => lines.push(`| Evidence example ${i + 1} | ${cell(e)} |`));
      if (q.helpText !== null) lines.push(`| Help text | ${cell(q.helpText)} |`);
      if (q.example !== null) lines.push(`| Example | ${cell(q.example)} |`);
      lines.push('');
    }
    lines.push(`Batch \`${stage}\` sha256: \`${signOffHash(p)}\``);
    out[stage] = `${lines.join('\n')}\n`;
  }
  const h = signOffPayload(c, 'help-and-reason-codes') as Extract<SignOffPayload, { batch: 'help-and-reason-codes' }>;
  const lines = [`# The document help lines and reason codes of content ${version}`, '', '## Document help lines', '', '| Document | Help line |', '|---|---|'];
  for (const [doc, text] of Object.entries(h.documentHelp)) lines.push(`| ${doc} | ${cell(text)} |`);
  lines.push('', '## Reason codes', '', '| Code | Status | Label | Use it when | The reason must say |', '|---|---|---|---|---|');
  for (const r of h.reasonCodes) lines.push(`| \`${r.code}\` | ${r.status} | ${cell(r.label)} | ${cell(r.useWhen)} | ${cell(r.reasonMustSay)} |`);
  lines.push('', `Batch \`help-and-reason-codes\` sha256: \`${signOffHash(h)}\``);
  out['help-and-reason-codes'] = `${lines.join('\n')}\n`;
  return out;
}

function loadBank(proposal: QuestionSetProposal, bankPath: string | undefined): CoverageBank {
  const bytes =
    bankPath === undefined
      ? execFileSync('git', ['show', `${proposal.base.commit}:${proposal.base.file}`], { maxBuffer: 16 * 1024 * 1024 })
      : readFileSync(bankPath);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== proposal.base.sha256) throw new Error(`bank sha256 ${sha} is not proposal base sha256 ${proposal.base.sha256}`);
  return JSON.parse(bytes.toString('utf8')) as CoverageBank;
}

if (isMainModule(import.meta.url)) {
  const [mode, proposalPath, outDir, ...rest] = process.argv.slice(2);
  if (mode === 'texts' && proposalPath !== undefined && outDir !== undefined && rest.length === 0) {
    const tables = renderTextTables(loadContent(proposalPath), proposalPath);
    mkdirSync(outDir, { recursive: true });
    for (const [name, text] of Object.entries(tables)) {
      const file = path.join(outDir, `${name}.md`);
      writeFileSync(file, text);
      process.stdout.write(`wrote ${file}\n`);
    }
    process.exit(0);
  }
  if (mode !== 'question-set' || proposalPath === undefined || outDir === undefined) {
    throw new Error('usage: render-tables.ts question-set <proposal> <out-dir> [--bank <f>] [--fieldmaps <dir>] [--areas <f>] | texts <version> <out-dir>');
  }
  const opts = new Map<string, string>();
  for (let n = 0; n < rest.length; n += 2) {
    if (rest[n] !== '--bank' && rest[n] !== '--fieldmaps' && rest[n] !== '--areas') throw new Error(`unknown argument ${rest[n]}`);
    if (opts.has(rest[n])) throw new Error(`${rest[n]} given twice`);
    if (rest[n + 1] === undefined) throw new Error(`${rest[n]} needs a value`);
    opts.set(rest[n], rest[n + 1]);
  }
  const proposal = JSON.parse(readFileSync(proposalPath, 'utf8')) as QuestionSetProposal;
  const bank = loadBank(proposal, opts.get('--bank'));
  const fieldmaps = opts.get('--fieldmaps');
  const areasPath = opts.get('--areas');
  const areas = areasPath === undefined ? undefined : (JSON.parse(readFileSync(areasPath, 'utf8')) as CoverageAreas);
  const tables = renderQuestionSetTables({
    bank,
    proposal,
    maps: fieldmaps === undefined ? undefined : readFieldMaps(fieldmaps),
    areas,
  });
  mkdirSync(outDir, { recursive: true });
  for (const stage of STAGES) {
    const file = path.join(outDir, `${stage}.md`);
    writeFileSync(file, tables[stage]);
    process.stdout.write(`wrote ${file}\n`);
  }
}
