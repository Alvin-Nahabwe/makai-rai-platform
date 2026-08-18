import { describe, it, expect } from 'vitest';
import areasData from '../../data/assessmentAreas.json' with { type: 'json' };
import questionBank from '../../data/questionBank.json' with { type: 'json' };
import scoringConfig from '../../data/scoringConfig.json' with { type: 'json' };


/**
 * Content integrity.
 *
 * The 2026-08-18 framework content audit found defects that no engine test
 * could see, because every one of them is a statement about the DATA rather
 * than about the code that reads it: a citation pointing at the wrong paper,
 * a control no area can reach, a scoring rule whose evidence is the phrase
 * "Multiple studies".
 *
 * These guards are deliberately written against the CLASS of defect rather
 * than the individual instances found. Pinning "PP-03 has no doi" would pass
 * forever while the next area repeats the mistake.
 */

const areas = areasData.areas;
const areaById = new Map(areas.map((a) => [a.id, a]));

/**
 * Taken from the question bank's own key order rather than written as a
 * literal, so this file cannot drift from the data it is guarding. The engine
 * declares the same order privately as STAGE_ORDER.
 */
const STAGE_ORDER = Object.keys(questionBank.stages);

/**
 * crossStageWeights is keyed by transition (pre_to_in, ...) and ALSO carries
 * scalar config (modifierCap, overlapStrategy) under the same object, so the
 * rule arrays have to be selected rather than assumed.
 */
function allCrossStageRules() {
  return Object.values(scoringConfig.crossStageWeights ?? {})
    .filter(Array.isArray)
    .flat();
}

/** Every question in the shipped bank, tagged with the stage it lives under. */
function allQuestions() {
  const out = [];
  for (const [stage, stageData] of Object.entries(questionBank.stages)) {
    for (const mod of stageData.modules ?? []) {
      for (const q of mod.questions ?? []) out.push({ ...q, stage });
    }
  }
  return out;
}

describe('citations identify the work they claim to identify', () => {
  /**
   * A DOI is an identifier, not a label: two areas may share one only when
   * they genuinely cite the same work. PP-03 carried PO-07's DOI, and
   * ReferencesList renders any doi starting "10." as a live link, so the
   * collision was reachable by a reader in one click.
   */
  it('gives two areas the same DOI only when they cite the same work', () => {
    const byDoi = new Map();
    for (const area of areas) {
      for (const ref of area.references ?? []) {
        if (!ref.doi) continue;
        if (!byDoi.has(ref.doi)) byDoi.set(ref.doi, []);
        byDoi.get(ref.doi).push({ area: area.id, citation: ref.citation });
      }
    }

    const collisions = [];
    for (const [doi, uses] of byDoi) {
      const distinct = new Set(uses.map((u) => u.citation));
      if (uses.length > 1 && distinct.size > 1) {
        collisions.push(`${doi} is used by ${uses.map((u) => u.area).join(' and ')} for ${distinct.size} different works`);
      }
    }

    expect(collisions).toEqual([]);
  });

  /**
   * "Multiple studies on X" names nothing a reader can check. It matters more
   * in scoringConfig than in prose, because these rules change scores: CSW-03
   * used the phrase as the sole support for "reduce model accuracy by 15-30%".
   */
  it('supports every scoring rule with a citation that names a source', () => {
    const placeholder = /^\s*(multiple|various|several|numerous)\s+(studies|papers|works|sources)\b/i;
    const unsourced = [];
    for (const rule of allCrossStageRules()) {
      const cites = [rule.citation].flat().filter(Boolean);
      for (const c of cites) {
        if (placeholder.test(c)) unsourced.push(`${rule.id}: "${c}"`);
      }
    }

    expect(unsourced).toEqual([]);
  });
});

describe('the lifecycle runs forward', () => {
  it('reads the three stages in the order the engine assumes', () => {
    expect(STAGE_ORDER).toEqual(['pre-processing', 'in-processing', 'post-processing']);
  });

  /**
   * ENG-03: the framework's design is a forward-only DAG. A question in a
   * later stage supplying evidence for an earlier stage's area is a content
   * defect, and three such mappings closed amplifying feedback loops with the
   * crossStageWeights rules - a rule reading an area score to raise the weight
   * of the very question that then scores that area.
   */
  it('never lets a question supply evidence for an area in an earlier stage', () => {
    const backward = [];
    for (const q of allQuestions()) {
      const from = STAGE_ORDER.indexOf(q.stage);
      for (const areaId of q.gaps ?? []) {
        const area = areaById.get(areaId);
        if (!area) continue;
        const to = STAGE_ORDER.indexOf(area.stage);
        if (to < from) backward.push(`${q.id} (${q.stage}) -> ${areaId} (${area.stage})`);
      }
    }

    expect(backward).toEqual([]);
  });

  it('points every question gap at an area that exists', () => {
    const dangling = [];
    for (const q of allQuestions()) {
      for (const areaId of q.gaps ?? []) {
        if (!areaById.has(areaId)) dangling.push(`${q.id} -> ${areaId}`);
      }
    }

    expect(dangling).toEqual([]);
  });
});

describe('every defined control can actually be recommended', () => {
  /**
   * C-28 "Codebook & Deployment Documentation" was defined but attached to no
   * area, so no report could ever surface it - including to PO-07, the
   * documentation area it was written for. A control unreachable from every
   * area is invisible work.
   */
  it('attaches every control to at least one area', () => {
    const attached = new Set(areas.flatMap((a) => a.controls ?? []));
    const orphans = (areasData.controls ?? [])
      .map((c) => c.id)
      .filter((id) => !attached.has(id));

    expect(orphans).toEqual([]);
  });

  it('references only controls that are defined', () => {
    const defined = new Set((areasData.controls ?? []).map((c) => c.id));
    const undefinedRefs = [];
    for (const a of areas) {
      for (const c of a.controls ?? []) {
        if (!defined.has(c)) undefinedRefs.push(`${a.id} -> ${c}`);
      }
    }

    expect(undefinedRefs).toEqual([]);
  });
});

describe('every scored question feeds the report', () => {
  /**
   * A question that reaches no risk area is answered, weighted and scored,
   * but nothing a user does with it can surface in the findings.
   *
   * A question reaches an area by EITHER route, and both are live in both
   * layers: `gaps` for likert questions, and `optionGapMap` for checklists
   * (AssessmentEngine.calculateAreaScores "Source 2", and
   * useFindingsData.ts:188). An earlier version of this guard tested `gaps`
   * alone and reported the five checklist questions as orphans. They are the
   * opposite of orphans -- their option mappings carry 75% of all area
   * scoring weight.
   */
  const reachesAnArea = (q) =>
    (Array.isArray(q.gaps) && q.gaps.length > 0) ||
    Object.keys(q.optionGapMap ?? {}).length > 0;

  it('has no scoring question that reaches no risk area', () => {
    const unmapped = allQuestions()
      .filter((q) => q.type !== 'gate' && !reachesAnArea(q))
      .map((q) => `${q.id} (${q.type})`);

    expect(unmapped).toEqual([]);
  });

  it('routes every checklist through optionGapMap, since its gaps array is empty', () => {
    const checklists = allQuestions().filter((q) => q.type === 'checklist');
    expect(checklists.length).toBeGreaterThan(0);

    const broken = checklists
      .filter((q) => Object.keys(q.optionGapMap ?? {}).length === 0)
      .map((q) => q.id);

    expect(broken).toEqual([]);
  });

  it('points every optionGapMap mapping at an area that exists', () => {
    const dangling = [];
    for (const q of allQuestions()) {
      for (const [opt, mappings] of Object.entries(q.optionGapMap ?? {})) {
        for (const m of mappings) {
          const id = typeof m === 'string' ? m : m.area;
          if (!areaById.has(id)) dangling.push(`${q.id} "${opt}" -> ${id}`);
        }
      }
    }

    expect(dangling).toEqual([]);
  });
});
