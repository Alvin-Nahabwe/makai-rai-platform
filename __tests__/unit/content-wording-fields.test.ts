import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildLoadedContent } from '@/lib/content/loader';
import { signOffHash, signOffItems, signOffPayload, type SignOffBatch } from '@/lib/content/signoffs';
import { validateContentVersion } from '@/lib/content/validate';

/**
 * Per-question wording (content 5.2.0): `answerLabels` and `answerPrompts` on every non-gate question, `reasonPrompt` on
 * the gate only (plan decision D1). Every case edits a temporary copy of the 0.0.2 fixture, so the committed fixture is untouched.
 */

const FIXTURES = join(process.cwd(), '__tests__', 'fixtures', 'content');
const BATCHES: readonly SignOffBatch[] = ['pre-processing', 'in-processing', 'post-processing', 'help-and-reason-codes',
  'question-set:pre-processing', 'question-set:in-processing', 'question-set:post-processing'];
const GATE = 'Q-PP-GATE-SENSITIVE';
const KEYS = ['done', 'partly', 'not_yet', 'not_applicable'] as const;

type Json = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- the files are edited as plain JSON
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const json = (p: string): Json => JSON.parse(readFileSync(p, 'utf8'));
const write = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const questionsOf = (bank: Json): Json[] => Object.values(bank.stages as Json).flatMap((s: Json) => s.modules.flatMap((m: Json) => m.questions));

const LABELS = { done: 'Yes', partly: 'In part', not_yet: 'Not yet', not_applicable: 'Does not apply' };
const PROMPTS = { done: 'Say what you did and where it is kept.', partly: 'Say what is done and what is left.',
  not_yet: 'Say what stops you and who will start it.', not_applicable: 'Say why this does not apply to your project.' };

/** A complete, signed copy of the fixture whose non-gate questions carry labels and prompts and no reasonPrompt; `edit` changes it before signing. */
function wordedCopy(edit: (qs: Json[]) => void = () => undefined): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cnt-wording-')), '0.0.2-fixture');
  roots.push(join(dir, '..'));
  cpSync(join(FIXTURES, '0.0.2-fixture'), dir, { recursive: true });
  const bank = json(join(dir, 'questionBank.json'));
  const qs = questionsOf(bank);
  const base = new Map(questionsOf(json('data/questionBank.json')).map((q) => [q.id, q.text as string]));
  for (const q of qs) {
    if (q.id.includes('-EXTRA-') && /^When /.test(q.helpText ?? '')) q.helpText = 'Guidance for every team that answers this question.';
    // The fixture rewords three stems; with no proposal the check wants the 4.0.0 ones.
    if (base.has(q.id)) q.text = base.get(q.id)!;
    if (q.id === GATE) continue;
    q.answerLabels = { ...LABELS };
    q.answerPrompts = { ...PROMPTS };
    delete q.reasonPrompt;
  }
  edit(qs);
  write(join(dir, 'questionBank.json'), bank);
  const areasPath = join(dir, 'assessmentAreas.json');
  const areas = json(areasPath);
  for (const a of areas.areas) for (const r of a.references ?? []) if (typeof r.url === 'string') r.url = r.url.replace(/^http:/, 'https:');
  write(areasPath, areas);
  const c = buildLoadedContent(basename(dir), (f) => readFileSync(join(dir, f)));
  write(join(dir, 'signoffs.json'), { records: BATCHES.map((batch) => {
    const p = signOffPayload(c, batch);
    return { batch, approver: 'Owner', at: '2026-10-31T10:00:00.000Z', sha256: signOffHash(p), items: signOffItems(p) };
  }) });
  return dir;
}
const problemsOf = (dir: string) => validateContentVersion(dir, { baselineDir: 'data', proposalFile: null, completeness: true });
const firstNonGate = (qs: Json[]): Json => qs.find((q) => q.id !== GATE)!;

describe('wording fields', () => {
  it('wording fields: a version with answerLabels on every non-gate question and reasonPrompt only on the gate passes', () => {
    expect(problemsOf(wordedCopy())).toEqual([]);
  });

  it('wording fields: a non-gate question with answerLabels but no answerPrompts fails', () => {
    const dir = wordedCopy((qs) => { delete firstNonGate(qs).answerPrompts; });
    expect(problemsOf(dir).join('\n')).toMatch(/question Q-[A-Z-0-9]+: answerPrompts is missing/);
  });

  it('wording fields: two equal labels on one question fail', () => {
    const dir = wordedCopy((qs) => { firstNonGate(qs).answerLabels.partly = 'Yes'; });
    expect(problemsOf(dir).join('\n')).toMatch(/answerLabels: "Yes" is used twice/);
  });

  it('wording fields: a 41-character label and a 201-character prompt fail', () => {
    const dir = wordedCopy((qs) => {
      const q = firstNonGate(qs);
      q.answerLabels.done = 'x'.repeat(41);
      q.answerPrompts.partly = 'x'.repeat(201);
    });
    const p = problemsOf(dir).join('\n');
    expect(p).toMatch(/answerLabels\.done has 41 characters; 1 to 40 required/);
    expect(p).toMatch(/answerPrompts\.partly has 201 characters; 1 to 200 required/);
  });

  it('wording fields: a three-sentence prompt fails', () => {
    const dir = wordedCopy((qs) => { firstNonGate(qs).answerPrompts.not_yet = 'Say what stops you. Name who starts it. Give a date.'; });
    expect(problemsOf(dir).join('\n')).toMatch(/answerPrompts\.not_yet has 3 sentences; at most 2 allowed/);
  });

  it('wording fields: a gate with answerLabels fails, and a gate without reasonPrompt fails', () => {
    const withLabels = wordedCopy((qs) => { qs.find((q) => q.id === GATE)!.answerLabels = { ...LABELS }; });
    expect(problemsOf(withLabels).join('\n')).toMatch(new RegExp(`question ${GATE}: .*answerLabels`));
    const noReason = wordedCopy((qs) => { delete qs.find((q) => q.id === GATE)!.reasonPrompt; });
    expect(problemsOf(noReason).join('\n')).toMatch(new RegExp(`question ${GATE}: reasonPrompt`));
  });

  it('wording fields: the four keys and no others are required on a label set', () => {
    const dir = wordedCopy((qs) => { delete firstNonGate(qs).answerLabels.not_applicable; });
    expect(problemsOf(dir).join('\n')).toMatch(/answerLabels\.not_applicable is missing/);
    expect(KEYS).toHaveLength(4);
  });
});
