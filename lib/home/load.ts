import { can } from '@/lib/authz/policy';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listProjectRows, openQuestionIds } from '@/lib/data/projects';
import { withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { ScopeAnswer, Stage, UtcInstant } from '@/types/record';
import { hasSavedAny, lastSavedBy, lastSavedIn } from '@/lib/home/queries';
import { continueTarget, nextStep } from '@/lib/home/nextStep';
import type { ContinueTarget, NextStep } from '@/lib/home/types';

/**
 * Home's "Your next step" (plan 1B rule C2, spec 9.1), server only. `userId` is the signed-in person's, from
 * `requireIdentity()` in the page (T9.2). A role that records no decision gets `null` before any read of decisions (T9.5).
 * Every read runs inside `withOrg` (T9.1) and archived projects never supply the step (T9.4). No error is caught: a failed
 * read is an error, never "no next step" (T9.7).
 */
export async function loadNextStep(ctx: OrgContext, userId: string): Promise<NextStep | null> {
  if (!can(ctx.role, 'decision:write')) return null;
  const saved = await lastSavedBy(ctx, userId);
  if (saved !== null) {
    return stepIn(ctx, { projectId: saved.projectId, projectName: saved.projectName, stage: saved.stage }, saved.questionId, saved.at);
  }
  // Never saved here: an Assessor starts in Pre-processing of the most recently updated active project; an Owner or Admin
  // who has not recorded gets no next step. An Assessor whose saves are all in projects archived since did save, so gets no
  // next step rather than a first-time reason that would be untrue (review F1).
  if (ctx.role !== 'assessor') return null;
  if (await hasSavedAny(ctx, userId)) return null;
  const project = (await listProjectRows(ctx)).active[0];
  if (project === undefined) return null;
  return stepIn(ctx, { projectId: project.id, projectName: project.name, stage: 'pre-processing' }, null, null);
}

/**
 * The step in one project and stage: `nextStep` over the stage's applicable questions, in the question page's order. Its
 * position is the question page's (`loadQuestionPanel`): the place among EVERY question of the stage, switched off by the
 * personal data answer or not, of that many (workshop walk S3), so "Question n of m" reads the same on Home and on the page.
 */
async function stepIn(
  ctx: OrgContext, where: { projectId: string; projectName: string; stage: Stage }, after: string | null, lastSavedOn: UtcInstant | null,
): Promise<NextStep | null> {
  const { questions, open } = await withOrg(ctx, (tx) => stageInputs(tx, where.projectId, where.stage));
  const chosen = nextStep({ questions, open, after });
  if (chosen === null) return null;
  const inStage = questionsInStage(runningContent(), where.stage);
  const n = inStage.findIndex((q) => q.id === chosen.questionId) + 1;
  const question = inStage[n - 1];
  return {
    projectId: where.projectId, projectName: where.projectName, stage: where.stage, questionId: chosen.questionId,
    questionText: question.text, position: { n, of: inStage.length }, rule: chosen.rule, lastSavedOn,
  };
}

/**
 * The two inputs `nextStep` takes for one stage, computed in ONE place so Home and the project page cannot differ (plan 1C
 * C11, ruling L5): the questions that apply under the gate's current scope answer, in question order (the list Previous
 * and Next walk on the question page), and the open set from `openQuestionIds`. Reads the stage's current rows on `tx`.
 */
async function stageInputs(tx: TenantTx, projectId: string, stage: Stage): Promise<StageInputs> {
  const content = runningContent();
  const rows = await currentDecisionRows(tx, projectId, stage);
  const current = new Map(rows.map((r) => [r.questionId, r]));
  const applies = (id: string, gate: ScopeAnswer | null) => questionApplies(content, id, gate);
  const all = questionsInStage(content, stage);
  const questions = all.filter((q) => q.condition === undefined || applies(q.id, current.get(q.condition.questionId)?.scopeAnswer ?? null));
  const open = openQuestionIds({ questions: all, current, applies });
  return { questions, open };
}

type StageInputs = { questions: ReadonlyArray<{ id: string; text: string }>; open: ReadonlySet<string> };

/**
 * The project page's primary action (plan 1C C11, spec 9.2), server only, on Home's rule. `userId` is the signed-in
 * person's, from `requireIdentity()` in the page (S2). A role that records no decision, or an archived project, gets `null`
 * before any read (S4). Then two transactions, one after the other, both inside `withOrg` (S1): the person's last save in
 * this project, then the three stages' current rows (one statement after another in one transaction). No error is caught
 * (S5): a failed read is an error, never "no action".
 *
 * PRECONDITION: `project` comes from a read already made under this same `ctx` (the page: `loadProjectOverview`, then
 * `notFound()`). This function does not check that the project exists or is visible: for an id with no visible row
 * (another organisation's, or none) it returns the `start` target of an empty project, built from content ids only,
 * never `null`; `archived` is trusted as given.
 */
export async function loadContinueTarget(
  ctx: OrgContext, userId: string, project: { id: string; archived: boolean },
): Promise<ContinueTarget | null> {
  if (!can(ctx.role, 'decision:write')) return null;
  if (project.archived) return null;
  const lastSave = await lastSavedIn(ctx, project.id, userId);
  // The awaits of an object literal run in order, so the three reads go one after another on the one transaction.
  const stages: Record<Stage, StageInputs> = await withOrg(ctx, async (tx) => ({
    'pre-processing': await stageInputs(tx, project.id, 'pre-processing'),
    'in-processing': await stageInputs(tx, project.id, 'in-processing'),
    'post-processing': await stageInputs(tx, project.id, 'post-processing'),
  }));
  return continueTarget(stages, lastSave);
}
