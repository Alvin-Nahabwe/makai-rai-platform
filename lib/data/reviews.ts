/* eslint-disable @typescript-eslint/no-unused-vars -- the stub bodies below keep the contract's parameter names until REV-b fills them. */
import type { OrgRole } from '@prisma/client';
import { assertCan, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import { STAGES, type Actor, type DecisionStatus, type ScopeAnswer, type Stage, type WriteOutcome } from '@/types/record';
import type { ChangedSinceSeal, OpenReviewRequest, StageReviewView } from '@/types/api';
import { ConflictError, NotImplementedError, ValidationFailed } from '@/lib/http/errors';
import { idempotentWrite } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { uniqueViolationIndex } from '@/lib/data/pgErrors';
import { erasedFields, userRefs } from '@/lib/data/views';
import { stageReviewName } from '@/lib/seal/reviewName';

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
function storedNote(note: string | null): string | null {
  if (note === null) return null;
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

// CONTRACT_STUB: REV-b
export async function sealPreview(ctx: OrgContext, reviewId: string): Promise<SealPreview> {
  throw new NotImplementedError('REV-b');
}
