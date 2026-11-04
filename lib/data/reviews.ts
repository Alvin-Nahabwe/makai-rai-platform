/* eslint-disable @typescript-eslint/no-unused-vars -- the stub bodies below keep the contract's parameter names until REV-b fills them. */
import type { OrgRole } from '@prisma/client';
import { assertCan, NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import { STAGES, type Actor, type DecisionStatus, type DecisionVersionRow, type ScopeAnswer, type Stage, type WriteOutcome } from '@/types/record';
import type { ChangedSinceSeal, OpenReviewRequest, StageReviewView } from '@/types/api';
import { ConflictError, ValidationFailed } from '@/lib/http/errors';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { uniqueViolationIndex } from '@/lib/data/pgErrors';
import { erasedFields, evidenceViews, userRefs } from '@/lib/data/views';
import { currentDecisionRows } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { contentRefById, resolveRunningContentVersion } from '@/lib/data/framework';
import { loadContent, questionApplies, questionsInStage } from '@/lib/content/loader';
import { stageSnapshotIds } from '@/lib/seal/ids';
import { stageReviewName } from '@/lib/seal/reviewName';
import { FINDING_MESSAGES } from '@/lib/findings/validate';

/** Open a review, list reviews, changed since seal, seal preview (FR-REV-01, 02, 05). */

export type SealPreview = {
  byStatus: Record<DecisionStatus, number>; byReasonCode: Record<string, number>; noDecision: string[];
  doneWithoutEvidence: number; openFindings: number; openMitigations: number; enteredByPeople: number;
  sealer: { name: string; role: OrgRole }; rewordedSinceDecision: number;
  scopeAnswer: { questionId: string; versionNumber: number; answer: ScopeAnswer } | null;
  evidence: { files: number; links: number };
};

/** FR-REV-01: the note holds at most 120 characters, counted as code points of its NFC form. */
export const PREPARED_FOR_MAX = 120;
export const PREPARED_FOR_TOO_LONG = `The note can have at most ${PREPARED_FOR_MAX} characters.`;
/** K0a's unique index on (orgId, projectId, stage, numberInStage): a concurrent open in the same stage took the number (SRS 5.3 item 3). */
const NUMBER_INDEX = 'stage_reviews_orgId_projectId_stage_numberInStage_key';

/**
 * The stored form of a note: null for none or an empty one, else the NFC form, trimmed. Its length is the number of
 * code points (`[...s].length`), never `String.length`, which counts UTF-16 units: one emoji is two units and one code
 * point, as PostgreSQL's `char_length` counts it.
 */
/**
 * A NUL cannot be stored in a PostgreSQL text column (the insert fails), and a lone UTF-16 surrogate cannot be carried
 * by UTF-8 (node-postgres would store U+FFFD instead): either is refused, never stored altered. The rule of
 * `lib/findings/validate.ts`'s `NOT_STORABLE`, with its message.
 */
const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function storedNote(note: string | null): string | null {
  if (note === null) return null;
  if (NOT_STORABLE.test(note)) throw new ValidationFailed([{ field: 'preparedFor', message: FINDING_MESSAGES.notStorable }]);
  const nfc = note.normalize('NFC').trim();
  if (nfc === '') return null;
  if ([...nfc].length > PREPARED_FOR_MAX) throw new ValidationFailed([{ field: 'preparedFor', message: PREPARED_FOR_TOO_LONG }]);
  return nfc;
}

const REVIEW_SELECT = {
  id: true, projectId: true, stage: true, numberInStage: true, preparedFor: true, openedById: true, openedAt: true,
} as const;
type ReviewRow = { id: string; projectId: string; stage: string; numberInStage: number; preparedFor: string | null; openedById: string; openedAt: Date };

/** `StageReviewView` of review rows, in the order given. The seal fields are filled by the change comparison (FR-REV-05). */
async function reviewViews(tx: TenantTx, rows: readonly ReviewRow[]): Promise<StageReviewView[]> {
  const ids = rows.map((r) => r.id);
  const [refs, erased] = await Promise.all([userRefs(tx, rows.map((r) => r.openedById)), erasedFields(tx, 'stage_reviews', ids)]);
  return rows.map((r) => {
    const openedBy = refs.get(r.openedById);
    // Accounts are scrubbed, never deleted (FR-EXP-03): an opener with no account row is a defect, not a blank name.
    if (openedBy === undefined) throw new Error(`reviews: no account for the opener of review ${r.id}`);
    const e = erased.get(r.id);
    const preparedForErased = e !== undefined && e.fields.includes('preparedFor') ? { erasedOn: e.erasedOn } : null;
    const stage = r.stage as Stage;
    return {
      id: r.id, projectId: r.projectId, stage, numberInStage: r.numberInStage, name: stageReviewName(stage, r.numberInStage),
      preparedFor: preparedForErased === null ? r.preparedFor : null, openedBy, openedAt: r.openedAt.toISOString(),
      latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased,
    };
  });
}

/**
 * Opens a stage review (FR-REV-01; contract route row 12). The name is the platform's (`stageReviewName`), the number
 * the next of the stage, the opener the session's; the client sends only the stage and the note. Inside
 * `idempotentWrite`'s transaction: the project must be writable (`project_archived`, or not found for a project the
 * organisation does not hold), then one insert. A unique violation on the number index means a concurrent open of the
 * same stage took the number: 409 `number_taken`, and the client opens again.
 */
export async function openStageReview(
  ctx: OrgContext, actor: Actor, a: OpenReviewRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<StageReviewView>> {
  assertCan(ctx, 'review:open');
  if (!STAGES.includes(a.stage)) throw new ValidationFailed([{ field: 'stage', message: 'stage must be pre-processing, in-processing or post-processing.' }]);
  const preparedFor = storedNote(a.preparedFor);
  try {
    return await idempotentWrite<StageReviewView>(ctx, {
      table: 'stage_reviews', requestId: a.requestId, digest, actorUserId: actor.userId,
      write: async (tx) => {
        await assertProjectWritable(tx, a.projectId);
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT (coalesce(max("numberInStage"), 0) + 1)::int AS n FROM stage_reviews
          WHERE "orgId" = ${ctx.orgId} AND "projectId" = ${a.projectId} AND "stage" = ${a.stage}`;
        const row = await tx.stageReview.create({
          data: {
            orgId: ctx.orgId, projectId: a.projectId, stage: a.stage, numberInStage: n, preparedFor,
            openedById: actor.userId, requestId: a.requestId, requestDigest: digest,
          },
          select: REVIEW_SELECT,
        });
        return (await reviewViews(tx, [row]))[0];
      },
      replay: async (tx, rowId) => (await reviewViews(tx, [await tx.stageReview.findUniqueOrThrow({ where: { id: rowId }, select: REVIEW_SELECT })]))[0],
    });
  } catch (e) {
    // Only the number index means "another open of this stage took the number"; anything else goes on as it is.
    if (uniqueViolationIndex(e) === NUMBER_INDEX) throw new ConflictError('number_taken');
    throw e;
  }
}

/** The project's reviews, of one stage when given, in `STAGES` order and then by number (W-1, W-7). */
export async function listStageReviews(ctx: OrgContext, projectId: string, stage?: Stage): Promise<StageReviewView[]> {
  return withOrg(ctx, async (tx) => {
    const rows = await tx.stageReview.findMany({
      where: stage === undefined ? { projectId } : { projectId, stage }, select: REVIEW_SELECT, orderBy: { numberInStage: 'asc' },
    });
    const order = (r: ReviewRow) => STAGES.indexOf(r.stage as Stage);
    return reviewViews(tx, [...rows].sort((x, y) => order(x) - order(y) || x.numberInStage - y.numberInStage));
  });
}

// CONTRACT_STUB: REV-b
export async function changedSinceSeal(ctx: OrgContext, reviewId: string): Promise<ChangedSinceSeal | null> {
  return null;
}

/** The statuses a current decision can count under on S-17, in the order UX-18 lists them. */
const DECISION_STATUSES: readonly DecisionStatus[] = ['done', 'partly', 'not_yet', 'not_applicable'];

/**
 * What a seal of the review's stage would hold if it were taken now (FR-REV-02, UX-18; contract row of
 * lib/data/reviews.ts, amended: the actor is the person who would seal). Inside one REPEATABLE READ snapshot: the
 * questions of the stage in the running content, the gate rule as the seal builder applies it (lib/seal/manifest.ts
 * stagePlan: a question whose gate's current scope answer makes `questionApplies` false is derived from the gate and is
 * no decision of its own), the current version of each other question (a withdrawal is current and means no decision),
 * and the evidence `stageSnapshotIds` would seal. Findings and mitigations come from `listFindings`, which opens its
 * own transaction; the preview is advice before sealing, and the seal builder reads its own snapshot.
 *
 * `rewordedSinceDecision` counts current decisions whose question's expected practice differs between the content
 * version the decision was made on and the running one (FR-CNT-08, SRS line 729); a decision whose own content does not
 * hold its question counts as reworded, since the text it answered is not the current one.
 */
export async function sealPreview(ctx: OrgContext, actor: Actor, reviewId: string): Promise<SealPreview> {
  const out = await withOrg(ctx, async (tx) => {
    const review = await tx.stageReview.findFirst({ where: { id: reviewId }, select: { projectId: true, stage: true } });
    if (review === null) throw new NotFoundError();
    const stage = review.stage as Stage;
    const running = await resolveRunningContentVersion(tx);
    const content = loadContent(running.semver);
    const current = new Map((await currentDecisionRows(tx, review.projectId, stage)).map((v) => [v.questionId, v]));

    const byStatus = Object.fromEntries(DECISION_STATUSES.map((st) => [st, 0])) as Record<DecisionStatus, number>;
    const byReasonCode: Record<string, number> = {};
    const noDecision: string[] = [];
    const enteredBy = new Set<string>();
    const decided: DecisionVersionRow[] = [];
    let doneWithoutEvidence = 0;
    let scopeAnswer: SealPreview['scopeAnswer'] = null;
    const gates = new Set<string>();
    const inStage = questionsInStage(content, stage);
    for (const q of inStage) if (q.condition !== undefined) gates.add(q.condition.questionId);

    for (const q of inStage) {
      const gate = q.condition === undefined ? undefined : current.get(q.condition.questionId);
      const gateAnswer = gate === undefined || gate.status === 'withdrawn' ? null : gate.scopeAnswer;
      if (gate !== undefined && !questionApplies(content, q.id, gateAnswer)) continue;   // derived from the gate (SRS line 1287)
      const v = current.get(q.id);
      if (v === undefined || v.status === 'withdrawn') {
        noDecision.push(q.id);
        if (v !== undefined) enteredBy.add(v.enteredById);
        continue;
      }
      enteredBy.add(v.enteredById);
      decided.push(v);
      if (gates.has(q.id) && v.scopeAnswer !== null && scopeAnswer === null) {
        scopeAnswer = { questionId: q.id, versionNumber: v.versionNumber, answer: v.scopeAnswer };
      }
      if (v.status === null) continue;   // a scope answer, not a status
      byStatus[v.status] += 1;
      if ((v.status === 'not_applicable' || v.status === 'not_yet') && v.reasonCode !== null) {
        byReasonCode[v.reasonCode] = (byReasonCode[v.reasonCode] ?? 0) + 1;
      }
      if (v.status === 'done' && v.evidenceIds.length === 0) doneWithoutEvidence += 1;
    }

    const practiceOf = new Map<string, Map<string, string>>([[running.contentVersionId, practices(content)]]);
    let rewordedSinceDecision = 0;
    for (const v of decided) {
      let theirs = practiceOf.get(v.contentVersionId);
      if (theirs === undefined) {
        theirs = practices(loadContent((await contentRefById(tx, v.contentVersionId)).semver));
        practiceOf.set(v.contentVersionId, theirs);
      }
      if (theirs.get(v.questionId) !== practiceOf.get(running.contentVersionId)!.get(v.questionId)) rewordedSinceDecision += 1;
    }

    const evidence = await evidenceViews(tx, (await stageSnapshotIds(tx, review.projectId, stage)).evidence);
    const kinds = [...evidence.values()].map((e) => e.kind);
    const sealer = (await userRefs(tx, [actor.userId])).get(actor.userId);
    // Accounts are scrubbed, never deleted (FR-EXP-03): a signed-in actor with no account row is a defect.
    if (sealer === undefined) throw new Error('reviews: no account for the person sealing');
    return {
      projectId: review.projectId, stage,
      preview: {
        byStatus, byReasonCode, noDecision, doneWithoutEvidence, enteredByPeople: enteredBy.size,
        sealer: { name: sealer.name, role: actor.role }, rewordedSinceDecision, scopeAnswer,
        evidence: { files: kinds.filter((k) => k === 'file').length, links: kinds.filter((k) => k === 'link').length },
      },
    };
  }, { isolationLevel: 'RepeatableRead' });
  const findings = await listFindings(ctx, out.projectId, out.stage);
  const open = findings.filter((f) => f.state === 'open');
  return { ...out.preview, openFindings: open.length, openMitigations: open.reduce((n, f) => n + f.openMitigations, 0) };
}

/** Expected practice of every question of a content version, by question id. */
function practices(c: ReturnType<typeof loadContent>): Map<string, string> {
  return new Map(STAGES.flatMap((st) => questionsInStage(c, st)).map((q) => [q.id, q.expectedPractice]));
}
