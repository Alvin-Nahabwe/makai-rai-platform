import { can } from '@/lib/authz/policy';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listProjectRows, openQuestionIds } from '@/lib/data/projects';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import type { ScopeAnswer, Stage, UtcInstant } from '@/types/record';
import { lastSavedBy } from '@/lib/home/queries';
import { nextStep } from '@/lib/home/nextStep';
import type { NextStep } from '@/lib/home/types';

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
  // who has not recorded gets no next step.
  if (ctx.role !== 'assessor') return null;
  const project = (await listProjectRows(ctx)).active[0];
  if (project === undefined) return null;
  return stepIn(ctx, { projectId: project.id, projectName: project.name, stage: 'pre-processing' }, null, null);
}

/** The step in one project and stage: `nextStep` over the stage's applicable questions, in the question page's order. */
async function stepIn(
  ctx: OrgContext, where: { projectId: string; projectName: string; stage: Stage }, after: string | null, lastSavedOn: UtcInstant | null,
): Promise<NextStep | null> {
  const content = runningContent();
  const rows = await withOrg(ctx, (tx) => currentDecisionRows(tx, where.projectId, where.stage));
  const current = new Map(rows.map((r) => [r.questionId, r]));
  const applies = (id: string, gate: ScopeAnswer | null) => questionApplies(content, id, gate);
  const all = questionsInStage(content, where.stage);
  // The questions that apply under the gate's current scope answer: the list the question page counts "Question n of m" over.
  const questions = all.filter((q) => q.condition === undefined || applies(q.id, current.get(q.condition.questionId)?.scopeAnswer ?? null));
  const open = openQuestionIds({ questions: all, current, applies });
  const chosen = nextStep({ questions, open, after });
  if (chosen === null) return null;
  const n = questions.findIndex((q) => q.id === chosen.questionId) + 1;
  const question = questions[n - 1];
  return {
    projectId: where.projectId, projectName: where.projectName, stage: where.stage, questionId: chosen.questionId,
    questionText: question.text, position: { n, of: questions.length }, rule: chosen.rule, lastSavedOn,
  };
}
