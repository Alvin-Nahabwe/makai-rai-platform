import type { OrgContext } from '@/lib/data/tenant';
import { readWorkingReport } from '@/lib/data/workingReport';
import { stagesThatApply } from '@/lib/project/applicability';
import { can } from '@/lib/authz/policy';
import { loadStagePage, type StagePageData } from '@/lib/question/stagePage';
import type { AreaGroup, WorkingReportSummary } from '@/lib/documents/workingReport';
import type { Stage, UtcInstant } from '@/types/record';

/** How many open items the end screen lists; the working report holds the rest. */
export const END_ITEMS_SHOWN = 3;

/**
 * The stage's open items for the end screen, as page 1 of the working report groups them (design G3): its groups in its order,
 * kept to the items of this stage, the first `limit` items in all, and a group with none left dropped. `more` is how many of this
 * stage's items the screen does not list. Not a second grouping: it only filters and cuts what the summary already grouped.
 */
export function endItems(summary: Pick<WorkingReportSummary, 'nextSteps'>, stage: Stage, limit = END_ITEMS_SHOWN): { groups: AreaGroup[]; more: number } {
  const own = summary.nextSteps
    .map((g) => ({ ...g, items: g.items.filter((i) => i.stage === stage) }))
    .filter((g) => g.items.length > 0);
  const total = own.reduce((n, g) => n + g.items.length, 0);
  let room = limit;
  const groups: AreaGroup[] = [];
  for (const g of own) {
    if (room === 0) break;
    const items = g.items.slice(0, room);
    room -= items.length;
    groups.push({ ...g, items });
  }
  return { groups, more: total - (limit - room) };
}

export interface StageEndData {
  /** The stage page's own read: the project's name, the stage's rows and marks, the seal step for the viewer's role. */
  page: StagePageData;
  /** When the working report's answers were read, for the draft line. */
  takenAt: UtcInstant;
  summary: WorkingReportSummary;
  /** The stages that apply to this project (G7; every stage on today's content). */
  applies: ReadonlySet<Stage>;
  /** Whether the viewer may record in this project: it decides "Start" or "View" for the next stage (ruling O1). */
  canWrite: boolean;
  /**
   * Whether the running content holds the question in that stage: the question page answers not-found for any other (panel.ts), so an
   * open item on a question a release has since removed has no page to link to (anti-goal 4: no link to a page that is not there).
   */
  hasQuestion: (stage: Stage, questionId: string) => boolean;
}

/**
 * The end-of-stage screen's data (design G3): the stage page's read for the tally and the seal step, and the working report's
 * read for page 1's grouping and the draft's time. Two reads, not one snapshot: each is its own consistent read, and a person
 * who saved a moment ago sees both after that save. Null when the project is not in the organisation (the stage page's read).
 */
export async function loadStageEnd(ctx: OrgContext, viewerId: string, projectId: string, stage: Stage): Promise<StageEndData | null> {
  const page = await loadStagePage(ctx, viewerId, projectId, stage);
  if (page === null) return null;
  const { record, summary, content } = await readWorkingReport(ctx, { userId: viewerId, role: ctx.role }, projectId);
  return {
    page, takenAt: record.takenAt, summary, applies: stagesThatApply(content, record.developmentStage),
    canWrite: can(ctx.role, 'decision:write') && !page.projectArchived,
    hasQuestion: (st, questionId) => content.questions.get(questionId)?.stage === st,
  };
}
