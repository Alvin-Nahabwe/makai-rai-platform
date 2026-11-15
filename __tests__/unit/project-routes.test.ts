import { describe, expect, it } from 'vitest';
import type { DecisionVersionView } from '@/types/api';
import { STAGES, type Stage, type StoredDecisionStatus, type ScopeAnswer } from '@/types/record';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { shapeProjectRoutes } from '@/lib/project/routes';

/**
 * The project page's per-stage routes (lane 4 Task A), shaped from the current decisions of each stage: one stop per
 * question in question order with the stage page's mark rule, the tally, and the questions with no decision in words.
 * The content is the fixture bundle (__tests__/setup/content.ts). That the marks equal the stage page's for the same
 * stored data is pinned against the database in __tests__/integration/project-routes.test.ts.
 */
const content = runningContent();
const GATE = 'Q-PP-GATE-SENSITIVE';

function version(questionId: string, status: StoredDecisionStatus | null, extra: Partial<DecisionVersionView> = {}): DecisionVersionView {
  return {
    questionId, status, scopeAnswer: null, evidence: [], versionNumber: 1, declaredDate: null, optionsInPlace: [], ...extra,
  } as unknown as DecisionVersionView;
}
const none = (): Record<Stage, Map<string, DecisionVersionView>> => Object.fromEntries(STAGES.map((s) => [s, new Map()])) as Record<Stage, Map<string, DecisionVersionView>>;
const shape = (current: Record<Stage, Map<string, DecisionVersionView>>) => shapeProjectRoutes({ content, current, orgSlug: 'o', projectId: 'p1' });

describe('shapeProjectRoutes', () => {
  it('one stop per question of each stage, in question order, each linking to its question; nothing recorded is all No decision', () => {
    const routes = shape(none());
    for (const s of STAGES) {
      const questions = questionsInStage(content, s);
      expect(routes[s].stops.map((x) => x.id)).toEqual(questions.map((q) => q.id));
      expect(routes[s].stops.map((x) => x.title)).toEqual(questions.map((q) => q.text));
      expect(routes[s].stops[0].href).toBe(`/orgs/o/projects/p1/stages/${s}/questions/${questions[0].id}`);
      expect(new Set(routes[s].stops.map((x) => x.kind))).toEqual(new Set(['no_decision']));
      expect(routes[s].noDecision.map((q) => q.id)).toEqual(questions.map((q) => q.id));
      expect(routes[s].noDecision[0]).toEqual({ id: questions[0].id, text: questions[0].text, href: routes[s].stops[0].href });
    }
  });

  it('a status is its mark, a withdrawal is no decision, the answered gate is "answered" and a No answer makes its questions not apply', () => {
    const current = none();
    current['pre-processing'].set('Q-PP-01', version('Q-PP-01', 'done'));
    current['pre-processing'].set('Q-PP-02', version('Q-PP-02', 'done', { evidence: [{}] as DecisionVersionView['evidence'] }));
    current['pre-processing'].set('Q-PP-04', version('Q-PP-04', 'partly'));
    current['pre-processing'].set('Q-PP-07', version('Q-PP-07', 'withdrawn'));
    current['pre-processing'].set(GATE, version(GATE, null, { scopeAnswer: 'no' as ScopeAnswer }));
    current['in-processing'].set('Q-IP-01', version('Q-IP-01', 'not_applicable'));
    const routes = shape(current);
    const kind = (s: Stage, id: string) => routes[s].stops.find((x) => x.id === id)?.kind;
    expect(kind('pre-processing', 'Q-PP-01')).toBe('done');
    expect(kind('pre-processing', 'Q-PP-04')).toBe('partly');
    expect(kind('pre-processing', 'Q-PP-07')).toBe('no_decision');
    expect(kind('pre-processing', GATE)).toBe('scope_answered');
    expect(routes['pre-processing'].stops.find((x) => x.id === GATE)?.scopeAnswer).toBe('no');
    expect(kind('pre-processing', 'Q-PP-13')).toBe('does_not_apply');
    expect(kind('pre-processing', 'Q-PP-14')).toBe('does_not_apply');
    expect(kind('in-processing', 'Q-IP-01')).toBe('not_applicable');
    expect(routes['pre-processing'].tally).toMatchObject({ done: 2, partly: 1, scope_answered: 1, does_not_apply: 2, doneNoEvidence: 1 });
    // The named list is the no-decision stops, in order: the withdrawn one included, the gated and the answered gate not.
    const named = routes['pre-processing'].noDecision.map((q) => q.id);
    expect(named).toContain('Q-PP-07');
    expect(named).not.toContain('Q-PP-13');
    expect(named).not.toContain(GATE);
    expect(named).toEqual(routes['pre-processing'].stops.filter((x) => x.kind === 'no_decision').map((x) => x.id));
  });
});
