import type { OrgContext } from '@/lib/data/tenant';
import { currentDecisions } from '@/lib/data/decisions';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { buildStageRows } from '@/lib/question/stageList';
import { stopsOf, tallyOfRows, type RouteStopData } from '@/lib/question/route';
import { questionHref } from '@/lib/question/draft';
import { markKindOf, type Tally } from '@/lib/ui/marks';
import type { StatusMarkKind } from '@/components/ui/types';
import type { DecisionVersionView } from '@/types/api';
import type { LoadedContent } from '@/types/content';
import { STAGES, type ScopeAnswer, type Stage } from '@/types/record';

/**
 * The project page's per-stage routes (lane 4 Task A; spec 7.2, 9.2; plan 1C Task 8): each stage as a row of marks, one per
 * question in question order, its tally, and its questions with no decision in words. The marks are the stage page's
 * (lib/question/stagePage.ts), shaped from the same exported helpers with the same rule, so S-10 and S-11 agree for the
 * same stored data (__tests__/integration/project-routes.test.ts pins it). Server only: nothing here reaches the client
 * except the words and addresses the page prints.
 */

export type NamedQuestion = { id: string; text: string; href: string };
export type StageRoute = { stops: RouteStopData[]; tally: Tally; noDecision: NamedQuestion[] };
export type ProjectRoutes = Readonly<Record<Stage, StageRoute>>;

type Current = Readonly<Record<Stage, ReadonlyMap<string, DecisionVersionView>>>;

/**
 * Pure: the routes from each stage's current decisions. The personal data question's answer is read from pre-processing,
 * where the gate is, as the stage page reads it; a withdrawn current version is no decision (FR-DEC-03).
 */
export function shapeProjectRoutes(i: { content: LoadedContent; current: Current; orgSlug: string; projectId: string }): ProjectRoutes {
  const gateId = [...i.content.questions.values()].find((q) => q.condition !== undefined)?.condition?.questionId ?? null;
  const gateVersion = gateId === null ? undefined : i.current['pre-processing'].get(gateId);
  const gate = gateVersion !== undefined && gateVersion.status !== 'withdrawn' ? (gateVersion.scopeAnswer as ScopeAnswer | null) : null;
  const out = {} as Record<Stage, StageRoute>;
  for (const stage of STAGES) {
    const current = i.current[stage];
    const rows = buildStageRows({
      questions: questionsInStage(i.content, stage), current, gate, openFindingsByQuestion: new Map(), changed: [], reworded: [],
    });
    const marks: Record<string, StatusMarkKind> = {};
    for (const r of rows) {
      const v = current.get(r.questionId);
      const decided = v === undefined || v.status === 'withdrawn' ? null : { status: v.status, scopeAnswer: v.scopeAnswer };
      marks[r.questionId] = markKindOf({
        status: decided?.status ?? null, scopeAnswer: decided?.scopeAnswer ?? null,
        gated: r.kind === 'not_applicable_by_gate', isScopeQuestion: r.questionType === 'gate',
      });
    }
    const hrefOf = (questionId: string) => questionHref({ orgSlug: i.orgSlug, projectId: i.projectId, stage }, questionId);
    const stops = stopsOf(rows, marks, hrefOf, undefined, gate);
    out[stage] = {
      stops,
      tally: tallyOfRows(rows, marks),
      noDecision: stops.filter((s) => s.kind === 'no_decision').map((s) => ({ id: s.id, text: s.title, href: s.href })),
    };
  }
  return out;
}

/**
 * PRECONDITION: the caller has already read the project under this same `ctx` and found it visible (the page:
 * `loadProjectOverview`, then `notFound()` when it is null). One read per stage, each inside `withOrg` under `ctx`
 * (`currentDecisions`), so row-level security keeps every row to the caller's organisation. No id comes from the query
 * string: `projectId` and `orgSlug` are the page's route segments.
 */
export async function loadProjectRoutes(ctx: OrgContext, p: { orgSlug: string; projectId: string }): Promise<ProjectRoutes> {
  const [pre, inP, post] = await Promise.all(STAGES.map((s) => currentDecisions(ctx, p.projectId, s)));
  return shapeProjectRoutes({
    content: runningContent(), orgSlug: p.orgSlug, projectId: p.projectId,
    current: { 'pre-processing': pre, 'in-processing': inP, 'post-processing': post },
  });
}
