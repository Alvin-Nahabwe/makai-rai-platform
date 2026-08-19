import { describe, it, expect } from 'vitest';
import { getLevel, computeFindingsData } from '@/components/report/useFindingsData';
import { createAssessment, calculateAreaScores } from '@/lib/engine/AssessmentEngine';
import { levelLabels, levelColors, levelDescriptions } from '@/data/constants';
import type { ReportData, EvidenceScore } from '@/types/domain';

/**
 * Task 4 (2026-08-19-practices-maturity-split). `getLevel` now takes
 * `number | null` and the hook reads `.maturity` off each EvidenceScore
 * instead of treating the score map's values as bare numbers -- see
 * task-4-brief.md.
 */
describe('tier classification reads maturity, and null is not a gap', () => {
  it('classifies from a maturity percentage exactly as before', () => {
    expect(getLevel(75)).toBe('strong');
    expect(getLevel(50)).toBe('developing');
    expect(getLevel(25)).toBe('needsWork');
    expect(getLevel(0)).toBe('critical');
  });

  it('has a distinct answer for "not asked" that is not the worst band', () => {
    expect(getLevel(null)).toBe('notAssessed');
    expect(getLevel(null)).not.toBe('critical');
  });
});

function evidenceScore(maturity: number | null): EvidenceScore {
  return { maturity, practices: null };
}

function baseReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    version: '4.0.0',
    generatedAt: '2026-08-19T00:00:00.000Z',
    completedStages: ['pre-processing'],
    overallScore: 0,
    overallPractices: null,
    stageScores: {},
    principleScores: {},
    activeModifiers: [],
    unlockedConditionals: [],
    ...overrides,
  };
}

/**
 * `computeFindingsData` is `useFindingsData`'s `useMemo` body, factored out
 * so it can be called without a React render pass -- this repo has no
 * jsdom/@testing-library/react (D-169), and React throws "Invalid hook
 * call" for any hook (including a bare `useMemo`) invoked outside a
 * component. Confirmed empirically: `require('react').useMemo(() => 1, [])`
 * called from plain Node throws exactly that. `computeFindingsData` takes
 * the same `ReportData | null` / `EngineState | null` the hook does, so it
 * is fabricable the same way `report-provenance.test.tsx` fabricates a
 * `ReportData` for `ReportPdf`/`ReportSummary` (also plain functions, for
 * the same reason).
 */
describe('computeFindingsData reads EvidenceScore.maturity, not the wrapper object', () => {
  it('carries a real maturity number through to pct and level unchanged', () => {
    const report = baseReport({
      principleScores: { 'pre-processing': { 'Fabricated Principle': evidenceScore(82) } },
    });
    const result = computeFindingsData(report, createAssessment());
    const [entry] = result.allPrincipleResults['pre-processing'];
    expect(entry.pct).toBe(82);
    expect(entry.level).toBe('strong');
  });

  it('routes a null-maturity principle to notAssessed, never to critical', () => {
    const report = baseReport({
      principleScores: { 'pre-processing': { 'Fabricated Principle': evidenceScore(null) } },
    });
    const result = computeFindingsData(report, createAssessment());
    const [entry] = result.allPrincipleResults['pre-processing'];
    expect(entry.pct).toBeNull();
    expect(entry.level).toBe('notAssessed');
  });

  it('sorts a null-maturity principle after every scored principle -- never as if it scored zero', () => {
    const report = baseReport({
      principleScores: {
        'pre-processing': {
          'Never Asked': evidenceScore(null),
          'Scored Zero': evidenceScore(0),
          'Scored High': evidenceScore(90),
        },
      },
    });
    const result = computeFindingsData(report, createAssessment());
    const names = result.allPrincipleResults['pre-processing'].map((p) => p.name);
    expect(names).toEqual(['Scored Zero', 'Scored High', 'Never Asked']);
  });

  it('returns the same empty-state shape when there is no completed stage (unchanged pre-existing behaviour)', () => {
    const report = baseReport({ completedStages: [] });
    const result = computeFindingsData(report, createAssessment());
    expect(result).toEqual({
      allPrincipleResults: {},
      gaps: [],
      attentions: [],
      strengths: [],
      notAssessed: [],
      gapEvidence: {},
      attentionEvidence: {},
      strengthEvidence: {},
      controlsMap: {},
      practiceItems: {},
    });
  });
});

/**
 * The defect this task also fixes, found while implementing it (not in the
 * brief): `getLevel` can now return 'notAssessed', but `levelLabels`/
 * `levelColors`/`levelDescriptions` in data/constants.ts had only the four
 * original keys. Each map's index signature made `levelColors['notAssessed']`
 * type-check fine while evaluating to `undefined` at runtime -- an
 * undefined colour, a blank label, and a score-ring aria-label reading
 * literally "undefined" (components/report/ReportSummary.tsx's
 * `aria-label={... ${levelLabels[overallLevel]}}`), all invisible to
 * `tsc --noEmit`.
 */
describe('data/constants: the notAssessed tier has real entries, not an index-signature gap', () => {
  it('defines a label, color, and description for notAssessed', () => {
    expect(levelLabels.notAssessed).toBeTruthy();
    expect(levelColors.notAssessed).toBeTruthy();
    expect(levelDescriptions.notAssessed).toBeTruthy();
  });

  it('uses a color none of the four severity tiers use, so it never reads as a fifth, worse score', () => {
    const severityColors = [levelColors.critical, levelColors.needsWork, levelColors.developing, levelColors.strong];
    expect(severityColors).not.toContain(levelColors.notAssessed);
  });

  it('never tells the user they failed to answer -- the framework had nothing to ask', () => {
    const blamePattern = /you (?:didn't|did not|failed to)|skipped|unanswered|no response|forgot/i;
    expect(levelLabels.notAssessed).not.toMatch(blamePattern);
    expect(levelDescriptions.notAssessed).not.toMatch(blamePattern);
    // Positive check, not just an absence of blame words: the copy should
    // actually say there was nothing to answer, per the brief's wording
    // constraint ("nothing to answer", not "nothing was answered").
    expect(levelDescriptions.notAssessed).toMatch(/nothing to answer/i);
  });
});

/**
 * Task 5b: `practiceItems` is the per-item detail behind an area's
 * `PracticeCoverage` count. It is built in `computeFindingsData` by the
 * SAME `optionGapMap` walk that `calculateAreaScores` ("Source 2",
 * lib/engine/AssessmentEngine.js) counts by -- this proves the two are
 * actually the same count on real shipped content, not just by argument.
 * Two pre-processing checklist questions (Q-PP-16, Q-PP-17) between them
 * map four options to PP-02 -- one primary, three supporting -- so this
 * exercises role-carrying and ticked/unticked together without a fabricated
 * fixture drifting from what the shipped question bank actually contains.
 */
describe('practiceItems mirrors calculateAreaScores exactly, on real content', () => {
  it('lists PP-02 with the same count, in-place total, and roles the engine scores it with', () => {
    const engineState = createAssessment();
    engineState.stages['pre-processing'].responses['Q-PP-16'] = ['Missing data analysis'];
    // Q-PP-17 also maps options to PP-02 (see block comment). Answered with
    // nothing checked, not left absent: an absent response key means "the
    // engine's own `calculateAreaScores` skips this question entirely"
    // (its `qResponses[q.id] === undefined` guard), which a genuinely
    // completed stage would not produce for a required question -- leaving
    // it absent here would silently test a state a real completed
    // assessment cannot reach.
    engineState.stages['pre-processing'].responses['Q-PP-17'] = [];
    engineState.stages['pre-processing'].status = 'completed';

    const report = baseReport({ completedStages: ['pre-processing'] });
    const result = computeFindingsData(report, engineState);

    const engineCoverage = calculateAreaScores(engineState, 'pre-processing')['PP-02'].practices;
    const items = result.practiceItems['PP-02'];

    // Fails loudly, not with a null-pointer TypeError, if the fixture ever
    // stops answering enough of the checklist to produce coverage at all.
    expect(engineCoverage).not.toBeNull();
    if (!engineCoverage) throw new Error('unreachable: asserted above');

    // The invariant under test: the itemised list and the engine's own
    // PracticeCoverage count are the SAME numbers, not two independent
    // tallies that happen to agree on this fixture.
    expect(items).toHaveLength(engineCoverage.total);
    expect(items.filter((i) => i.checked)).toHaveLength(engineCoverage.inPlace);
    expect(items.map((i) => i.role).sort()).toEqual(['primary', 'supporting', 'supporting', 'supporting']);
    expect(items.find((i) => i.label === 'Missing data analysis')).toMatchObject({ role: 'primary', checked: true });
    expect(items.find((i) => i.label === 'Class imbalance analysis')).toMatchObject({ role: 'supporting', checked: false });
  });
});
