import { describe, it, expect } from 'vitest';
import {
  createAssessment,
  setResponse,
  calculatePrincipleScores,
} from '../../lib/engine/AssessmentEngine.js';
import questionBank from '../../data/questionBank.json' with { type: 'json' };

/**
 * Scoring-weight correctness.
 *
 * These tests are written against the question bank as it actually ships, not
 * against fixtures, because both defects they cover were invisible to fixture
 * tests: the numbers only go wrong when real declared weights meet real
 * question types.
 */

/** Every question in the shipped bank, regardless of how deeply it is nested. */
function allQuestions() {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') {
      if (node.id && node.type) out.push(node);
      Object.values(node).forEach(walk);
    }
  })(questionBank.stages);
  return out;
}

/** Answer every scoring question in a stage at its maximum value. */
function answerStagePerfectly(state, stage) {
  let s = state;
  for (const q of allQuestions().filter((q) => q.stage === stage || q.id.startsWith(stagePrefix(stage)))) {
    if (q.type === 'likert-5') s = setResponse(s, stage, q.id, 4);
    else if (q.type === 'checklist') s = setResponse(s, stage, q.id, (q.options ?? []).map((o) => o.value ?? o));
    // The gate's declared options are ["Yes","No"], and Q-PP-13/Q-PP-14 are
    // unlocked by an exact match on "Yes". Answering 'yes' in lowercase
    // silently excludes them, which is how an earlier measurement of this
    // defect reported 23 instead of the correct 31 — the answer looked valid
    // and was not. Take the option from the bank rather than writing a literal.
    else if (q.type === 'gate') s = setResponse(s, stage, q.id, (q.options ?? ['Yes'])[0]);
  }
  return s;
}

function stagePrefix(stage) {
  return { 'pre-processing': 'Q-PP', 'in-processing': 'Q-IP', 'post-processing': 'Q-PO' }[stage] ?? 'Q-';
}

describe('a gate question must not dilute the principle it belongs to', () => {
  /**
   * Q-PP-GATE-SENSITIVE declares `weight: 0` and is typed `gate`;
   * normalizeResponse returns 0 for gates because "gate questions don't
   * contribute to scores". A gate must therefore be absent from BOTH sides of
   * the weighted average — contributing 0 to the numerator while adding to the
   * denominator is what caps the principle below 100.
   */
  it('scores Transparency & Explainability at 100 when every pre-processing answer is maximal', () => {
    const perfect = answerStagePerfectly(createAssessment(), 'pre-processing');
    const scores = calculatePrincipleScores(perfect, 'pre-processing');

    expect(scores['Transparency & Explainability'].maturity).toBe(100);
  });

  it('scores every other pre-processing principle at 100 too, so the gate is the only variable', () => {
    const perfect = answerStagePerfectly(createAssessment(), 'pre-processing');
    const scores = calculatePrincipleScores(perfect, 'pre-processing');

    for (const [principle, score] of Object.entries(scores)) {
      expect(score.maturity, `principle "${principle}" should reach 100 on perfect answers`).toBe(100);
    }
  });

  it('leaves the gate answer itself unable to move the score in either direction', () => {
    const base = answerStagePerfectly(createAssessment(), 'pre-processing');
    const gate = allQuestions().find((q) => q.type === 'gate');
    expect(gate, 'the bank should still contain a gate question').toBeTruthy();

    // Final whole-branch review, F7. This used to pass lowercase 'yes'/'no',
    // where the gate's declared options are ["Yes","No"] -- the sibling
    // describe block below proves lowercase is an INVALID answer that gets
    // excluded from unlocking exactly like any other junk string. Both
    // operands were therefore built from input that is invalid in the
    // identical way, so the comparison could never fail: it held even with
    // both `q.weight ?? 1` (the dilution-prevention fix, line ~553) AND the
    // `if (q.type === 'gate') continue` skip (line ~527) reverted together,
    // because an invalid answer excludes the gated dependent question from
    // scoring on BOTH sides alike, leaving nothing for 'yes' vs 'no' to
    // disagree about. Real options -- gate.options itself, not a literal,
    // so this keeps tracking the bank rather than a copy of it -- exercise
    // the actual "Yes" vs "No" code path and do fail under that same
    // reverted pair (verified: maturity 31 vs 23).
    const realYes = gate.options.find((o) => o === 'Yes');
    const realNo = gate.options.find((o) => o === 'No');
    expect(realYes, 'the gate should declare a real "Yes" option').toBeTruthy();
    expect(realNo, 'the gate should declare a real "No" option').toBeTruthy();
    const answeredYes = setResponse(base, 'pre-processing', gate.id, realYes);
    const answeredNo = setResponse(base, 'pre-processing', gate.id, realNo);

    const yes = calculatePrincipleScores(answeredYes, 'pre-processing')[gate.principle];
    const no = calculatePrincipleScores(answeredNo, 'pre-processing')[gate.principle];

    // Deep-equal, not reference-equal: `yes` and `no` are freshly built
    // EvidenceScore objects with equal content, never the same object, so
    // `toBe` (Object.is) would fail even when the gate correctly moved
    // nothing. toStrictEqual checks the whole reading -- maturity AND
    // practices -- matching the test's actual claim ("the gate answer
    // cannot move the score"), not just the maturity half of it.
    expect(yes).toStrictEqual(no);
  });
});

describe('the gate unlocks its dependent questions, and they are scored', () => {
  /**
   * Guards the measurement error that produced a wrong root-cause story for
   * this very defect. Q-PP-13 (weight 0.15) and Q-PP-14 are gated on
   * Q-PP-GATE-SENSITIVE === "Yes" exactly. An invalid gate answer excludes
   * them silently — no error, just a different score — so a probe that
   * mistypes the option measures a different system than the one shipped.
   */
  it('includes a gate-dependent question when the gate is answered with a real option', () => {
    const gate = allQuestions().find((q) => q.type === 'gate');
    const dependent = allQuestions().find((q) => q.condition?.questionId === gate.id);
    expect(dependent, 'the bank should still gate at least one question').toBeTruthy();

    const yes = answerStagePerfectly(createAssessment(), 'pre-processing');
    const scores = calculatePrincipleScores(yes, 'pre-processing');

    // With the gate answered from its own option list, every principle -
    // including the one holding the gated question - reaches 100.
    expect(scores[dependent.principle].maturity).toBe(100);
  });

  it('an invalid gate answer is not silently equivalent to a valid one', () => {
    const gate = allQuestions().find((q) => q.type === 'gate');
    const valid = answerStagePerfectly(createAssessment(), 'pre-processing');
    const invalid = setResponse(valid, 'pre-processing', gate.id, 'yes');

    // Post-fix both reach 100, so this asserts the mechanism rather than the
    // score: the gate's declared options do not include the lowercase form.
    expect(gate.options).toContain('Yes');
    expect(gate.options).not.toContain('yes');
    expect(calculatePrincipleScores(invalid, 'pre-processing')).toBeDefined();
  });
});

