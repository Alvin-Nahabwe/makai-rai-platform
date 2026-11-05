/**
 * Applies the owner-approved question-set proposal to content 5.0.0's question bank, in place (CW-00, SRS 10.1.0
 * step 4; R-61). Idempotent: run on the applied bank it changes nothing.
 *
 *   npx tsx scripts/content/apply-revision.ts <proposal> [--bank data/content/5.0.0/questionBank.json]
 *
 * keep leaves the question (its stem must be the v0.5.0 stem); reword sets `text`; merge removes the absorbed id and
 * sets the survivor's `gaps` and `optionGapMap` from `survivors`; cut removes; replace puts the `NewQuestion` at the
 * index the old id held in its module (ruling of 30 Oct 12:50, R11-15), so no other question moves. A `NewQuestion`
 * whose stage or module differs from the replaced question's stops the applier: a changed position is the owner's.
 * The new question's four texts start empty; Task 8's apply-texts.ts writes them.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { STAGES, type Stage } from '@/types/record';

import { indexActions, isMainModule } from './coverage';
import type { NewQuestion, QuestionSetProposal } from './types';

type Json = Record<string, unknown>;
interface BankLike {
  stages: Record<Stage, { modules: Array<{ id: string; questions: Json[] }> }>;
}

interface Place { stage: Stage; moduleId: string; list: Json[]; index: number }

function find(bank: BankLike, id: string): Place | null {
  for (const stage of STAGES) {
    for (const m of bank.stages[stage].modules) {
      const index = m.questions.findIndex((q) => q.id === id);
      if (index >= 0) return { stage, moduleId: m.id, list: m.questions, index };
    }
  }
  return null;
}

/** The bank question for a new id: the proposal's fields, the four texts empty until the drafted texts are applied. */
function newQuestion(n: NewQuestion): Json {
  const q: Json = { id: n.id, text: n.text, type: n.type };
  if (n.options !== undefined) q.options = [...n.options];
  if (n.optionGapMap !== undefined) q.optionGapMap = structuredClone(n.optionGapMap);
  Object.assign(q, { principle: n.principle, gaps: [...n.gaps], expectedPractice: '', whyAsked: '', reasonPrompt: '', evidenceExamples: [] });
  return q;
}

/** A copy of `bank` with the proposal applied. Throws on anything the proposal and the bank disagree about. */
export function applyRevision<B extends BankLike>(bank: B, proposal: QuestionSetProposal): B {
  if (proposal.status !== 'approved') throw new Error(`apply-revision: the proposal's status is ${proposal.status}, not approved`);
  indexActions(proposal); // throws on a duplicated action or an unknown action kind
  const out = structuredClone(bank);
  const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
  const survivorById = new Map(proposal.survivors.map((s) => [s.id, s]));

  for (const a of proposal.actions) {
    const at = find(out, a.id);
    switch (a.action) {
      case 'keep':
      case 'reword': {
        if (at === null) throw new Error(`apply-revision: ${a.id} (${a.action}) is not in the bank`);
        const q = at.list[at.index];
        if (a.action === 'reword') q.text = a.text;
        else if (q.text !== a.originalText) throw new Error(`apply-revision: ${a.id} is kept, but its stem in the bank is not the v0.5.0 stem`);
        break;
      }
      case 'cut':
      case 'merge':
        if (at !== null) at.list.splice(at.index, 1);
        break;
      case 'replace': {
        const n = newById.get(a.newId);
        if (n === undefined) throw new Error(`apply-revision: ${a.id} is replaced by ${a.newId}, which newQuestions does not describe`);
        if (at === null) {
          if (find(out, a.newId) === null) throw new Error(`apply-revision: neither ${a.id} nor its replacement ${a.newId} is in the bank`);
          break; // already applied; the field check below confirms it
        }
        if (n.stage !== at.stage || n.moduleId !== at.moduleId) {
          throw new Error(`apply-revision: ${a.newId} names ${n.stage} module ${n.moduleId}, but ${a.id}, which it replaces, sits in ${at.stage} module ${at.moduleId}; a changed position is the owner's decision`);
        }
        if (find(out, a.newId) !== null) throw new Error(`apply-revision: ${a.newId} and ${a.id} are both in the bank`);
        at.list[at.index] = newQuestion(n);
        break;
      }
      default:
        throw new Error(`apply-revision: unknown action ${JSON.stringify((a as { action?: unknown }).action)}`);
    }
  }

  for (const [id, s] of survivorById) {
    const at = find(out, id);
    if (at === null) throw new Error(`apply-revision: survivor ${id} is not in the bank`);
    const q = at.list[at.index];
    q.gaps = [...s.gaps];
    if (s.optionGapMap !== undefined) q.optionGapMap = structuredClone(s.optionGapMap);
    else delete q.optionGapMap;
  }

  for (const n of newById.values()) {
    const at = find(out, n.id);
    if (at === null) throw new Error(`apply-revision: new question ${n.id} is not in the bank after the revision`);
    const q = at.list[at.index];
    for (const k of ['text', 'type', 'principle'] as const) {
      if (q[k] !== n[k]) throw new Error(`apply-revision: ${n.id}'s ${k} in the bank is not the approved one`);
    }
    if (JSON.stringify(q.gaps) !== JSON.stringify(n.gaps)) throw new Error(`apply-revision: ${n.id}'s gaps in the bank are not the approved ones`);
  }
  return out;
}

function main(argv: string[]): void {
  const args = [...argv];
  const proposalFile = args.shift();
  let bankFile = 'data/content/5.0.0/questionBank.json';
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--bank' && args.length > 0) bankFile = args.shift() as string;
    else throw new Error(`apply-revision: unknown argument ${JSON.stringify(flag)}`);
  }
  if (proposalFile === undefined) throw new Error('usage: apply-revision.ts <proposal> [--bank <file>]');
  const proposal = JSON.parse(readFileSync(proposalFile, 'utf8')) as QuestionSetProposal;
  const bank = JSON.parse(readFileSync(bankFile, 'utf8')) as BankLike;
  writeFileSync(bankFile, `${JSON.stringify(applyRevision(bank, proposal), null, 2)}\n`);
  console.log(`applied ${proposalFile} to ${bankFile}`);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
