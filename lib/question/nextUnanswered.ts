import { withOrg, NotFoundError, type OrgContext } from '@/lib/data/tenant';
import { currentDecisions } from '@/lib/data/decisions';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { questionHref } from '@/lib/question/draft';
import { stageEndHref } from '@/lib/question/stageEndHref';
import type { ScopeAnswer, Stage } from '@/types/record';

/**
 * The next question to answer after a save (answer cost, design 2 item 3 and 8). Pure: searches `ordered` after `after`, then from the
 * start up to `after`, for an id not in `answered`; `after` itself is skipped, so a save never lands back on its own question. Null when
 * nothing else is left (every other id is answered), and for an empty list.
 */
export function pickNextUnanswered(ordered: readonly string[], answered: ReadonlySet<string>, after: string): string | null {
  const at = ordered.indexOf(after);
  // With `after` not in the list the search runs from the first id: the callers check `after` first, this only keeps the function total.
  const round = [...ordered.slice(at + 1), ...ordered.slice(0, Math.max(at, 0))];
  return round.find((id) => id !== after && !answered.has(id)) ?? null;
}

/** The stage's address, and the pieces every redirect target is built from: all server-known (the project's own org slug, its id, the checked stage). */
export type StageAddress = { orgSlug: string; projectId: string; stage: Stage };
const stageHrefOf = (a: StageAddress): string => `/orgs/${a.orgSlug}/projects/${a.projectId}/stages/${a.stage}`;

/**
 * Where the `next` page sends the browser, pure and built from server-known values only (no open redirect). `after` arrives in the URL and
 * is untrusted: it is put in the address only when it is one of the stage's own question ids (`stageQuestionIds`), where it is already a
 * known string. Anything else (missing, another stage's, an address, a path or a query trick) goes to the stage page with no `saved`
 * (owner ruling R4). `next` is the chosen question's id, or null for the stage's end screen.
 */
export function nextTarget(at: StageAddress, stageQuestionIds: readonly string[], after: string | undefined, next: string | null): string {
  const known = stageQuestionIds.find((id) => id === after);
  if (known === undefined) return stageHrefOf(at);
  const saved = `?saved=${encodeURIComponent(known)}`;
  return next === null ? `${stageEndHref(stageHrefOf(at))}${saved}` : `${questionHref(at, encodeURIComponent(next))}${saved}`;
}

/**
 * The next unanswered question of the stage after `after`, from what the project holds now: the stage's questions in content order, the
 * ones the gate switches off and the ones with a current answer that is not a withdrawal counted as done (design 8, FR-DEC-03, FR-CNT-04).
 * The gate is read as the stage page reads it (lib/question/stagePage.ts): from this stage's decisions when this is pre-processing, else
 * from pre-processing's. The switched-off ones are skipped, not removed, so the place of `after` holds when it no longer applies itself.
 * Every read goes through `ctx` (withOrg), so another organisation's rows are not seen. Null when every question that applies is answered.
 */
export async function loadNextUnanswered(ctx: OrgContext, projectId: string, stage: Stage, after: string): Promise<string | null> {
  const running = runningContent();
  const stageIds = questionsInStage(running, stage).map((q) => q.id);
  const [current, gateStage] = await Promise.all([
    currentDecisions(ctx, projectId, stage),
    stage === 'pre-processing' ? Promise.resolve(null) : currentDecisions(ctx, projectId, 'pre-processing'),
  ]);
  const gateId = [...running.questions.values()].find((q) => q.condition !== undefined)?.condition?.questionId ?? null;
  const gateVersion = gateId === null ? undefined : (gateStage ?? current).get(gateId);
  const gate = gateVersion !== undefined && gateVersion.status !== 'withdrawn' ? (gateVersion.scopeAnswer as ScopeAnswer | null) : null;
  const done = new Set(stageIds.filter((id) => {
    const v = current.get(id);
    return !questionApplies(running, id, gate) || (v !== undefined && v.status !== 'withdrawn');
  }));
  return pickNextUnanswered(stageIds, done, after);
}

/**
 * The address the `next` page redirects to. The project is read first, inside `withOrg`: one the organisation does not hold is a
 * NotFoundError (the page maps it to notFound()) whatever `after` is, so no redirect confirms or denies another organisation's project.
 * The organisation's slug comes from that read (as the stage page's does), not from the request.
 */
export async function loadNextTarget(ctx: OrgContext, projectId: string, stage: Stage, after: string | undefined): Promise<string> {
  const project = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id: projectId }, select: { org: { select: { slug: true } } } }));
  if (project === null) throw new NotFoundError();
  const at: StageAddress = { orgSlug: project.org.slug, projectId, stage };
  const ids = questionsInStage(runningContent(), stage).map((q) => q.id);
  if (after === undefined || !ids.includes(after)) return nextTarget(at, ids, undefined, null);
  return nextTarget(at, ids, after, await loadNextUnanswered(ctx, projectId, stage, after));
}
