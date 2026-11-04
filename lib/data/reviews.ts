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
import { manifestIds, stageSnapshotIds } from '@/lib/seal/ids';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';
import { listSeals } from '@/lib/data/seals';
import { trustedManifest } from '@/lib/integrity/sealCheck.mjs';
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
 * A NUL cannot be stored in a PostgreSQL text column (the insert fails), and a lone UTF-16 surrogate cannot be carried
 * by UTF-8 (node-postgres would store U+FFFD instead): either is refused, never stored altered. The rule of
 * `lib/findings/validate.ts`'s `NOT_STORABLE`, with its message.
 */
const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * The stored form of a note: null for none or an empty one, else the NFC form, trimmed. Its length is the number of
 * code points (`[...s].length`), never `String.length`, which counts UTF-16 units: one emoji is two units and one code
 * point, as PostgreSQL's `char_length` counts it.
 */
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
      latestSeal: null, changedSinceLatestSeal: false, changed: null, preparedForErased, latestSealUnreadable: false,
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

/**
 * The project's reviews, of one stage when given, in `STAGES` order and then by number (W-1, W-7), each with its
 * latest seal (`listSeals`, newest first) and what changed since it (`changedSinceSeal`).
 */
export async function listStageReviews(ctx: OrgContext, projectId: string, stage?: Stage): Promise<StageReviewView[]> {
  const views = await withOrg(ctx, async (tx) => {
    const rows = await tx.stageReview.findMany({
      where: stage === undefined ? { projectId } : { projectId, stage }, select: REVIEW_SELECT,
    });
    const order = (r: ReviewRow) => STAGES.indexOf(r.stage as Stage);
    return reviewViews(tx, [...rows].sort((x, y) => order(x) - order(y) || x.numberInStage - y.numberInStage));
  });
  const out: StageReviewView[] = [];
  for (const v of views) {
    const latestSeal = (await listSeals(ctx, v.id))[0] ?? null;
    const state = latestSeal === null ? null : await withOrg(ctx, (tx) => sealState(tx, v.id), { isolationLevel: 'RepeatableRead' });
    const changed = state?.changed ?? null;
    out.push({ ...v, latestSeal, changed, changedSinceLatestSeal: changed !== null, latestSealUnreadable: state?.unreadable ?? false });
  }
  return out;
}

type IdSet = Awaited<ReturnType<typeof stageSnapshotIds>>;

/**
 * What differs between two id sets (FR-REV-05, SRS line 993: row ids, never times): the question ids of the decision
 * versions in one set and not the other, and the finding ids whose own id, events, current mitigation versions or
 * accepted risk differ, each sorted. The rows are append-only, so every id a seal or the stage names still has its row.
 */
async function idSetChange(tx: TenantTx, sealed: IdSet, now: IdSet): Promise<{ changedQuestions: string[]; changedFindings: string[] } | null> {
  const diff = (a: readonly string[], b: readonly string[]) => {
    const inA = new Set(a);
    const inB = new Set(b);
    return [...a.filter((x) => !inB.has(x)), ...b.filter((x) => !inA.has(x))];
  };
  const keys = ['decisionVersions', 'evidence', 'findings', 'findingEvents', 'mitigationVersions', 'acceptedRisks'] as const;
  const d = Object.fromEntries(keys.map((k) => [k, diff(sealed[k], now[k])])) as Record<(typeof keys)[number], string[]>;
  // Evidence cannot differ alone: a seal names evidence only through the decision and mitigation versions that link it,
  // and those links are append-only, so a changed evidence set always comes with a changed version (C4 CR-8).
  if (keys.every((k) => d[k].length === 0)) return null;
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
  const questions = await tx.decisionVersion.findMany({ where: { id: { in: d.decisionVersions } }, select: { questionId: true } });
  const events = await tx.findingEvent.findMany({ where: { id: { in: d.findingEvents } }, select: { findingId: true } });
  const mitigations = await tx.mitigationVersion.findMany({ where: { id: { in: d.mitigationVersions } }, select: { findingId: true } });
  const risks = await tx.acceptedRisk.findMany({ where: { id: { in: d.acceptedRisks } }, select: { findingId: true } });
  return {
    changedQuestions: sorted(questions.map((q) => q.questionId)),
    changedFindings: sorted([...d.findings, ...events.map((e) => e.findingId), ...mitigations.map((m) => m.findingId), ...risks.map((x) => x.findingId)]),
  };
}

/**
 * The ids a seal of the stage taken now would name, planned on the running content (`stageSnapshotIds`'s plan, SRS
 * line 993), and the questions with a current decision that the running content no longer holds. Those questions are
 * set aside before planning, because REV-a's planner refuses them (lib/seal/manifest.ts:67, R-45 open); the caller
 * reports them as changed (C4 CR-2 ruling: a defined state, never a 500). Every other refusal still throws.
 */
async function stageIdsNow(tx: TenantTx, projectId: string, stage: Stage): Promise<{ ids: IdSet; cut: string[] }> {
  const content = loadContent((await resolveRunningContentVersion(tx)).semver);
  const rows = await readStageRows(tx, projectId, stage);
  const known = new Set(questionsInStage(content, stage).map((q) => q.id));
  const cut = new Set<string>();
  for (const r of rows.decision_versions) {
    const q = (r as { questionId?: unknown; stage?: unknown }).questionId;
    if ((r as { stage?: unknown }).stage === stage && typeof q === 'string' && !known.has(q)) cut.add(q);
  }
  const kept = cut.size === 0 ? rows : { ...rows, decision_versions: rows.decision_versions.filter((r) => !cut.has((r as { questionId: string }).questionId)) };
  return { ids: stagePlan(kept, { stage, content }).ids, cut: [...cut].sort() };
}

/** The review's highest seal, compared with the stage now: null when never sealed; `unreadable` when its bytes are no readable manifest of it. */
async function sealState(tx: TenantTx, reviewId: string): Promise<{ changed: ChangedSinceSeal | null; unreadable: boolean } | null> {
  const review = await tx.stageReview.findFirst({ where: { id: reviewId }, select: { projectId: true, stage: true } });
  if (review === null) throw new NotFoundError();
  const seal = await tx.seal.findFirst({
    where: { stageReviewId: reviewId }, orderBy: { sealNumber: 'desc' }, select: { id: true, sealNumber: true, manifest: true, fingerprint: true },
  });
  if (seal === null) return null;
  const gate = trustedManifest({ sealId: seal.id, manifestBytes: seal.manifest, fingerprint: seal.fingerprint });
  if (gate.kind !== 'trusted') return { changed: null, unreadable: true };
  const now = await stageIdsNow(tx, review.projectId, review.stage as Stage);
  const change = await idSetChange(tx, manifestIds(gate.manifest), now.ids);
  if (change === null && now.cut.length === 0) return { changed: null, unreadable: false };
  const changedQuestions = [...new Set([...(change?.changedQuestions ?? []), ...now.cut])].sort();
  return { changed: { sealNumber: seal.sealNumber, changedQuestions, changedFindings: change?.changedFindings ?? [] }, unreadable: false };
}

/**
 * "Changed since seal N" (FR-REV-05): in one REPEATABLE READ snapshot, the ids the review's highest seal names
 * (`manifestIds` of its stored manifest) against the ids a seal of the stage taken now would name, planned on the
 * running content (SRS line 993). Null when the review was never sealed or the two sets are equal. A question with a
 * current decision that the running content no longer holds is listed as changed (S-16 says it is no longer in the
 * question set). A latest seal whose bytes are no readable manifest of it (`trustedManifest`; its fingerprint may still
 * match, so `SealView.bytesMatch` can be true) compares nothing and reads null here; `listStageReviews` flags it as
 * `latestSealUnreadable`, and the seal check reports it.
 */
export async function changedSinceSeal(ctx: OrgContext, reviewId: string): Promise<ChangedSinceSeal | null> {
  return withOrg(ctx, async (tx) => (await sealState(tx, reviewId))?.changed ?? null, { isolationLevel: 'RepeatableRead' });
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
