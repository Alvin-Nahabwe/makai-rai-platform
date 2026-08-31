import { describe, expect, it } from 'vitest';
import questionBank from '../../data/questionBank.json';

/**
 * Question weights are uniform, and re-introducing differentiated ones must be
 * a deliberate act rather than a quiet edit.
 *
 * The 2026-08-18 content audit measured the previous weights against question
 * ID and found r = −0.538, −0.544, −0.570 by stage: they were assigned in
 * document order and never derived from risk. Framework 4.0.0 flattened all 77
 * non-gate weights to 1, and the migration
 * (`20260827143754_framework_4_0_0_flat_weights`) records what that cost —
 * substituting equal weights moved an area score by 2.15 points on average and
 * changed the band label in 10.5% of 4,200 sampled scores. It was a MAJOR
 * version precisely because identical answers now produce different numbers.
 *
 * That reasoning lives in a migration and a spec. Nothing stopped someone
 * re-adding a plausible-looking weight to one question, which would silently
 * restore a weighted model with no derivation behind it — and the failure is
 * invisible, because a weighted score looks exactly like an unweighted one.
 *
 * This is not an argument that uniform weights are correct. They are a
 * deliberate admission that the project has no risk model yet. When one exists,
 * change this test in the same commit that introduces it, and say in the message
 * what the weights are derived FROM. That is the whole point: the test does not
 * forbid weights, it forbids undeclared ones.
 */

type Q = { id: string; weight?: number; type?: string };

function questions(): Q[] {
  const out: Q[] = [];
  for (const stage of Object.values(questionBank.stages as Record<string, { modules?: { questions?: Q[] }[] }>)) {
    for (const mod of stage.modules ?? []) out.push(...(mod.questions ?? []));
  }
  return out;
}

describe('question weights carry no undeclared risk model', () => {
  it('reads a plausible number of questions, so a broken traversal cannot pass vacuously', () => {
    expect(questions().length).toBeGreaterThan(50);
  });

  it('gives every NON-GATE question the same weight', () => {
    // Gates are excluded deliberately, and finding that out is why this test
    // exists in the form it does: written to assert one distinct weight, it
    // failed immediately on [1, 0]. The 0 is `Q-PP-GATE-SENSITIVE`, type
    // `gate` — it decides whether a branch is asked at all rather than
    // contributing to a score, which is exactly what the migration meant by
    // "all 77 NON-GATE question weights set to 1". The assumption was mine, not
    // the data's.
    const nonGate = questions().filter((q) => typeof q.weight === 'number' && q.type !== 'gate');
    const distinct = [...new Set(nonGate.map((q) => q.weight))];
    expect(
      distinct,
      `non-gate question weights are no longer uniform (${distinct.join(', ')}). If this is a ` +
        `derived risk model, update this test in the same commit and state in the message what ` +
        `the weights are derived FROM. If it is an edit to one question, it has silently restored ` +
        `the weighting framework 4.0.0 removed — those weights correlated with question ID at ` +
        `r ≈ −0.55, i.e. they encoded the order the questions were written in.`,
    ).toEqual([1]);
  });

  it('keeps gates at weight 0, so a gate cannot start contributing to a score', () => {
    const gates = questions().filter((q) => q.type === 'gate');
    expect(gates.length, 'no gate questions found — the traversal or the type name has changed').toBeGreaterThan(0);
    expect(
      [...new Set(gates.map((q) => q.weight))],
      'a gate has a non-zero weight: it would now score as well as gate, counting once as a ' +
        'branch decision and once as an answer.',
    ).toEqual([0]);
  });

  it('still gives most questions a weight at all, so flattening did not become deleting', () => {
    // The engine reads `q.weight ?? 1`, so removing the field entirely produces
    // the same scores. That would pass the assertion above while quietly
    // discarding the field a future risk model needs to live in.
    const all = questions();
    const weighted = all.filter((q) => typeof q.weight === 'number');
    expect(weighted.length / all.length).toBeGreaterThan(0.9);
  });
});
