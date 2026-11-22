import { currentDecisions } from '@/lib/data/decisions';
import type { OrgContext } from '@/lib/data/tenant';
import type { StageRow } from '@/lib/question/stageList';
import type { DecisionVersionView } from '@/types/api';
import type { Stage } from '@/types/record';

/** The page's `saved` search parameter: a string, else absent. An array (`?saved=a&saved=b`) is absent, never the first or the last. */
export function savedParam(v: string | string[] | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The stage's current decisions for the "saved" line (answer cost, design 8), read only when `saved` names one of the stage's rows:
 * a missing or foreign id costs no read. Through `ctx` (withOrg), so another organisation's rows are never seen.
 */
export async function loadSavedCurrent(
  ctx: OrgContext, projectId: string, stage: Stage, rows: readonly Pick<StageRow, 'questionId'>[], saved: string | undefined,
): Promise<ReadonlyMap<string, DecisionVersionView>> {
  if (saved === undefined || !rows.some((r) => r.questionId === saved)) return new Map();
  return currentDecisions(ctx, projectId, stage);
}
