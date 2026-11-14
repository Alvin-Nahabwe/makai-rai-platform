import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { currentDecisions } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { changedSinceSeal, listStageReviews } from '@/lib/data/reviews';
import { stageFollowUpCounts } from '@/lib/data/followup';
import { eatDate } from '@/lib/followup/overdue';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { rewordedQuestionIds } from '@/lib/question/reworded';
import { buildStageRows, type StageRow } from '@/lib/question/stageList';
import { markKindOf } from '@/lib/ui/marks';
import type { StatusMarkKind } from '@/components/ui/types';
import type { ScopeAnswer, Stage } from '@/types/record';
import type { ChangedSinceSeal, DecisionVersionView } from '@/types/api';

export interface StagePageData {
  orgSlug: string; orgId: string; projectId: string; projectName: string; projectArchived: boolean; stage: Stage; viewerId: string;
  rows: StageRow[]; nothingRecorded: boolean; changed: ChangedSinceSeal | null;
  /** The newest stage review of this stage, whose seal `changed` compares against (REV-b's listStageReviews). */
  review: { id: string; name: string } | null;
  followUp: { openFindings: number; overdueMitigations: number };
  /** Each row's status mark (spec 7.2, the kit's markKindOf), by question id: one per row. */
  marks: Record<string, StatusMarkKind>;
  /** The personal data question's current answer, so its row and its stop say "Answer: Yes"; null with none. */
  scopeAnswer: ScopeAnswer | null;
}

/**
 * S-11's data (W-2; FR-PRJ-02, FR-CNT-04, FR-CNT-06, FR-CNT-08, FR-REV-05): the stage's questions in the running
 * content's module order with each one's current decision, open findings, the newest review's "changed since seal",
 * and the reworded marker. The project is read inside `withOrg`, so another organisation's project is not found
 * (NFR-SEC-02). Each read is its producer's service; until a producer merges its stub answers an empty value.
 * Moved verbatim from the stage page (plan 1C Task 2); `marks` and `scopeAnswer` are shaped from the reads above, no new one.
 */
export async function loadStagePage(ctx: OrgContext, viewerId: string, projectId: string, stage: Stage): Promise<StagePageData | null> {
  const project = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id: projectId }, select: { name: true, archivedAt: true, org: { select: { slug: true } } } }));
  if (project === null) return null;
  const running = runningContent();
  const today = eatDate(new Date());
  const [current, findings, reviews, followUp, gateStage] = await Promise.all([
    currentDecisions(ctx, projectId, stage),
    listFindings(ctx, projectId, stage, today),
    listStageReviews(ctx, projectId, stage),
    stageFollowUpCounts(ctx, projectId, stage, today),
    stage === 'pre-processing' ? Promise.resolve(null) : currentDecisions(ctx, projectId, 'pre-processing'),
  ]);
  const gateId = [...running.questions.values()].find((q) => q.condition !== undefined)?.condition?.questionId ?? null;
  const gateVersion = gateId === null ? undefined : (gateStage ?? current).get(gateId);
  const gate = gateVersion !== undefined && gateVersion.status !== 'withdrawn' ? (gateVersion.scopeAnswer as ScopeAnswer | null) : null;
  const newest = reviews.reduce<(typeof reviews)[number] | null>((a, r) => (a === null || r.numberInStage > a.numberInStage ? r : a), null);
  const changed = newest === null ? null : await changedSinceSeal(ctx, newest.id);
  const open = new Map<string, number>();
  for (const f of findings) if (f.state === 'open' && f.questionId !== null) open.set(f.questionId, (open.get(f.questionId) ?? 0) + 1);
  const rows = buildStageRows({
    questions: questionsInStage(running, stage), current, gate, openFindingsByQuestion: open,
    changed: changed?.changedQuestions ?? [], reworded: rewordedQuestionIds(current, running),
  });
  return {
    orgSlug: project.org.slug, orgId: ctx.orgId, projectId, projectName: project.name, projectArchived: project.archivedAt !== null, stage, viewerId,
    rows, nothingRecorded: current.size === 0, changed, followUp,
    review: newest === null ? null : { id: newest.id, name: newest.name },
    marks: marksOf(rows, current),
    scopeAnswer: gate,
  };
}

/** Each row's mark: a withdrawn current version is no decision, as buildStageRows reads it (FR-DEC-03). */
function marksOf(rows: readonly StageRow[], current: ReadonlyMap<string, Pick<DecisionVersionView, 'status' | 'scopeAnswer'>>): Record<string, StatusMarkKind> {
  const marks: Record<string, StatusMarkKind> = {};
  for (const r of rows) {
    const v = current.get(r.questionId);
    const decided = v === undefined || v.status === 'withdrawn' ? null : { status: v.status, scopeAnswer: v.scopeAnswer };
    marks[r.questionId] = markKindOf({
      status: decided?.status ?? null,
      scopeAnswer: decided?.scopeAnswer ?? null,
      gated: r.kind === 'not_applicable_by_gate',
      isScopeQuestion: r.questionType === 'gate',
    });
  }
  return marks;
}
