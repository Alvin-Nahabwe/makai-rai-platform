import { describe, it, expect, vi } from 'vitest';

/**
 * Fix round 1, Finding 1 (task-9c-report.md): getAreaScore's "unknown area"
 * branch (a crossStageWeights rule's `sourceArea` that doesn't resolve to
 * any id in data/assessmentAreas.json) now returns `null`, matching its own
 * doc comment and the same "absence of evidence is not evidence of
 * weakness" reasoning applied to a genuinely unasked area elsewhere in this
 * function. Before that fix it returned 0, which -- since `0 < 50` is true
 * -- would have made a rule with a typo'd or renamed sourceArea fire on
 * every assessment, spuriously, regardless of any real answer.
 *
 * This path is unreachable through the shipped data/scoringConfig.json:
 * every real rule's sourceArea resolves (verified separately). The only way
 * to exercise it without editing data/*.json (out of scope for this task)
 * or exporting the private getAreaScore function (a bigger API change than
 * asked for) is to substitute a fabricated scoringConfig for this one test
 * file's own module graph, via vi.mock -- which does not touch the real
 * file on disk and, because vitest isolates each test file's module
 * registry by default, cannot leak into any other test file.
 */
vi.mock('../../data/scoringConfig.json', async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default ?? actual;
  return {
    default: {
      ...real,
      crossStageWeights: {
        ...real.crossStageWeights,
        pre_to_in: [
          ...(real.crossStageWeights.pre_to_in ?? []),
          {
            id: 'CSW-TEST-UNRESOLVED-AREA',
            sourceMetric: 'areaScore',
            sourceArea: 'PP-DOES-NOT-EXIST',
            threshold: 50,
            targetQuestions: ['Q-IP-01'],
            modifier: 1.9,
            rationale: 'test-only: sourceArea does not resolve to any shipped area',
            citation: 'n/a',
          },
        ],
      },
    },
  };
});

describe('getAreaScore: a sourceArea that does not resolve must not fire spuriously', () => {
  it('does not activate a rule whose sourceArea is absent from assessmentAreas.json', async () => {
    const { createAssessment, getModifiedWeights } = await import('../../lib/engine/AssessmentEngine.js');

    // Fresh, entirely unanswered state -- getApplicableRules doesn't gate
    // on stage completion, so this is enough to evaluate pre_to_in rules
    // against 'in-processing' (confirmed against the real config by the
    // existing 'empty state' test in AssessmentEngine.test.js).
    const state = createAssessment();
    const weights = getModifiedWeights(state, 'in-processing');

    expect(weights['Q-IP-01']).toBeDefined();
    // If the unknown-area branch still coerced to 0 (the pre-fix
    // behaviour), `0 < 50` is true and CSW-TEST-UNRESOLVED-AREA would have
    // pushed Q-IP-01's modifier to 1.9. null-exclusion means it must not.
    expect(weights['Q-IP-01'].rules).not.toContain('CSW-TEST-UNRESOLVED-AREA');
    expect(weights['Q-IP-01'].modifier).toBe(1.0);
  });
});
