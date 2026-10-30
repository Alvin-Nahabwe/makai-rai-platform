/**
 * Readable tables of the question-set proposal, one Markdown file per stage, for the owner's sitting
 * (SRS 10.1.0 step 4). Each file ends with the stage's batch hash: the SHA-256 of the canonical JSON of the
 * `question-set:<stage>` sign-off payload, the approved stems in content order (contract
 * `lib/content/signoffs.ts`, `SignOffPayload`; FR-CNT-02).
 *
 *   npx tsx scripts/content/render-tables.ts question-set <proposal> <out-dir> [--bank <f>] [--fieldmaps <dir>] [--areas <f>]
 *
 * Without `--bank` the v0.5.0 bank is read with `git show <base.commit>:<base.file>` and must hash to
 * `proposal.base.sha256`. `--fieldmaps` adds the field labels to the re-pointed fields. `--areas` runs the coverage
 * check first (with the field maps, when given) and refuses to render a proposal that fails it.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  baseQuestions,
  checkCoverage,
  indexActions,
  isMainModule,
  readFieldMaps,
  STAGES,
  type CoverageAreas,
  type CoverageBank,
  type CoverageFieldMap,
} from './coverage';
import type { QuestionSetProposal, RevisionAction, Stage } from './types';

/**
 * Local stand-in for `canonicalJson` of `lib/integrity/canonical.mjs` (K0b-1, contract Services row: RFC 8785
 * restricted to strings, integers, booleans, null, arrays and objects; strings NFC; keys sorted by UTF-16
 * code units; `TypeError` on a non-integer number or `undefined`). Delete this copy at the K0b-1 rebase and
 * import the real one; the sign-off hash must come from the one writer.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value.normalize('NFC'));
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: ${value} is not an integer`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.normalize('NFC'), v] as const);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (let i = 1; i < entries.length; i += 1) {
        if (entries[i][0] === entries[i - 1][0]) throw new TypeError(`canonicalJson: duplicate key ${entries[i][0]}`);
      }
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: cannot serialise a value of type ${typeof value}`);
  }
}

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

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

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
  const stageOf = new Map(base.map((q) => [q.id, q.stage]));
  const kindOf = new Map(base.map((q) => [q.id, q.type]));
  const actionById = indexActions(proposal);
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const labelOf = new Map<string, string>();
  for (const m of i.maps ?? []) for (const f of m.fields) labelOf.set(`${m.documentType}|${f.fieldId}`, f.label);

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
      lines.push(`| ${q.id} | ${cell(kindOf.get(q.id) as string)} | ${a.action} | ${cell(a.reason)} | ${cell(detail)} |`);
    }
    lines.push('');

    const repoints = proposal.repoints.filter((r) => stageOf.get(r.from) === stage);
    lines.push('## Document fields re-pointed in this stage', '');
    if (repoints.length === 0) {
      lines.push('No document field is re-pointed in this stage.', '');
    } else {
      lines.push('| Document | Field | Label | Old source | New source |', '|---|---|---|---|---|');
      for (const r of repoints) {
        const label = labelOf.get(`${r.documentType}|${r.fieldId}`) ?? '-';
        lines.push(`| ${r.documentType} | ${r.fieldId} | ${cell(label)} | ${r.from} | ${r.to === 'typed_only' ? 'typed only' : r.to} |`);
      }
      lines.push('');
    }

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
  if (mode !== 'question-set' || proposalPath === undefined || outDir === undefined) {
    throw new Error('usage: render-tables.ts question-set <proposal> <out-dir> [--bank <f>] [--fieldmaps <dir>] [--areas <f>]');
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
