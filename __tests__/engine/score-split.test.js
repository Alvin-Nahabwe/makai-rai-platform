import { describe, it, expect } from 'vitest';
import {
  createAssessment, setResponse, completeStage, calculateAreaScores,
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
