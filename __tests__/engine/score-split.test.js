import { describe, it, expect } from 'vitest';
import {
  createAssessment, setResponse, completeStage, calculateAreaScores, calculatePrincipleScores,
  generateReportData, SCORING_VERSION, meanMaturity,
} from '../../lib/engine/AssessmentEngine.js';
import qb from '../../data/questionBank.json' with { type: 'json' };
import areasData from '../../data/assessmentAreas.json' with { type: 'json' };

/**
 * Builds a whole assessment at one answer profile.
 * `likert` is a 0-4 index; `checklist` is 'all' or 'none'.
 */
function build(likert, checklist) {
  let s = createAssessment();
  for (const [stage, sd] of Object.entries(qb.stages)) {
    for (const m of sd.modules ?? []) for (const q of m.questions ?? []) {
      if (q.type === 'likert-5') s = setResponse(s, stage, q.id, likert);
      else if (q.type === 'checklist') {
        const opts = (q.options ?? []).map((o) => o.value ?? o);
        s = setResponse(s, stage, q.id, checklist === 'all' ? opts : []);
      } else if (q.type === 'gate') s = setResponse(s, stage, q.id, (q.options ?? ['Yes'])[0]);
    }
    s = completeStage(s, stage);
  }
  return s;
}

function allAreaScores(state) {
  const out = {};
  for (const stage of Object.keys(qb.stages)) Object.assign(out, calculateAreaScores(state, stage));
  return out;
}

/** Areas that have at least one optionGapMap mapping, read from shipped content. */
function areasWithChecklistEvidence() {
  const ids = new Set();
  for (const sd of Object.values(qb.stages)) {
    for (const m of sd.modules ?? []) for (const q of m.questions ?? []) {
      for (const mappings of Object.values(q.optionGapMap ?? {})) {
        for (const mp of mappings) ids.add(typeof mp === 'string' ? mp : mp.area);
      }
    }
  }
  return ids;
}

describe('O-1: box-ticking cannot mask weak judgement', () => {
  it('reports maturity 25 and full practices coverage, never a blended score', () => {
    const scores = allAreaScores(build(1, 'all')); // "Minimally" + every box
    const withChecklist = areasWithChecklistEvidence();

    for (const [id, s] of Object.entries(scores)) {
      expect(s.maturity, `${id} maturity`).toBe(25);
      if (withChecklist.has(id)) {
        expect(s.practices.inPlace, `${id} inPlace`).toBe(s.practices.total);
        expect(s.practices.total, `${id} total`).toBeGreaterThan(0);
      }
    }
  });
});

describe('O-2: absent evidence is null, not zero', () => {
  it('returns practices null for exactly the areas with no optionGapMap mapping', () => {
    const scores = allAreaScores(build(2, 'all'));
    const withChecklist = areasWithChecklistEvidence();

    for (const a of areasData.areas) {
      const s = scores[a.id];
      if (withChecklist.has(a.id)) expect(s.practices, `${a.id}`).not.toBeNull();
      else expect(s.practices, `${a.id}`).toBeNull();
    }
  });
});

describe('O-3: a maximal assessment is maximal on both readings', () => {
  it('gives every area maturity 100 and complete practice coverage', () => {
    const scores = allAreaScores(build(4, 'all'));
    for (const [id, s] of Object.entries(scores)) {
      expect(s.maturity, `${id}`).toBe(100);
      if (s.practices) expect(s.practices.inPlace, `${id}`).toBe(s.practices.total);
    }
  });
});

describe('O-5: role no longer weights anything', () => {
  it('has deleted ROLE_WEIGHTS from the engine source', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../lib/engine/AssessmentEngine.js', import.meta.url), 'utf8'));
    expect(src).not.toContain('ROLE_WEIGHTS');
  });

  it('still records role breakdowns for display, summing to the totals', () => {
    const scores = allAreaScores(build(3, 'all'));
    for (const [id, s] of Object.entries(scores)) {
      if (!s.practices) continue;
      const summed = Object.values(s.practices.byRole)
        .reduce((acc, r) => ({ inPlace: acc.inPlace + r.inPlace, total: acc.total + r.total }),
                { inPlace: 0, total: 0 });
      expect(summed, `${id} byRole must account for every mapping`).toEqual({
        inPlace: s.practices.inPlace, total: s.practices.total,
      });
    }
  });
});

describe('the principle axis splits the same way', () => {
  // Both checks below iterate per stage rather than through a merged,
  // all-stages view. calculatePrincipleScores is itself stage-scoped
  // (state, stage) -> Record<principle, EvidenceScore>, and unlike areas
  // (which each belong to exactly one stage, so there's nothing to collide),
  // the same principle name recurs across multiple stages -- e.g. "Fairness
  // & Non-discrimination" is asked in pre-processing, in-processing, AND
  // post-processing. Merging those three stage-scoped maps into one by
  // Object.assign(out, ...principle-name-keyed maps) lets whichever stage
  // is merged last silently clobber an earlier stage's correctly-computed
  // checklist coverage for the same principle name, purely as an artifact
  // of the merge, not of calculatePrincipleScores itself: confirmed by
  // calling calculatePrincipleScores(state, 'pre-processing') directly,
  // which does return non-null practices coverage for "Proportionality & Do
  // Not Harm" -- it is only the naive same-name merge across stages that
  // loses it.

  it('counts a checklist question by its own options, not through optionGapMap', () => {
    const state = build(1, 'all');

    for (const stage of Object.keys(qb.stages)) {
      const scores = calculatePrincipleScores(state, stage);

      // Principles that own at least one checklist question in THIS stage,
      // read from content.
      const owning = new Set();
      for (const m of qb.stages[stage].modules ?? []) for (const q of m.questions ?? []) {
        if (q.type === 'checklist' && q.principle) owning.add(q.principle);
      }

      for (const [name, s] of Object.entries(scores)) {
        expect(s.maturity, `${stage}/${name} maturity at "Minimally"`).toBe(25);
        if (owning.has(name)) {
          expect(s.practices, `${stage}/${name} should carry coverage`).not.toBeNull();
          expect(s.practices.inPlace).toBe(s.practices.total);
        }
      }
    }
  });

  it('leaves byRole empty on the principle axis, where roles do not apply', () => {
    const state = build(3, 'all');
    for (const stage of Object.keys(qb.stages)) {
      const scores = calculatePrincipleScores(state, stage);
      for (const [name, s] of Object.entries(scores)) {
        if (s.practices) expect(s.practices.byRole, `${stage}/${name}`).toEqual({});
      }
    }
  });
});

describe('O-2 (principle axis): absent checklist evidence is null, not zero', () => {
  it('returns practices null for exactly the stage x principle cells with no checklist question', () => {
    const state = build(2, 'all');

    // Every (stage, principle) cell that owns at least one principle-tagged
    // question, and the subset of those cells that own a checklist question --
    // both read from the question bank rather than hard-coded, so a content
    // change (a checklist added/removed for some principle) moves this test's
    // expectations along with it instead of leaving it silently stale.
    const cells = new Set();
    const checklistCells = new Set();
    for (const [stage, sd] of Object.entries(qb.stages)) {
      for (const m of sd.modules ?? []) for (const q of m.questions ?? []) {
        if (!q.principle) continue;
        const key = `${stage}||${q.principle}`;
        cells.add(key);
        if (q.type === 'checklist') checklistCells.add(key);
      }
    }

    // A shape-only per-cell check ("is this cell null?") cannot tell a correct
    // 14-of-19 split from a bug that nulls every cell, because the 14 that
    // should be null would still look right. Asserting the positive case
    // (checklist cells stay non-null) alongside a total-null-count match
    // against the content-derived split closes that gap.
    let nullCount = 0;
    for (const key of cells) {
      const [stage, principle] = key.split('||');
      const s = calculatePrincipleScores(state, stage)[principle];
      if (checklistCells.has(key)) {
        expect(s.practices, `${key}`).not.toBeNull();
      } else {
        expect(s.practices, `${key}`).toBeNull();
        nullCount += 1;
      }
    }

    expect(nullCount, 'cells with no checklist question, reporting practices: null')
      .toBe(cells.size - checklistCells.size);
  });
});

describe('O-4: overall readings exclude absent evidence rather than zeroing it', () => {
  // generateReportData takes a whole EngineState, and 0 of 21 shipped areas
  // (0 of 19 shipped stage x principle cells) ever produce maturity: null --
  // there is no way to make a real, engine-built report contain a null
  // maturity reading. A test that only ever drives meanMaturity through
  // generateReportData therefore cannot prove null-exclusion actually does
  // anything: reverting `.filter((m) => m !== null)` to `.map((m) => m ?? 0)`
  // inside meanMaturity would leave every such report-level assertion
  // passing unchanged, because there is never a null in the input to begin
  // with (see the second O-7 note below for the measured proof of that).
  // meanMaturity is exported specifically so a test can hand it a fabricated
  // map containing a null directly, which is the only way to exercise the
  // exclusion at all.
  it('meanMaturity excludes a null reading from the mean, not zeroing it', () => {
    // A null counted as 0 would drag {100, null} to 50; excluding it keeps 100.
    expect(meanMaturity([{ a: { maturity: 100 }, b: { maturity: null } }])).toBe(100);
  });

  it('meanMaturity returns null, not 0, when every reading is absent', () => {
    // Decision: "no reading anywhere" is a different claim from "scored
    // zero" -- the same convention EvidenceScore.maturity itself already
    // uses for a single area/principle. meanMaturity preserves that
    // convention rather than collapsing "nothing to average" into a number
    // that looks like a real (bad) score. generateReportData is the one
    // place that must still produce a plain, non-null overallScore --
    // dashboard surfaces read it straight off a database column -- so IT
    // coerces null to 0 at the call site (see the next test); meanMaturity
    // itself stays honest about "no data" for any other caller.
    expect(meanMaturity([{ a: { maturity: null }, b: { maturity: null } }])).toBeNull();
    expect(meanMaturity([])).toBeNull();
  });

  it('generateReportData coerces "no reading anywhere" to overallScore 0 at its boundary', () => {
    const report = generateReportData(createAssessment()); // no stage completed
    expect(report.overallScore).toBe(0);
    expect(report.overallPractices).toBeNull();
  });

  it('meanMaturity reproduces the real-content expectation: 75 at "Mostly"', () => {
    const report = generateReportData(build(3, 'all'));
    expect(meanMaturity(Object.values(report.stageScores))).toBe(75);
  });

  it('averages only areas that carry a maturity reading', () => {
    const report = generateReportData(build(3, 'all')); // "Mostly" everywhere
    const maturities = Object.values(report.stageScores)
      .flatMap((areas) => Object.values(areas))
      .map((s) => s.maturity)
      .filter((m) => m !== null);

    const expected = Math.round(maturities.reduce((a, b) => a + b, 0) / maturities.length);
    // Every area answered "Mostly" scores 75, so a null counted as 0 would drag
    // this below 75 and the assertion would catch it.
    expect(report.overallScore).toBe(expected);
    expect(report.overallScore).toBe(75);
  });

  it('sums practice coverage across every area that has any', () => {
    const report = generateReportData(build(3, 'all'));
    const all = Object.values(report.stageScores).flatMap((a) => Object.values(a));
    const expectedTotal = all.reduce((n, s) => n + (s.practices?.total ?? 0), 0);

    // Not every area has checklist evidence (15 of 21, read from content
    // above via areasWithChecklistEvidence) -- so this sum already has to
    // skip real nulls, not just a fabricated one, to land on the right total.
    expect(report.overallPractices.total).toBe(expectedTotal);
    expect(report.overallPractices.inPlace).toBe(expectedTotal); // all boxes ticked
  });

  it('merges byRole additively across every area, not overwriting between areas', () => {
    const report = generateReportData(build(3, 'all'));
    const all = Object.values(report.stageScores).flatMap((a) => Object.values(a));
    const expectedByRole = {};
    for (const s of all) {
      if (!s.practices) continue;
      for (const [role, r] of Object.entries(s.practices.byRole)) {
        expectedByRole[role] ??= { inPlace: 0, total: 0 };
        expectedByRole[role].inPlace += r.inPlace;
        expectedByRole[role].total += r.total;
      }
    }
    expect(report.overallPractices.byRole).toEqual(expectedByRole);
  });

  it('stamps the new scoring version', () => {
    expect(SCORING_VERSION).toBe('5.0.0');
    expect(generateReportData(build(3, 'all')).scoringVersion).toBe('5.0.0');
  });
});
