/**
 * Content 5.0.0 holds exactly the question set the owner approved (CW-00, SRS 10.1.0 step 4; R-61), and the three
 * question-set sign-off records cover it (FR-CNT-02).
 *
 * This file reads the real bundle (contract "Content bundle", the fixture rule: only CNT and C-TXT call loadContent on
 * it). The v0.5.0 input is `data/questionBank.json`, which the test first proves is the file the proposal revises
 * (`base.sha256`, the d13be0c bank).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { loadContent, questionsInStage } from '@/lib/content/loader';
import { signOffHash, signOffItems, signOffPayload } from '@/lib/content/signoffs';
import { applyRevision } from '@/scripts/content/apply-revision';
import { buildQuestionSetRecord } from '@/scripts/content/sign-off';
import type { QuestionSetProposal } from '@/scripts/content/types';
import type { SignOffsFile } from '@/types/content';
import { STAGES, type Stage } from '@/types/record';

vi.unmock('@/lib/content/root');

const PROPOSAL_FILE = 'docs/content/question-set-5.0.0/proposal.json';
const BASE_FILE = 'data/questionBank.json';
const BANK_FILE = 'data/content/5.0.0/questionBank.json';
const SIGNOFFS_FILE = 'data/content/5.0.0/signoffs.json';

const proposal = JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8')) as QuestionSetProposal;
const baseBytes = readFileSync(BASE_FILE);

type BankQuestion = { id: string; text: string; type: string; gaps: string[]; optionGapMap?: unknown; principle: string };
type Bank = { stages: Record<Stage, { modules: Array<{ id: string; questions: BankQuestion[] }> }> };
const base = JSON.parse(baseBytes.toString('utf8')) as Bank;

/** Every question of a bank file with its stage, module and index in that module, in content order. */
function placed(bank: Bank): Array<{ q: BankQuestion; stage: Stage; moduleId: string; index: number }> {
  return STAGES.flatMap((stage) =>
    bank.stages[stage].modules.flatMap((m) => m.questions.map((q, index) => ({ q, stage, moduleId: m.id, index }))),
  );
}

const removedIds = new Set(proposal.actions.filter((a) => a.action === 'cut' || a.action === 'merge').map((a) => a.id));

describe('content 5.0.0 and the approved question set', () => {
  it('reads the approved proposal of the v0.5.0 bank it names', () => {
    expect(proposal.status).toBe('approved');
    expect(createHash('sha256').update(baseBytes).digest('hex')).toBe(proposal.base.sha256);
  });

  it('R-61 FR-CNT-01: 5.0.0 holds exactly the approved revision', () => {
    const c = loadContent('5.0.0');
    const survivors = new Map(proposal.survivors.map((s) => [s.id, s]));
    const newById = new Map(proposal.newQuestions.map((n) => [n.id, n]));
    const allowed = new Set<string>();
    for (const a of proposal.actions) {
      if (a.action === 'keep') {
        expect(c.questions.get(a.id)?.text, a.id).toBe(a.originalText);
        allowed.add(a.id);
      } else if (a.action === 'reword') {
        expect(c.questions.get(a.id)?.text, a.id).toBe(a.text);
        allowed.add(a.id);
      } else if (a.action === 'cut' || a.action === 'merge') {
        expect(c.questions.has(a.id), `${a.id} is ${a.action}`).toBe(false);
      } else if (a.action === 'replace') {
        expect(c.questions.has(a.id), `${a.id} is replaced`).toBe(false);
        const n = newById.get(a.newId);
        const q = c.questions.get(a.newId);
        expect(n, a.newId).toBeDefined();
        expect(q, a.newId).toBeDefined();
        expect({ text: q?.text, stage: q?.stage, moduleId: q?.moduleId, type: q?.type, principle: q?.principle, gaps: [...(q?.gaps ?? [])] })
          .toEqual({ text: n?.text, stage: n?.stage, moduleId: n?.moduleId, type: n?.type, principle: n?.principle, gaps: n?.gaps });
        expect(q?.optionGapMap).toEqual(n?.optionGapMap);
        allowed.add(a.newId);
      }
      if (a.action === 'merge') {
        const s = survivors.get(a.into);
        const q = c.questions.get(a.into);
        expect(s, `survivors entry of ${a.into}`).toBeDefined();
        expect([...(q?.gaps ?? [])], a.into).toEqual(s?.gaps);
        expect(q?.optionGapMap, a.into).toEqual(s?.optionGapMap);
      }
    }
    expect([...c.questions.keys()].filter((id) => !allowed.has(id))).toEqual([]);
    expect(c.questions.size).toBe(allowed.size);
  });

  it('R-61: no 5.0.0 id is a cut id', () => {
    const c = loadContent('5.0.0');
    const cut = proposal.actions.filter((a) => a.action === 'cut').map((a) => a.id);
    expect(cut.filter((id) => c.questions.has(id))).toEqual([]);
    const replaced = proposal.actions.filter((a) => a.action === 'replace').map((a) => a.id);
    expect(replaced.filter((id) => c.questions.has(id))).toEqual([]);
  });

  it("R-61 CW-00: a replacement takes the replaced question's position, so the stage order is the old order with one id swapped", () => {
    const bank = JSON.parse(readFileSync(BANK_FILE, 'utf8')) as Bank;
    const now = placed(bank);
    const old = placed(base);
    for (const a of proposal.actions) {
      if (a.action !== 'replace') continue;
      const was = old.find((p) => p.q.id === a.id);
      const is = now.find((p) => p.q.id === a.newId);
      // Its index in the module of the revised bank counts the questions before it that the revision kept.
      const keptBefore = old.filter((p) => p.stage === was?.stage && p.moduleId === was?.moduleId && p.index < (was?.index ?? 0) && !removedIds.has(p.q.id)).length;
      expect({ stage: is?.stage, moduleId: is?.moduleId, index: is?.index }, a.newId).toEqual({ stage: was?.stage, moduleId: was?.moduleId, index: keptBefore });
    }
    const backToOld = new Map(proposal.actions.flatMap((a) => (a.action === 'replace' ? [[a.newId, a.id] as const] : [])));
    const c = loadContent('5.0.0');
    for (const stage of STAGES) {
      const revised = questionsInStage(c, stage).map((q) => backToOld.get(q.id) ?? q.id);
      const expected = old.filter((p) => p.stage === stage && !removedIds.has(p.q.id)).map((p) => p.q.id);
      expect(revised, stage).toEqual(expected);
    }
  });

  it("R-61 FR-CNT-02: each question-set record's sha256 equals signOffHash(signOffPayload(loadContent('5.0.0'), batch))", () => {
    const c = loadContent('5.0.0');
    const records = (JSON.parse(readFileSync(SIGNOFFS_FILE, 'utf8')) as SignOffsFile).records.filter((r) => r.batch.startsWith('question-set:'));
    expect(records.map((r) => r.batch).sort()).toEqual(STAGES.map((s) => `question-set:${s}`).sort());
    for (const r of records) {
      const payload = signOffPayload(c, r.batch as `question-set:${Stage}`);
      expect(r.sha256, r.batch).toBe(signOffHash(payload));
      expect(r.items, r.batch).toEqual(signOffItems(payload));
      expect(r.items, r.batch).toEqual(questionsInStage(c, r.batch.slice('question-set:'.length) as Stage).map((q) => q.id));
      expect(r.approver.trim(), r.batch).not.toBe('');
      expect(Number.isNaN(Date.parse(r.at)), r.batch).toBe(false);
    }
  });
});

describe('apply-revision and sign-off, on copies', () => {
  it('apply-revision is idempotent: applying the proposal to the applied bank changes nothing', () => {
    const bank = JSON.parse(readFileSync(BANK_FILE, 'utf8')) as Bank;
    expect(applyRevision(bank, proposal)).toEqual(bank);
  });

  it('apply-revision stops when a new question names another stage or module than the question it replaces', () => {
    const fresh = JSON.parse(baseBytes.toString('utf8')) as Bank;
    const moved = structuredClone(proposal);
    moved.newQuestions[0] = { ...moved.newQuestions[0], moduleId: 'pre-data' };
    expect(() => applyRevision(fresh, moved)).toThrow(/Q-PP-24.*Q-PP-06|Q-PP-06.*Q-PP-24/);
  });

  it('sign-off --from-proposal refuses a proposal whose approved stems differ from the bank', () => {
    const c = loadContent('5.0.0');
    const changed = structuredClone(proposal);
    const keep = changed.actions.find((a) => a.action === 'keep' && a.id.startsWith('Q-IP-'));
    if (keep === undefined || keep.action !== 'keep') throw new Error('no kept in-processing question');
    keep.originalText = `${keep.originalText} (changed)`;
    expect(() => buildQuestionSetRecord(c, changed, 'in-processing', { approver: 'Product owner, MAK-AI', at: '2026-11-05T09:25:00Z' })).toThrow(/stem/);
  });

  it('sign-off --from-proposal builds the record CNT checks, and refuses an empty approver or a time without a zone', () => {
    const c = loadContent('5.0.0');
    const r = buildQuestionSetRecord(c, proposal, 'post-processing', { approver: 'Product owner, MAK-AI', at: '2026-11-05T09:25:00Z' });
    const payload = signOffPayload(c, 'question-set:post-processing');
    expect(r).toEqual({ batch: 'question-set:post-processing', approver: 'Product owner, MAK-AI', at: '2026-11-05T09:25:00Z', sha256: signOffHash(payload), items: signOffItems(payload) });
    expect(() => buildQuestionSetRecord(c, proposal, 'post-processing', { approver: ' ', at: '2026-11-05T09:25:00Z' })).toThrow(/approver/);
    expect(() => buildQuestionSetRecord(c, proposal, 'post-processing', { approver: 'x', at: '2026-11-05T09:25:00' })).toThrow(/zone/);
  });
});
