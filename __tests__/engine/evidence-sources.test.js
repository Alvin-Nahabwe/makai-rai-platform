import { describe, it, expect } from 'vitest';
import {
  createAssessment, setResponse, evidenceSourcesForArea, calculateAreaScores,
} from '../../lib/engine/AssessmentEngine.js';
import questionBank from '../../data/questionBank.json' with { type: 'json' };
import assessmentAreas from '../../data/assessmentAreas.json' with { type: 'json' };

/**
 * ENG-03 prerequisite P-b. One rule for "what counts as evidence for an
 * area", consumed by both the score and the narrative, so they cannot
 * disagree about the same answer again.
 */
function allQuestions() {
  const out = [];
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.id && n.type) out.push(n);
      Object.values(n).forEach(walk);
    }
  })(questionBank.stages);
  return out;
}
const area = (id) => assessmentAreas.areas.find((a) => a.id === id);
const GATE = allQuestions().find((q) => q.type === 'gate');
const GATED = allQuestions().find((q) => q.condition?.questionId === GATE.id);

function answeredPreProcessing(gateAnswer) {
  let s = createAssessment();
  for (const q of allQuestions().filter((q) => q.id.startsWith('Q-PP'))) {
    if (q.type === 'gate') s = setResponse(s, 'pre-processing', q.id, gateAnswer);
    else if (q.type === 'likert-5') s = setResponse(s, 'pre-processing', q.id, 4);
    else if (q.type === 'checklist') s = setResponse(s, 'pre-processing', q.id, (q.options ?? []).map((o) => o.value ?? o));
  }
  return s;
}

describe('gate conditions are enforced, and are not a policy choice', () => {
  it('includes a gated question while its gate is satisfied', () => {
    const s = answeredPreProcessing('Yes');
    const ids = evidenceSourcesForArea(s, area(GATED.gaps[0])).map((e) => e.question.id);
    expect(ids).toContain(GATED.id);
  });

  it('drops it once the gate is un-satisfied, even though the answer is still stored', () => {
    // The reachable defect: answer the gate Yes, answer its dependent
    // question, then set the gate to No. The response persists in storage, so
    // anything not enforcing q.condition still treats it as evidence — which
    // is how an area could score 100 and be listed as a gap at the same time.
    const flipped = setResponse(answeredPreProcessing('Yes'), 'pre-processing', GATE.id, 'No');
    const ids = evidenceSourcesForArea(flipped, area(GATED.gaps[0])).map((e) => e.question.id);
    expect(ids).not.toContain(GATED.id);
  });

  it('never returns the gate question itself as evidence', () => {
    const s = answeredPreProcessing('Yes');
    for (const a of assessmentAreas.areas) {
      const ids = evidenceSourcesForArea(s, a, { scope: 'all-stages' }).map((e) => e.question.id);
      expect(ids).not.toContain(GATE.id);
    }
  });
});

describe('scope is the ENG-03 fork, and defaults to preserving current behaviour', () => {
  it("'area-stage' returns only questions from the area's own stage", () => {
    const s = answeredPreProcessing('Yes');
    for (const a of assessmentAreas.areas) {
      for (const { stage } of evidenceSourcesForArea(s, a, { scope: 'area-stage' })) {
        expect(stage).toBe(a.stage);
      }
    }
  });

  it("defaults to 'area-stage', so the score is unchanged until ENG-03 is applied", () => {
    const s = answeredPreProcessing('Yes');
    const a = area('PO-07');
    expect(evidenceSourcesForArea(s, a)).toEqual(evidenceSourcesForArea(s, a, { scope: 'area-stage' }));
  });

  it("'all-stages' reaches strictly more evidence for an area the audit named", () => {
    // PO-07 "Documentation Deficit" loses 4 of its 7 likert sources under the
    // stage-local rule. Only pre-processing is completed here, so the extra
    // sources are the pre-processing ones.
    let s = answeredPreProcessing('Yes');
    s = { ...s, stages: { ...s.stages, 'pre-processing': { ...s.stages['pre-processing'], status: 'completed' } } };
    const own = evidenceSourcesForArea(s, area('PO-07'), { scope: 'area-stage' }).length;
    const all = evidenceSourcesForArea(s, area('PO-07'), { scope: 'all-stages' }).length;
    expect(all).toBeGreaterThan(own);
  });
});

describe('the scorer and this function agree on what it counts', () => {
  it('an area with no evidence sources has null maturity, and one with sources does not throw', () => {
    // `sources.length === 0` and `calculateAreaScores`' Source 1 loop draw
    // from the same evidenceSourcesForArea(state, area) call (default
    // 'area-stage' scope), so zero sources means zero contribution to
    // totalWeight, which calculateAreaScores reports as `maturity: null`
    // ("no judgement question mapped" = never asked), not 0 ("asked and
    // scored the worst"). Unreached by any shipped pre-processing area
    // today -- confirmed live, all 7 have >=2 sources -- kept as a
    // guard against a future area shipping with no mapped question.
    const s = answeredPreProcessing('Yes');
    const scores = calculateAreaScores(s, 'pre-processing');
    for (const a of assessmentAreas.areas.filter((a) => a.stage === 'pre-processing')) {
      const sources = evidenceSourcesForArea(s, a);
      if (sources.length === 0) {
        expect(scores[a.id].maturity, a.id).toBeNull();
      } else {
        expect(typeof scores[a.id].maturity, a.id).toBe('number');
      }
    }
  });
});
