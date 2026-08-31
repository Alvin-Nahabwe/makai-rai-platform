import { describe, it, expect } from 'vitest';
import {
  createAssessment, setResponse, completeStage,
  calculatePrincipleScores, getScoringQuestions,
} from '../../lib/engine/AssessmentEngine.js';
import qb from '../../data/questionBank.json' with { type: 'json' };

/**
 * Content-audit item 17. PrincipleScorecard now prints "from N maturity
 * questions" beside each percentage, because the eight principles are not
 * evenly resourced: the widest-covered rests on an order of magnitude more
 * answers than the thinnest, and side by side they otherwise read as equally
 * solid measurements. These tests pin the printed N to the question bank so
 * the disclosure cannot drift away from the content it claims to describe.
 */

function build(likert) {
  let s = createAssessment();
  for (const [stage, sd] of Object.entries(qb.stages)) {
    for (const m of sd.modules ?? []) for (const q of m.questions ?? []) {
      if (q.type === 'likert-5') s = setResponse(s, stage, q.id, likert);
      else if (q.type === 'checklist') {
        const opts = (q.options ?? []).map((o) => o.value ?? o);
        s = setResponse(s, stage, q.id, opts);
      } else if (q.type === 'gate') s = setResponse(s, stage, q.id, (q.options ?? ['Yes'])[0]);
    }
    s = completeStage(s, stage);
  }
  return s;
}

const STAGES = Object.keys(qb.stages);

describe('principle basis count', () => {
  const state = build(2);

  it.each(STAGES)('%s: basisCount matches an independent count of the same questions', (stage) => {
    const scores = calculatePrincipleScores(state, stage);

    // Oracle counted from the question list directly, NOT from the accumulator
    // under test. Mirrors the two exclusions the scoring loop makes: gates
    // carry no opinion, and checklists take the practices branch and never
    // reach the maturity mean at all.
    const expected = {};
    for (const q of getScoringQuestions(state, stage)) {
      if (!q.principle || q.type === 'gate' || q.type === 'checklist') continue;
      expected[q.principle] = (expected[q.principle] ?? 0) + 1;
    }

    for (const [principle, score] of Object.entries(scores)) {
      expect(score.basisCount, `${stage} / ${principle}`).toBe(expected[principle] ?? 0);
    }
  });

  it('a principle whose questions are all checklists reports maturity null AND basis 0', () => {
    // The card's guard is `pct !== null && basis > 0`. These two must agree:
    // a non-null percentage over a zero basis would be incoherent, and a
    // positive basis with a null percentage would hide a real measurement.
    for (const stage of STAGES) {
      for (const [principle, s] of Object.entries(calculatePrincipleScores(state, stage))) {
        const where = `${stage} / ${principle}`;
        if (s.maturity === null) expect(s.basisCount, where).toBe(0);
        else expect(s.basisCount, where).toBeGreaterThan(0);
      }
    }
  });

  it('is response-dependent: weak answers UNLOCK questions and enlarge the basis', () => {
    // Load-bearing for anything that aggregates the basis across assessments.
    // Six `*-EXTRA-*` questions carry a `crossStageCondition` and unlock only
    // when an earlier stage was answered weakly ("Unlocked because data
    // representativeness was not audited in Pre-processing"). So the number of
    // questions behind a principle is NOT a fixed property of the framework
    // version -- two assessments on the SAME version legitimately differ, and
    // the weaker assessment is measured over MORE questions, not fewer.
    //
    // Anything that merges the basis across assessments (e.g. the dashboard
    // radar) must therefore not assume one value per principle per version.
    const weak = build(0);
    const strong = build(4);

    const totalFor = (state) => {
      const t = {};
      for (const stage of STAGES) {
        for (const [p, sc] of Object.entries(calculatePrincipleScores(state, stage))) {
          t[p] = (t[p] ?? 0) + (sc.basisCount ?? 0);
        }
      }
      return t;
    };
    const w = totalFor(weak);
    const st = totalFor(strong);

    const differing = Object.keys(w).filter((p) => w[p] !== st[p]);
    expect(
      differing.length,
      `expected at least one principle whose basis depends on answers; weak=${JSON.stringify(w)} strong=${JSON.stringify(st)}`,
    ).toBeGreaterThan(0);
    // Direction matters: remediation questions ADD to the weak assessment.
    for (const p of differing) expect(w[p], p).toBeGreaterThan(st[p]);
  });

  it('the principle axis is measurably uneven -- the defect being disclosed', () => {
    const totals = {};
    for (const stage of STAGES) {
      for (const [p, s] of Object.entries(calculatePrincipleScores(state, stage))) {
        totals[p] = (totals[p] ?? 0) + (s.basisCount ?? 0);
      }
    }
    const counts = Object.values(totals).filter((n) => n > 0);
    const spread = Math.max(...counts) / Math.min(...counts);
    // Deliberately not pinning exact per-principle numbers: content may grow.
    // What is pinned is that WHILE the spread is this wide, the scorecard keeps
    // disclosing the basis. If a rebalance ever brings this under 2x, revisit
    // whether the line still earns its space -- don't just delete this test.
    expect(spread).toBeGreaterThan(2);
  });
});
