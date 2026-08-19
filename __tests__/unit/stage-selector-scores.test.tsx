import { describe, it, expect, vi } from 'vitest';
import {
  createAssessment,
  setResponse,
  completeStage,
} from '@/lib/engine/AssessmentEngine.js';
import questionBankRaw from '@/data/questionBank.json';
import type { EngineState, QuestionBank } from '@/types/domain';
import { extractText } from '../helpers/extractText';

const questionBank = questionBankRaw as unknown as QuestionBank;
const noop = () => {};
const BASE_PROPS = { onRestart: noop, onSelectStage: noop, onViewReport: noop, canRestart: false };

/**
 * Task 11 seam test.
 *
 * `calculateAreaScores` has returned `EvidenceScore` objects (`{maturity,
 * practices}`) since Task 1, but `StageSelector` -- one of the three
 * assessment-flow consumers this branch's plan never listed -- kept doing
 * `Object.values(areaScores).reduce((s, v) => s + v, 0)`. Adding numbers to
 * `EvidenceScore` objects coerces each one to the string "[object Object]",
 * then to `NaN`, silently: no test caught it because no test exercised this
 * component with the shape the engine has produced since Task 1 (sixteen
 * commits shipped this crash). `StageSelector` is hook-free (no
 * `useState`/`useEffect`/`useRef` in its body), so it is called directly
 * and walked with `extractText`, per __tests__/unit/area-card.test.tsx's
 * and __tests__/unit/dashboard-scores.test.tsx's identical pattern (D-169:
 * no jsdom/@testing-library/react in this repo).
 *
 * Real `EngineState` fixtures for the main case, not hand-built ones: this
 * seam is about the shape `calculateAreaScores` actually returns for real
 * content, which a fabricated `{ maturity: 25, practices: null }` map
 * would beg the question of.
 */
function buildCompletedStage(stage: string, likert: number, checklist: 'all' | 'none'): EngineState {
  let state = createAssessment();
  const stageDef = questionBank.stages[stage];
  for (const mod of stageDef.modules) {
    for (const q of mod.questions) {
      if (q.type === 'likert-5') {
        state = setResponse(state, stage, q.id, likert);
      } else if (q.type === 'checklist') {
        state = setResponse(state, stage, q.id, checklist === 'all' ? (q.options ?? []) : []);
      } else if (q.type === 'gate') {
        state = setResponse(state, stage, q.id, (q.options ?? ['Yes'])[0]);
      }
    }
  }
  return completeStage(state, stage) as EngineState;
}

describe('StageSelector renders the maturity reading, not the EvidenceScore object (Task 11 seam)', () => {
  it('shows the aggregated maturity percentage for a completed stage, never the raw object or NaN', async () => {
    const { StageSelector } = await import('@/components/assessment/StageSelector');

    // Likert index 1 -> 25% (__tests__/engine/score-split.test.js's O-1
    // case). Deliberately not a multiple of 10, so "not.toContain('0%')"
    // in the null-handling test below is a meaningful assertion rather
    // than one that would trip on its own positive match -- the same
    // reason area-card.test.tsx avoids likert values whose percentage
    // contains "0%" as a substring.
    const state = buildCompletedStage('pre-processing', 1, 'all');
    const out = extractText(StageSelector({ engineState: state, ...BASE_PROPS }));

    expect(out).toContain('25%');
    // The exact failure mode the original bug produced: reducing over
    // EvidenceScore objects with `+` coerces each one to "[object Object]"
    // en route to NaN.
    expect(out).not.toContain('[object Object]');
    expect(out).not.toMatch(/NaN/);
  });
});

/**
 * `avgMaturity === null` (every area in the stage carrying no maturity
 * reading at all) is not reachable through real shipped content: an
 * unanswered maturity question still contributes its worst-case
 * `normalizeResponse` value (0) to the weighted average, so a completed
 * stage with zero responses scores 0%, not null -- confirmed live: the
 * first version of this test built exactly that scenario with real
 * `data/questionBank.json` content and got "0%" back, not "No maturity
 * questions". `calculateAreaScores`'s own doc comment says the same thing
 * a different way: "0 of 21 areas lack a ... question" -- null needs an
 * area with NO maturity question mapped to it in content, a fact about
 * `data/assessmentAreas.json`/`data/questionBank.json`, not about which
 * responses a user gave. `meanMaturity`'s null-exclusion itself is already
 * covered directly (`__tests__/engine/score-split.test.js`); what is
 * NOT covered anywhere else is that `StageSelector` renders that null as
 * text rather than coercing it to "0%" -- so this mocks just
 * `calculateAreaScores`, keeping every other export (`meanMaturity`
 * included) real, to exercise that rendering branch without depending on
 * a future content change to reach it.
 */
describe('StageSelector treats a null aggregate maturity as text, not zero (defensive branch)', () => {
  it('says no maturity questions rather than 0% when every area in the stage carries none', async () => {
    vi.resetModules();
    vi.doMock('@/lib/engine/AssessmentEngine.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/lib/engine/AssessmentEngine.js')>();
      return {
        ...actual,
        calculateAreaScores: () => ({ 'PP-01': { maturity: null, practices: null } }),
      };
    });
    const { StageSelector } = await import('@/components/assessment/StageSelector');
    const { createAssessment: createAssessmentMocked, completeStage: completeStageMocked } =
      await import('@/lib/engine/AssessmentEngine.js');

    const state = completeStageMocked(createAssessmentMocked(), 'pre-processing', { skipValidation: true }) as EngineState;
    const out = extractText(StageSelector({ engineState: state, ...BASE_PROPS }));

    expect(out).toContain('No maturity questions');
    expect(out).not.toContain('0%');
    expect(out).not.toMatch(/NaN/);

    vi.doUnmock('@/lib/engine/AssessmentEngine.js');
    vi.resetModules();
  });
});
