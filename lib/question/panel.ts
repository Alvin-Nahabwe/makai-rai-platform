import type { OrgRole } from '@prisma/client';
import { NotFoundError, withOrg, type OrgContext } from '@/lib/data/tenant';
import type { Identity } from '@/lib/auth/identity';
import type { DeclaredDate, DeclaredPrecision, ScopeAnswer, Stage } from '@/types/record';
import type { LoadedContent, LoadedQuestion, ReasonCodeEntry } from '@/types/content';
import type { SealRef } from '@/types/seal';
import type { DecisionVersionView } from '@/types/api';
import { can } from '@/lib/authz/policy';
import { loadContent, questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { decisionHistory } from '@/lib/data/decisions';
import { openShortfallForQuestion } from '@/lib/data/findings';
import { sealsIncludingRows } from '@/lib/data/seals';
import { userRefs } from '@/lib/data/views';

/** What S-12 (the question panel) shows, loaded once for the page (FR-DEC-01, FR-CNT-02, UX-08). */
export interface QuestionPanelData {
  orgSlug: string; projectId: string; projectArchived: boolean; stage: Stage;
  question: LoadedQuestion;                 // wording of the version the current decision was answered against (FR-CNT-07)
  runningQuestion: LoadedQuestion;          // wording in the running content (FR-CNT-08 marker)
  position: { index: number; total: number; previousId: string | null; nextId: string | null };
  current: DecisionVersionView | null; historyCount: number;
  seals: SealRef[]; reasonCodes: ReasonCodeEntry[];
  members: Array<{ userId: string; name: string }>; viewer: { userId: string; name: string; role: OrgRole };
  canWrite: boolean; canRaiseFinding: boolean; lastOwnSaveDate: DeclaredDate | null;
  openFinding: { findingId: string } | null; gateAnswer: ScopeAnswer | null; contentSemver: string;
  orgId: string;                            // the draft key's organisation (UX-26; gap G041)
}

/**
 * The panel for one question of one project, or `NotFoundError` when the project or the question is not
 * this organisation's (NFR-SEC-02: row-level security makes another organisation's project invisible, so
 * it reads as absent) or the question is not in the running content's `p.stage`.
 *
 * Field sources (FR-CNT-07, FR-CNT-08, FR-DEC-10, UX-10, UX-11, UX-26): `question` is the wording of the
 * content version the current decision was answered against, unless there is no decision or the current
 * version is a withdrawal, when it is the running wording; `position` runs over the stage's questions that
 * apply under the gate's current scope answer (a gate with no answer shows them all: owner question B13),
 * the question itself always included; `members` are the organisation's members other than the viewer;
 * `lastOwnSaveDate` is the declared date of the viewer's newest non-withdrawal version in this project;
 * `canWrite` and `canRaiseFinding` are the role's grant in a project that is not archived.
 */
export async function loadQuestionPanel(
  ctx: OrgContext, identity: Identity, p: { projectId: string; stage: Stage; questionId: string },
): Promise<QuestionPanelData> {
  const running = runningContent();
  const runningQuestion = running.questions.get(p.questionId);
  if (runningQuestion === undefined || runningQuestion.stage !== p.stage) throw new NotFoundError();
  const gateId = gateQuestionId(running);

  const read = await withOrg(ctx, async (tx) => {
    const project = await tx.project.findFirst({ where: { id: p.projectId }, select: { archivedAt: true, org: { select: { slug: true } } } });
    if (project === null) throw new NotFoundError();
    const [memberships, lastOwn, gate] = await Promise.all([
      tx.membership.findMany({ select: { userId: true } }),
      tx.decisionVersion.findFirst({
        where: { projectId: p.projectId, enteredById: identity.userId, OR: [{ status: null }, { status: { not: 'withdrawn' } }] },
        select: { declaredOn: true, declaredPrecision: true }, orderBy: [{ receivedAt: 'desc' }, { versionNumber: 'desc' }],
      }),
      gateId === null ? null : tx.decisionVersion.findFirst({
        where: { projectId: p.projectId, questionId: gateId }, select: { status: true, scopeAnswer: true }, orderBy: { versionNumber: 'desc' },
      }),
    ]);
    const names = await userRefs(tx, [identity.userId, ...memberships.map((m) => m.userId)]);
    return { project, memberships, lastOwn, gate, names };
  });

  const [history, openFinding] = await Promise.all([
    decisionHistory(ctx, p.projectId, p.questionId),
    openShortfallForQuestion(ctx, p.projectId, p.questionId),
  ]);
  const current = history[0] ?? null;
  const seals = current === null ? [] : (await sealsIncludingRows(ctx, [current.id])).get(current.id) ?? [];

  const answeredAgainst = current !== null && current.status !== 'withdrawn' && current.content.semver !== running.semver
    ? loadContent(current.content.semver).questions.get(p.questionId)
    : undefined;
  const gateAnswer = read.gate !== null && read.gate.status !== 'withdrawn' ? (read.gate.scopeAnswer as ScopeAnswer | null) : null;
  const ordered = questionsInStage(running, p.stage)
    .filter((q) => q.id === p.questionId || questionApplies(running, q.id, gateAnswer));
  const index = ordered.findIndex((q) => q.id === p.questionId);
  const archived = read.project.archivedAt !== null;

  return {
    orgSlug: read.project.org.slug, projectId: p.projectId, projectArchived: archived, stage: p.stage,
    question: answeredAgainst ?? runningQuestion, runningQuestion,
    position: { index, total: ordered.length, previousId: ordered[index - 1]?.id ?? null, nextId: ordered[index + 1]?.id ?? null },
    current, historyCount: history.length, seals, reasonCodes: [...running.reasonCodes],
    members: read.memberships
      .filter((m) => m.userId !== identity.userId)
      .flatMap((m) => { const ref = read.names.get(m.userId); return ref ? [{ userId: m.userId, name: ref.name }] : []; })
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    viewer: { userId: identity.userId, name: read.names.get(identity.userId)?.name ?? identity.name ?? identity.email, role: ctx.role },
    canWrite: can(ctx.role, 'decision:write') && !archived,
    canRaiseFinding: can(ctx.role, 'finding:raise') && !archived,
    lastOwnSaveDate: read.lastOwn === null ? null : declaredDateOf(read.lastOwn.declaredOn, read.lastOwn.declaredPrecision as DeclaredPrecision | null),
    openFinding, gateAnswer, contentSemver: running.semver, orgId: ctx.orgId,
  };
}

/** The gate question the conditional questions name (FR-CNT-04), or null when the content has none. */
function gateQuestionId(c: LoadedContent): string | null {
  for (const q of c.questions.values()) if (q.condition !== undefined) return q.condition.questionId;
  return null;
}

/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' from the stored first day and its precision (W-3 note 7). */
function declaredDateOf(on: Date | null, precision: DeclaredPrecision | null): DeclaredDate | null {
  if (on === null || precision === null) return null;
  const day = on.toISOString().slice(0, 10);
  return precision === 'year' ? day.slice(0, 4) : precision === 'month' ? day.slice(0, 7) : day;
}
