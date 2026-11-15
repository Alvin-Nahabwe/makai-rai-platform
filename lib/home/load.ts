import { can } from '@/lib/authz/policy';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { myMitigations, projectFollowUp } from '@/lib/data/followup';
import { listProjectRows, openQuestionIds, stageView, type ProjectRow } from '@/lib/data/projects';
import { listStageReviews } from '@/lib/data/reviews';
import { withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import { questionHref } from '@/lib/question/draft';
import { markKindOf, tallyOf } from '@/lib/ui/marks';
import { STAGES, type CalendarDate, type DecisionVersionRow, type ScopeAnswer, type Stage, type UtcInstant } from '@/types/record';
import type { StageReviewView } from '@/types/api';
import { changesSince, hasSavedAny, lastSavedBy, lastSavedIn } from '@/lib/home/queries';
import { continueTarget, nextStep } from '@/lib/home/nextStep';
import type { ContinueTarget, HomeBase, HomeData, NextStep, RouteStop, StageOpen, TeamLead } from '@/lib/home/types';

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
  return stageInputsOf(stage, await currentDecisionRows(tx, projectId, stage));
}

/** `stageInputs` from rows already read: the one place the applicable questions and the open set are worked out. */
function stageInputsOf(stage: Stage, rows: readonly DecisionVersionRow[]): StageInputs {
  const content = runningContent();
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

// ─── Home's data for every role and state (plan 1B Task 9, spec 9.1) ─────────────────────────────────────────────

/** How many groups of changes Home lists before "more" (plan 1B Task 9's test: capped at 10). */
const CHANGE_GROUPS = 10;
/** The Viewer's "recorded in the last 14 days" (spec 9.1). */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Home's data (plan 1B Task 9, spec 9.1), server only. `identity` is the signed-in person's, from `requireIdentity()` in
 * the page, never a query value (T9.2). The variant comes from `ctx.role`, which `requireOrgContextFor` read on the server,
 * in review M13's order (T9.5): no active project gives `first-time` for every role; then a Viewer, a Reviewer, and
 * otherwise a person who records, with the lead lists for an Owner or Admin only. Every read runs inside `withOrg` (T9.1)
 * through the functions the plan's source table names; archived projects supply nothing but `archivedCount` (T9.4). No
 * error is caught: a failed read is an error, never an empty Home (T9.7).
 */
export async function loadHome(
  ctx: OrgContext, identity: { userId: string; name: string }, opts: { orgSlug: string; welcome: boolean; today: CalendarDate; now: Date },
): Promise<HomeData> {
  const variant = variantOf(ctx.role);
  const [{ active, archived }, org] = await Promise.all([
    listProjectRows(ctx),
    withOrg(ctx, (tx) => tx.organization.findUniqueOrThrow({ where: { id: ctx.orgId }, select: { name: true } })),
  ]);
  const base: HomeBase = {
    orgSlug: opts.orgSlug, orgId: ctx.orgId, orgName: org.name, role: ctx.role, userId: identity.userId, userName: identity.name,
    welcome: opts.welcome, archivedCount: archived.length, projects: active.map((p) => ({ id: p.id, name: p.name })),
  };
  if (active.length === 0) return { variant: 'first-time', base, canCreate: can(ctx.role, 'project:create') };
  if (variant === 'viewer') return viewerHome(ctx, base, active, identity.userId, opts);
  if (variant === 'reviewer') return reviewerHome(ctx, base, active, identity.userId, opts.today);
  return recorderHome(ctx, base, active, identity.userId, opts);
}

/**
 * The variant of a role with an active project. Every role is named, so a role added later fails here, before any read
 * and whether or not the organisation has a project, until Home decides what it shows (not a fallback).
 */
function variantOf(role: OrgContext['role']): 'viewer' | 'reviewer' | 'recorder' {
  switch (role) {
    case 'viewer': return 'viewer';
    case 'reviewer': return 'reviewer';
    case 'owner': case 'admin': case 'assessor': return 'recorder';
    default: {
      const unknown: never = role;
      throw new Error(`loadHome: no Home for role ${String(unknown)}`);
    }
  }
}

/**
 * `fn` over each project in turn, in the given order. Each project's reads open up to four transactions at once, so the
 * projects go one after another rather than all together: the app pool holds 10 connections and a transaction waits 2 s
 * for one (Prisma's default `maxWait`), so an organisation with many projects must not exhaust it.
 */
async function eachInTurn<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

/** A person who records: the next step, what is assigned to them, the changes since their last save, the focus project's stages, and the lead lists. */
async function recorderHome(
  ctx: OrgContext, base: HomeBase, active: readonly ProjectRow[], userId: string, opts: { orgSlug: string; today: CalendarDate },
): Promise<HomeData> {
  const [next, assigned, saved] = await Promise.all([loadNextStep(ctx, userId), myMitigations(ctx, userId, opts.today), lastSavedBy(ctx, userId)]);
  // The project of the next step, else the most recently updated active project (listProjectRows' order).
  const project = next === null ? active[0] : { id: next.projectId, name: next.projectName };
  const lead = ctx.role === 'owner' || ctx.role === 'admin';
  const [since, stages, teamLead] = await Promise.all([
    saved === null ? null : changesSince(ctx, { since: new Date(saved.at), excludeUserId: userId, limitGroups: CHANGE_GROUPS }),
    stagesOpen(ctx, project.id, opts.today, { orgSlug: opts.orgSlug, recording: { current: next === null ? null : { stage: next.stage, questionId: next.questionId } } }),
    lead ? teamLeadOf(ctx, active, opts.today) : null,
  ]);
  return {
    variant: 'recorder', base, next, assigned,
    since: saved === null || since === null ? null : { from: saved.at, ...since },
    focus: { projectId: project.id, projectName: project.name, stages }, lead: teamLead, otherProjects: active.length - 1,
  };
}

/** The Owner's and Admin's addition, from every active project: overdue mitigations, and open findings with no mitigation. */
async function teamLeadOf(ctx: OrgContext, active: readonly ProjectRow[], today: CalendarDate): Promise<TeamLead> {
  const per = await eachInTurn(active, async (p) => {
    const [followUp, findings] = await Promise.all([projectFollowUp(ctx, p.id, today), listFindings(ctx, p.id, undefined, today)]);
    return {
      overdue: STAGES.flatMap((s) => followUp.open[s]).filter((i) => i.overdue),
      withoutMitigation: findings.filter((f) => f.state === 'open' && f.hasNoMitigation),
    };
  });
  return { overdue: per.flatMap((x) => x.overdue), withoutMitigation: per.flatMap((x) => x.withoutMitigation), multiProject: active.length > 1 };
}

/**
 * The newest review of each stage of a project (the highest number in the stage), as the stage page shows one review per
 * stage: an older review a later one replaced is not work waiting for anyone, sealed or not.
 */
function newestPerStage(reviews: readonly StageReviewView[]): StageReviewView[] {
  const newest = new Map<string, StageReviewView>();
  for (const r of reviews) {
    const key = `${r.projectId}:${r.stage}`;
    const kept = newest.get(key);
    if (kept === undefined || r.numberInStage > kept.numberInStage) newest.set(key, r);
  }
  return reviews.filter((r) => newest.get(`${r.projectId}:${r.stage}`) === r);
}

/**
 * A Reviewer: the mitigations assigned to them (their own work, whatever the role; empty when none), reviews not sealed,
 * sealed reviews with changes since their latest seal (each the newest of its stage), and the open findings they raised.
 */
async function reviewerHome(ctx: OrgContext, base: HomeBase, active: readonly ProjectRow[], userId: string, today: CalendarDate): Promise<HomeData> {
  const [assigned, per] = await Promise.all([
    myMitigations(ctx, userId, today),
    eachInTurn(active, async (p) => {
      const [reviews, findings] = await Promise.all([listStageReviews(ctx, p.id), listFindings(ctx, p.id, undefined, today)]);
      return { reviews, findings };
    }),
  ]);
  const reviews = newestPerStage(per.flatMap((x) => x.reviews));
  return {
    variant: 'reviewer', base, assigned,
    unsealed: reviews.filter((r) => r.latestSeal === null),
    changedSinceSeal: reviews.filter((r) => r.latestSeal !== null && r.changedSinceLatestSeal),
    raisedByMe: per.flatMap((x) => x.findings).filter((f) => f.raisedBy.userId === userId && f.state === 'open'),
  };
}

/**
 * A Viewer: the mitigations assigned to them (empty when none), what the team recorded in the last 14 days, and what is
 * still open in each active project. Its stops lead to
 * the question page, which a Viewer reads as the reading view (record:read), and none is current: nothing here records
 * (T9.5 forbids recording links, not reading ones; the lane lead's ruling on Task 2's point 4).
 */
async function viewerHome(
  ctx: OrgContext, base: HomeBase, active: readonly ProjectRow[], userId: string, opts: { orgSlug: string; today: CalendarDate; now: Date },
): Promise<HomeData> {
  const [assigned, recent, open] = await Promise.all([
    myMitigations(ctx, userId, opts.today),
    changesSince(ctx, { since: new Date(opts.now.getTime() - RECENT_MS), excludeUserId: null, limitGroups: CHANGE_GROUPS }),
    eachInTurn(active, async (p) => ({
      projectId: p.id, projectName: p.name, stages: await stagesOpen(ctx, p.id, opts.today, { orgSlug: opts.orgSlug, recording: null }),
    })),
  ]);
  return { variant: 'viewer', base, assigned, recent, open };
}

/**
 * A project's three stages as Home shows them. The counts are `stageView`'s, so they equal the project page's; the stops
 * are every question of the stage in question order with the kit's mark (`markKindOf`, read as the stage page reads it:
 * a withdrawal is no decision, a question the personal data answer switches off does not apply), and the tally counts
 * them. Each stop carries its question page's address. With `recording` (a person who records), every stop also says
 * whether it is the next step's question (`current`); without it (a Viewer), no stop carries `current`. `nextOpen` is
 * `nextStep`'s first open question of the stage.
 */
async function stagesOpen(
  ctx: OrgContext, projectId: string, today: CalendarDate,
  links: { orgSlug: string; recording: { current: { stage: Stage; questionId: string } | null } | null },
): Promise<StageOpen[]> {
  const [counts, rows] = await Promise.all([
    stageView(ctx, projectId, today),
    // The awaits of an object literal run in order, so the three reads go one after another on the one transaction.
    withOrg(ctx, async (tx): Promise<Record<Stage, DecisionVersionRow[]>> => ({
      'pre-processing': await currentDecisionRows(tx, projectId, 'pre-processing'),
      'in-processing': await currentDecisionRows(tx, projectId, 'in-processing'),
      'post-processing': await currentDecisionRows(tx, projectId, 'post-processing'),
    })),
  ]);
  const content = runningContent();
  return STAGES.map((stage): StageOpen => {
    const current = new Map(rows[stage].map((r) => [r.questionId, r]));
    const all = questionsInStage(content, stage);
    let doneNoEvidence = 0;
    const stops = all.map((q): RouteStop => {
      const row = current.get(q.id);
      const decided = row === undefined || row.status === 'withdrawn' ? null : { status: row.status, scopeAnswer: row.scopeAnswer };
      const gated = q.condition !== undefined && !questionApplies(content, q.id, current.get(q.condition.questionId)?.scopeAnswer ?? null);
      const kind = markKindOf({ status: decided?.status ?? null, scopeAnswer: decided?.scopeAnswer ?? null, gated, isScopeQuestion: q.type === 'gate' });
      if (kind === 'done' && row !== undefined && row.evidenceIds.length === 0) doneNoEvidence += 1;
      const stop: RouteStop = { id: q.id, kind, title: q.text };
      stop.href = questionHref({ orgSlug: links.orgSlug, projectId, stage }, q.id);
      if (links.recording !== null) {
        const { current } = links.recording;
        stop.current = current !== null && current.stage === stage && current.questionId === q.id;
      }
      if (kind === 'scope_answered' && decided?.scopeAnswer != null) stop.scopeAnswer = decided.scopeAnswer;
      return stop;
    });
    const chosen = nextStep({ ...stageInputsOf(stage, rows[stage]), after: null });
    const n = chosen === null ? 0 : all.findIndex((q) => q.id === chosen.questionId) + 1;
    return {
      stage, noDecision: counts[stage].noDecision, openFindings: counts[stage].openFindings, overdueMitigations: counts[stage].overdueMitigations,
      stops, tally: tallyOf(stops.map((s) => s.kind), doneNoEvidence),
      nextOpen: chosen === null ? null : { questionId: chosen.questionId, questionText: all[n - 1].text, position: { n, of: all.length } },
    };
  });
}
