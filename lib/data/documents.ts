import type { OrgRole, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { assertCan, NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, DecisionVersionRow, DocumentType, FieldError, OutsideRole, Stage, StoredDecisionStatus, ScopeAnswer, DeclaredPrecision, UtcInstant, WithdrawalCode, WriteOutcome } from '@/types/record';
import { DOCUMENT_TYPES, STAGES } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, DocumentPreview, EvidenceItemView, FindingEventView, FindingView, IssuedDocumentView,
  MitigationVersionView, PreviewDocumentRequest, TypedFieldValue, UserRef, WithdrawDocumentRequest,
} from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { SealManifestV1 } from '@/types/seal';
import type { LoadedContent } from '@/types/content';
import { AppError, ConflictError, ErasedError, NotImplementedError, ValidationFailed } from '@/lib/http/errors';
import { FINDING_MESSAGES, NOT_STORABLE, textLength } from '@/lib/findings/validate';
import { idempotentWrite, isRequestId } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { isSerializationFailure, isUniqueViolation, uniqueViolationIndex } from '@/lib/data/pgErrors';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
// Types only: the renderer (React PDF, fonts) is loaded on the issue path alone (`rendererFor`), so a page that reads drafts never pulls it in (conflict 3 a).
import type { RenderInput, Renderer } from '@/lib/documents/render';
import { ethicsFieldIds, resolveFields, typedEntries } from '@/lib/documents/resolve';
import { contentRefById, resolveRunningContentVersion } from '@/lib/data/framework';
import { erasedFields, evidenceViews, userRefs } from '@/lib/data/views';
import { loadContent, questionsInStage, runningContent } from '@/lib/content/loader';
import { logSecurityEvent } from '@/lib/security-logger';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { manifestIds } from '@/lib/seal/ids';
import { stageReviewName } from '@/lib/seal/reviewName';
import { SEAL_SOURCE_SQL, checkSealRows, manifestFromRows, trustedManifest, type SealSourceRows, type TombstoneRow } from '@/lib/integrity/sealCheck.mjs';
import {
  DOCUMENTS_COPY, ERASABLE_FIELDS, ETHICS_STATES, METADATA_KEYS, MSG_DOCUMENT_CHECK_FAILED, MSG_OTHER_SEAL_CHECK_FAILED, MSG_SEAL_CHECK_FAILED, DOCUMENT_TITLES, formatUtcDay,
} from '@/lib/documents/copy';
import { readStageRows, stagePlan } from '@/lib/seal/manifest';
import { currentOrg } from '@/lib/seal/reads';
import type {
  DocumentSnapshot, DraftReviewRef, SealedDecision, SealedFinding, SealedSnapshot, SealedStage, SnapshotProvenance, SnapshotStage, StageDraft, StageSeal,
} from '@/lib/documents/resolve';

// ─── The snapshot (NFR-INT-10) ───────────────────────────────────────────────────────────────────

const day = (d: Date): CalendarDate => d.toISOString().slice(0, 10);

const DECISION_SELECT = {
  id: true, orgId: true, projectId: true, stage: true, questionId: true, contentVersionId: true, versionNumber: true,
  baseVersionNumber: true, status: true, scopeAnswer: true, optionsInPlace: true, reasonCode: true, reason: true, reasonSalt: true,
  decidedByUserId: true, decidedByRole: true, declaredOn: true, declaredPrecision: true, withdrawalCode: true, enteredById: true,
  enteredByRole: true, receivedAt: true, requestId: true, requestDigest: true, evidence: { select: { evidenceId: true } },
} satisfies Prisma.DecisionVersionSelect;
const FINDING_SELECT = {
  id: true, projectId: true, stage: true, source: true, questionId: true, decisionVersionId: true, riskArea: true, title: true,
  description: true, raisedById: true, raisedAt: true,
} satisfies Prisma.FindingSelect;
const EVENT_SELECT = { id: true, findingId: true, kind: true, eventCode: true, reason: true, byId: true, at: true, findingSeq: true } satisfies Prisma.FindingEventSelect;
const MITIGATION_SELECT = {
  id: true, findingId: true, mitigationId: true, versionNumber: true, baseVersionNumber: true, what: true, changeNote: true,
  ownerUserId: true, dueDate: true, status: true, kind: true, followsControl: true, closureNote: true, closureDecisionVersionId: true,
  cancelReason: true, enteredById: true, enteredByRole: true, findingSeq: true, receivedAt: true, evidence: { select: { evidenceId: true } },
} satisfies Prisma.MitigationVersionSelect;
const RISK_SELECT = {
  id: true, findingId: true, acceptedByUserId: true, acceptedByRole: true, accepterRole: true, reason: true, lookAgainNote: true,
  lookAgainOn: true, enteredById: true, enteredByRole: true, findingSeq: true, receivedAt: true,
} satisfies Prisma.AcceptedRiskSelect;
const SEAL_SELECT = {
  id: true, sealNumber: true, fingerprint: true, sealedAt: true, sealedById: true, sealedByRole: true, manifest: true, stageReviewId: true,
  stageReview: { select: { id: true, projectId: true, stage: true, numberInStage: true, preparedFor: true } },
} satisfies Prisma.SealSelect;

type SealRow = Prisma.SealGetPayload<{ select: typeof SEAL_SELECT }>;
type DecisionRow = Prisma.DecisionVersionGetPayload<{ select: typeof DECISION_SELECT }>;
type FindingRow = Prisma.FindingGetPayload<{ select: typeof FINDING_SELECT }>;
type EventRow = Prisma.FindingEventGetPayload<{ select: typeof EVENT_SELECT }>;
type MitigationRow = Prisma.MitigationVersionGetPayload<{ select: typeof MITIGATION_SELECT }>;
type RiskRow = Prisma.AcceptedRiskGetPayload<{ select: typeof RISK_SELECT }>;

/** In-memory rows a draft's manifest is built with, standing where a seal and its review would: never written (Task 6). */
export type DraftHeader = { sealRow: Record<string, unknown>; reviewRow: Record<string, unknown> };

/** Where a stage's manifest came from: a stored seal, or the stage's rows as they are now with an in-memory header (ADR 0023). */
type StageOrigin =
  | { kind: 'sealed'; row: SealRow }
  | { kind: 'draft'; takenAt: Date; header: DraftHeader; openReview: DraftReviewRef | null; lastSealedReview: DraftReviewRef | null };

/** The rows one manifest names, as stored (nothing saved after the manifest was made is read: the ids come from the manifest). */
interface RawStage {
  stage: Stage; origin: StageOrigin; manifest: SealManifestV1; derived: Map<string, string>;
  decisions: DecisionRow[]; findings: FindingRow[]; events: EventRow[]; mitigations: MitigationRow[]; risks: RiskRow[];
}

/** How an error names a stage's manifest: its seal's id, or `draft:<stage>`. Ids only (NFR-PRIV-03). */
function originName(stage: Stage, origin: StageOrigin): string {
  switch (origin.kind) {
    case 'sealed': return `seal ${origin.row.id}`;
    case 'draft': return `draft:${stage}`;
  }
}

/** A boolean as 'true' or 'false', an enum as its name, a number in decimal, a date as YYYY-MM-DD; null stays null (contract G068). */
function metadataText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return day(v);
  return String(v);
}

/** The id the 500 `integrity_failure` of a seal that cannot vouch for itself carries in the log, never in the answer. */
function sealIntegrityFailure(sealId: string, kind: 'mismatch' | 'fingerprint_mismatch', stage: Stage, chosen: boolean): void {
  // As serious as a PDF whose bytes do not hash to the stored value (readDocumentPdf logs that at 'critical').
  logSecurityEvent('SEAL_CHECK_FAILED', 'critical', { details: { sealId, kind, stage, chosen } });
}

/** A seal whose stored bytes vouch for it (fingerprint, a readable manifest that names this seal), else null (NFR-INT-05). */
function trusted(seal: SealRow, chosen: boolean): SealManifestV1 | null {
  const gate = trustedManifest({ sealId: seal.id, manifestBytes: seal.manifest, fingerprint: seal.fingerprint });
  if (gate.kind === 'trusted') return gate.manifest;
  sealIntegrityFailure(seal.id, gate.kind, seal.stageReview.stage as Stage, chosen);
  return null;
}

/** The rows a manifest names, read by their ids for either origin, so a draft and a seal are hydrated by the same code (anti-goal 2). */
async function readRawStage(tx: TenantTx, stage: Stage, origin: StageOrigin, manifest: SealManifestV1): Promise<RawStage> {
  const ids = manifestIds(manifest);
  const decisionIds = manifest.decisions.flatMap((d) => ('id' in d ? [d.id] : []));
  const [decisions, findings, events, mitigations, risks] = [
    await tx.decisionVersion.findMany({ where: { id: { in: decisionIds } }, select: DECISION_SELECT }),
    await tx.finding.findMany({ where: { id: { in: [...ids.findings] } }, select: FINDING_SELECT }),
    await tx.findingEvent.findMany({ where: { id: { in: [...ids.findingEvents] } }, select: EVENT_SELECT, orderBy: { findingSeq: 'asc' } }),
    await tx.mitigationVersion.findMany({ where: { id: { in: [...ids.mitigationVersions] } }, select: MITIGATION_SELECT, orderBy: { findingSeq: 'asc' } }),
    await tx.acceptedRisk.findMany({ where: { id: { in: [...ids.acceptedRisks] } }, select: RISK_SELECT }),
  ];
  // A named id with no row is a broken database, not a user's mistake: ids only in the message (NFR-PRIV-03).
  const of = originName(stage, origin);
  if (decisions.length !== decisionIds.length) throw new Error(`documents: ${of} names decision versions that have no row`);
  if (findings.length !== ids.findings.length) throw new Error(`documents: ${of} names findings that have no row`);
  if (events.length !== ids.findingEvents.length || mitigations.length !== ids.mitigationVersions.length || risks.length !== ids.acceptedRisks.length) {
    throw new Error(`documents: ${of} names events, mitigation versions or accepted risks that have no row`);
  }
  const derived = new Map(manifest.decisions.flatMap((d) => ('derived' in d ? [[d.question, d.from] as [string, string]] : [])));
  return { stage, origin, manifest, derived, decisions, findings, events, mitigations, risks };
}

function toDecisionRow(r: DecisionRow): DecisionVersionRow {
  const { evidence, ...rest } = r;
  return {
    ...rest,
    stage: rest.stage as Stage, status: rest.status as StoredDecisionStatus | null, scopeAnswer: rest.scopeAnswer as ScopeAnswer | null,
    decidedByRole: rest.decidedByRole as OutsideRole | null, declaredPrecision: rest.declaredPrecision as DeclaredPrecision | null,
    withdrawalCode: rest.withdrawalCode as WithdrawalCode | null, evidenceIds: evidence.map((e) => e.evidenceId).sort(),
  };
}

/** For each row id, the UTC date each of its fields was erased, the earliest tombstone of that field (F7: each field prints its own date). */
async function erasureDates(tx: TenantTx, table: string, ids: readonly string[]): Promise<Map<string, Map<string, CalendarDate>>> {
  const wanted = [...new Set(ids)];
  const out = new Map<string, Map<string, CalendarDate>>();
  if (wanted.length === 0) return out;
  const rows = await tx.$queryRaw<{ targetId: string; field: string; erasedOn: CalendarDate }[]>`
    SELECT "targetId", "field", to_char(min("at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "erasedOn"
    FROM "tombstones" WHERE "targetTable" = ${table} AND "field" IS NOT NULL AND "targetId" = ANY (${wanted}::text[])
    GROUP BY "targetId", "field"`;
  for (const r of rows) out.set(r.targetId, new Map([...(out.get(r.targetId) ?? []), [r.field, r.erasedOn]]));
  return out;
}

/** The review a sealed origin names; a draft origin names none (it reads reviews only for their names and states, ADR 0023). */
function sealedReviewOf(origin: StageOrigin): SealRow['stageReview'] | null {
  switch (origin.kind) {
    case 'sealed': return origin.row.stageReview;
    case 'draft': return null;
  }
}

/**
 * The snapshot stages, contents and erasures of the raw stages, in the caller's transaction: one hydration for both origins
 * (anti-goal 2). A sealed origin brings its sealer and its review's erased note; a draft origin brings neither (no sealer, no
 * review read beyond its name and state).
 */
async function hydrateStages(tx: TenantTx, raw: ReadonlyMap<Stage, RawStage>, today: CalendarDate): Promise<{
  stages: Record<Stage, SnapshotStage | null>; contents: Map<string, LoadedContent>; erasures: DocumentSnapshot['erasures'];
}> {
  // Lookups for every stage at once.
  const all = [...raw.values()];
  const sealers = all.flatMap((r) => { switch (r.origin.kind) { case 'sealed': return [r.origin.row.sealedById]; case 'draft': return []; } });
  const reviewIds = all.flatMap((r) => sealedReviewOf(r.origin)?.id ?? []);
  const people = [
    ...sealers,
    ...all.flatMap((r) => [
      ...r.decisions.flatMap((d) => (d.decidedByUserId === null ? [d.enteredById] : [d.enteredById, d.decidedByUserId])),
      ...r.findings.map((f) => f.raisedById), ...r.events.map((e) => e.byId),
      ...r.mitigations.flatMap((m) => [m.ownerUserId, m.enteredById]),
      ...r.risks.flatMap((x) => (x.acceptedByUserId === null ? [x.enteredById] : [x.enteredById, x.acceptedByUserId])),
    ]),
  ];
  const evidenceIds = all.flatMap((r) => [...r.decisions.flatMap((d) => d.evidence.map((e) => e.evidenceId)), ...r.mitigations.flatMap((m) => m.evidence.map((e) => e.evidenceId))]);
  const [refs, evidence, erasedDecisions, erasedMitigations, erasedRisks, erasedReviews, erasedFindings, erasedEvidence] = [
    await userRefs(tx, people),
    await evidenceViews(tx, evidenceIds),
    await erasedFields(tx, 'decision_versions', all.flatMap((r) => r.decisions.map((d) => d.id))),
    await erasedFields(tx, 'mitigation_versions', all.flatMap((r) => r.mitigations.map((m) => m.id))),
    await erasedFields(tx, 'accepted_risks', all.flatMap((r) => r.risks.map((x) => x.id))),
    await erasedFields(tx, 'stage_reviews', reviewIds),
    await erasureDates(tx, 'findings', all.flatMap((r) => r.findings.map((f) => f.id))),
    await erasureDates(tx, 'evidence', evidenceIds),
  ];
  const person = (row: string, id: string): UserRef => {
    const ref = refs.get(id);
    // Accounts are scrubbed, never deleted (FR-EXP-03): a record never names an id with no account row. Ids only (NFR-PRIV-03).
    if (ref === undefined) throw new Error(`documents: row ${row} names user ${id}, which has no account row`);
    return ref;
  };
  const item = (row: string, id: string): EvidenceItemView => {
    const v = evidence.get(id);
    if (v === undefined) throw new Error(`documents: row ${row} attaches evidence ${id}, which has no evidence row`);
    return v;
  };

  const contentRefs = new Map<string, ContentRef>();
  const contents = new Map<string, LoadedContent>();
  for (const id of new Set(all.flatMap((r) => r.decisions.map((d) => d.contentVersionId)))) {
    const ref = await contentRefById(tx, id);
    contentRefs.set(id, ref);
    contents.set(id, loadContent(ref.semver));
  }

  const stages: Record<Stage, SnapshotStage | null> = { 'pre-processing': null, 'in-processing': null, 'post-processing': null };
  for (const [stage, r] of raw) {
    const decisions = new Map<string, SealedDecision>();
    for (const row of r.decisions.map(toDecisionRow)) {
      const e = erasedDecisions.get(row.id);
      const decidedBy: DeciderView | null = row.decidedByUserId !== null ? { kind: 'member', user: person(row.id, row.decidedByUserId) }
        : row.decidedByRole !== null ? { kind: 'outside_role', role: row.decidedByRole } : null;
      decisions.set(row.questionId, {
        row, content: contentRefs.get(row.contentVersionId) as ContentRef, enteredBy: person(row.id, row.enteredById), decidedBy,
        evidence: row.evidenceIds.map((id) => item(row.id, id)).sort((x, y) => x.uploadedAt.localeCompare(y.uploadedAt) || x.id.localeCompare(y.id)),
        reasonErased: e !== undefined && e.fields.includes('reason') ? { erasedOn: e.erasedOn } : null,
      });
    }

    const stateOf = new Map(r.manifest.findings.map((f) => [f.id, f.state]));
    const findings: SealedFinding[] = r.findings
      .sort((x, y) => x.raisedAt.getTime() - y.raisedAt.getTime() || x.id.localeCompare(y.id))
      .map((f: FindingRow) => {
        const listed = r.manifest.findings.find((m) => m.id === f.id) as SealManifestV1['findings'][number];
        const mitigationIds = new Set(listed.mitigations.map((m) => m.versionId));
        const mitigations = r.mitigations.filter((m: MitigationRow) => mitigationIds.has(m.id)).map((m): MitigationVersionView => {
          const e = erasedMitigations.get(m.id);
          return {
            id: m.id, findingId: m.findingId, mitigationId: m.mitigationId, versionNumber: m.versionNumber, baseVersionNumber: m.baseVersionNumber,
            what: m.what, changeNote: m.changeNote, owner: person(m.id, m.ownerUserId), dueDate: day(m.dueDate), status: m.status as MitigationVersionView['status'],
            kind: m.kind as MitigationVersionView['kind'], followsControl: m.followsControl, closureNote: m.closureNote, closureDecisionVersionId: m.closureDecisionVersionId,
            cancelReason: m.cancelReason, enteredBy: person(m.id, m.enteredById), enteredByRole: m.enteredByRole as OrgRole,
            findingSeq: m.findingSeq, receivedAt: m.receivedAt.toISOString(),
            evidence: m.evidence.map((x) => item(m.id, x.evidenceId)).sort((x, y) => x.uploadedAt.localeCompare(y.uploadedAt) || x.id.localeCompare(y.id)),
            erasedFields: e?.fields ?? [],
          };
        });
        const riskRow = r.risks.find((x: RiskRow) => x.id === listed.acceptedRisk?.id);
        if (listed.acceptedRisk !== null && riskRow === undefined) throw new Error(`documents: ${originName(stage, r.origin)} names accepted risk ${listed.acceptedRisk.id}, which has no row`);
        let acceptedRisk: AcceptedRiskView | null = null;
        if (riskRow !== undefined) {
          const e = erasedRisks.get(riskRow.id);
          const acceptedBy: DeciderView = riskRow.acceptedByUserId !== null ? { kind: 'member', user: person(riskRow.id, riskRow.acceptedByUserId) }
            : riskRow.acceptedByRole !== null ? { kind: 'outside_role', role: riskRow.acceptedByRole as OutsideRole }
            : (() => { throw new Error(`documents: accepted risk ${riskRow.id} names nobody who accepted it`); })();
          acceptedRisk = {
            id: riskRow.id, findingId: riskRow.findingId, acceptedBy, accepterRole: riskRow.accepterRole, reason: riskRow.reason,
            lookAgainNote: riskRow.lookAgainNote, lookAgainOn: riskRow.lookAgainOn === null ? null : day(riskRow.lookAgainOn),
            enteredBy: person(riskRow.id, riskRow.enteredById), enteredByRole: riskRow.enteredByRole as OrgRole, findingSeq: riskRow.findingSeq,
            receivedAt: riskRow.receivedAt.toISOString(), erasedFields: e?.fields ?? [],
          };
        }
        const state = stateOf.get(f.id) as FindingView['state'];
        const open = mitigations.filter((m) => m.status === 'planned' || m.status === 'in_progress');
        const view: FindingView = {
          id: f.id, projectId: f.projectId, stage: f.stage as Stage, source: f.source as FindingView['source'], questionId: f.questionId,
          decisionVersionId: f.decisionVersionId, riskArea: f.riskArea, title: f.title, description: f.description,
          raisedBy: person(f.id, f.raisedById), raisedAt: f.raisedAt.toISOString(), state,
          openMitigations: open.length, hasNoMitigation: open.length === 0,
          overdueMitigations: mitigations.filter((m) => isOverdue({ status: m.status, dueDate: m.dueDate }, state, today)).length,
        };
        const events = r.events.filter((x: EventRow) => x.findingId === f.id).map((x): FindingEventView => ({
          id: x.id, findingId: x.findingId, kind: x.kind as FindingEventView['kind'], eventCode: x.eventCode, reason: x.reason,
          by: person(x.id, x.byId), at: x.at.toISOString(), findingSeq: x.findingSeq,
        }));
        return { finding: view, mitigations, acceptedRisk, events };
      });

    const enteredByPeople = new Set([...decisions.values()].map((d) => d.row.enteredById)).size;
    let seal: StageSeal | StageDraft;
    let preparedFor: string | null;
    switch (r.origin.kind) {
      case 'sealed': {
        const row = r.origin.row;
        const review = row.stageReview;
        const erasedNote = erasedReviews.get(review.id)?.fields.includes('preparedFor') === true;
        seal = {
          kind: 'sealed', sealId: row.id, sealNumber: row.sealNumber, reviewId: review.id, reviewName: stageReviewName(stage, review.numberInStage),
          fingerprint: row.fingerprint, sealedAt: row.sealedAt.toISOString(), sealedBy: person(row.id, row.sealedById),
          sealedByRole: row.sealedByRole, enteredByPeople,
        };
        preparedFor = erasedNote ? null : review.preparedFor;
        break;
      }
      case 'draft':
        seal = {
          kind: 'draft', key: `draft:${stage}`, takenAt: r.origin.takenAt.toISOString(), enteredByPeople,
          openReview: r.origin.openReview, lastSealedReview: r.origin.lastSealedReview,
        };
        // A draft prints no review note: MP-01 names the review and its state only (ADR 0023).
        preparedFor = null;
        break;
    }
    stages[stage] = { stage, seal, preparedFor, manifest: r.manifest, decisions, derived: r.derived, findings };
  }

  return {
    stages, contents,
    erasures: {
      evidence: erasedEvidence, findings: erasedFindings,
      stage_reviews: await erasureDates(tx, 'stage_reviews', reviewIds),
      mitigation_versions: await erasureDates(tx, 'mitigation_versions', all.flatMap((r) => r.mitigations.map((m) => m.id))),
      accepted_risks: await erasureDates(tx, 'accepted_risks', all.flatMap((r) => r.risks.map((x) => x.id))),
    },
  };
}

/** The project's name, description and metadata (contract G068's text forms) and the organisation's name; a project not in the organisation is `NotFoundError`. */
async function readProjectHeader(tx: TenantTx, projectId: string): Promise<{ project: DocumentSnapshot['project']; organisationName: string }> {
  const project = await tx.project.findFirst({ where: { id: projectId }, select: { name: true, description: true } });
  if (project === null) throw new NotFoundError();
  const meta = await tx.projectMetadata.findFirst({ where: { projectId } });
  const metadata = Object.fromEntries(METADATA_KEYS.map((k) => [k, metadataText(meta === null ? null : (meta as Record<string, unknown>)[k])]));
  const orgRows = await tx.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "organizations" WHERE "id" = NULLIF(current_setting('app.current_org_id', true), '')`;
  // M10 is defensive and unreachable through the services: a context's organisation exists (membership references it), so no test can make this fail.
  if (orgRows.length !== 1) throw new Error('documents: the organisation of the current context has no row');
  return { project: { ...project, metadata }, organisationName: orgRows[0].name };
}

/**
 * Reads everything a document of the chosen seal contains, in the caller's transaction, which must be `RepeatableRead`
 * (NFR-INT-10): the chosen seal and the latest seal of each other stage first, then the rows each manifest names. The review
 * stage comes from the chosen seal, every other stage from its latest seal (FR-DOC-05); decisions are the sealed versions,
 * never a later one. `hooks.afterSeals` lets a test commit another connection's work between the reads.
 *
 * A path id that is not in the organisation's project is `NotFoundError`; a seal that is not this review's is 422 on `sealId`
 * with fixed text, never echoing the id; a seal that does not exist for this organisation is `NotFoundError` (AUTHZ ruling:
 * `body.sealId` of another organisation answers 404, no oracle). A seal whose stored bytes cannot vouch for it is refused (422)
 * when it is the chosen one and answers 500 `integrity_failure` when it is another stage's latest.
 */
export async function readDocumentSnapshot(
  tx: TenantTx, a: { projectId: string; reviewId: string; sealId: string; documentType: DocumentType },
  hooks?: { afterSeals?: (tx: TenantTx) => Promise<void> },
): Promise<SealedSnapshot> {
  const review = await tx.stageReview.findFirst({ where: { id: a.reviewId, projectId: a.projectId }, select: { id: true, stage: true } });
  if (review === null) throw new NotFoundError();
  const chosenRow = await tx.seal.findFirst({ where: { id: a.sealId }, select: SEAL_SELECT });
  if (chosenRow === null) throw new NotFoundError();
  if (chosenRow.stageReviewId !== review.id || chosenRow.stageReview.projectId !== a.projectId) {
    throw new ValidationFailed([{ field: 'sealId', message: DOCUMENTS_COPY.fieldMessages.sealNotOfReview }]);
  }
  const chosenManifest = trusted(chosenRow, true);
  if (chosenManifest === null) throw new ValidationFailed([{ field: 'sealId', message: MSG_SEAL_CHECK_FAILED }]);
  const reviewStage = chosenRow.stageReview.stage as Stage;

  const sealed = new Map<Stage, { row: SealRow; manifest: SealManifestV1 }>([[reviewStage, { row: chosenRow, manifest: chosenManifest }]]);
  for (const stage of STAGES) {
    if (stage === reviewStage) continue;
    const row = await tx.seal.findFirst({
      where: { stageReview: { projectId: a.projectId, stage } }, orderBy: [{ sealedAt: 'desc' }, { sealNumber: 'desc' }], select: SEAL_SELECT,
    });
    if (row === null) continue;
    const manifest = trusted(row, false);
    // Skipping it would print "Not recorded at the time of issue" for a stage that was sealed (D3): a false statement on a document that cannot be recalled.
    if (manifest === null) throw new AppError(500, 'integrity_failure', MSG_OTHER_SEAL_CHECK_FAILED);
    sealed.set(stage, { row, manifest });
  }

  await hooks?.afterSeals?.(tx);

  const raw = new Map<Stage, RawStage>();
  for (const [stage, s] of sealed) raw.set(stage, await readRawStage(tx, stage, { kind: 'sealed', row: s.row }, s.manifest));
  const today = eatDate(new Date());
  const { stages, contents, erasures } = await hydrateStages(tx, raw, today);
  const { project, organisationName } = await readProjectHeader(tx, a.projectId);
  // Every raw stage above has a sealed origin, so every hydrated stage is a `SealedStage`.
  const sealedStages = stages as Record<Stage, SealedStage | null>;
  return {
    provenance: { kind: 'sealed' }, documentType: a.documentType, reviewStage, chosen: sealedStages[reviewStage] as SealedStage, stages: sealedStages, contents, project,
    organisationName, today, erasures,
  };
}

// ─── The draft record (path to outputs, Task 6; ADR 0023) ───────────────────────────────────────────

type Row = Readonly<Record<string, unknown>>;
const textCol = (r: Row, k: string): string => {
  const v = r[k];
  if (typeof v !== 'string') throw new TypeError(`liveDecisionRows: decision_versions.${k} is not text`);
  return v;
};
const intCol = (r: Row, k: string): number => {
  const v = r[k];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`liveDecisionRows: decision_versions.${k} is not an integer`);
  return v;
};

/**
 * The stage rows with every version of each question whose current version the running content does not hold in that stage
 * removed (conflict 23): the planner refuses such a question (`stagePlan`, R-45), and a draft must not answer 500 for it. The
 * predicate is the planner's own: the highest `versionNumber` of each (stage, question), and the content's questions of that
 * stage, so a question moved to another stage is cut as well as one removed. `orphans` holds each cut current version's id, a
 * withdrawal included, for the caller to log; `omittedAnswers` counts those that are not withdrawals, the answers the report
 * leaves out. A row without the columns read throws, as the planner does.
 */
export function liveDecisionRows(rows: SealSourceRows, content: LoadedContent): { rows: SealSourceRows; orphans: string[]; omittedAnswers: number } {
  const key = (r: Row) => `${textCol(r, 'stage')}\u0000${textCol(r, 'questionId')}`;
  const current = new Map<string, Row>();
  for (const r of rows.decision_versions) {
    const k = key(r);
    const cur = current.get(k);
    if (cur === undefined || intCol(r, 'versionNumber') > intCol(cur, 'versionNumber')) current.set(k, r);
  }
  const held = new Map<string, ReadonlySet<string>>();
  const holds = (stage: string, question: string): boolean => {
    let ids = held.get(stage);
    if (ids === undefined) {
      ids = new Set(questionsInStage(content, stage as Stage).map((q) => q.id));
      held.set(stage, ids);
    }
    return ids.has(question);
  };
  const cut = new Set<string>();
  const orphans: string[] = [];
  let omittedAnswers = 0;
  for (const [k, r] of current) {
    if (holds(textCol(r, 'stage'), textCol(r, 'questionId'))) continue;
    cut.add(k);
    orphans.push(textCol(r, 'id'));
    if (r.status !== 'withdrawn') omittedAnswers += 1;
  }
  if (cut.size === 0) return { rows, orphans: [], omittedAnswers: 0 };
  return { rows: { ...rows, decision_versions: rows.decision_versions.filter((r) => !cut.has(key(r))) }, orphans: orphans.sort(), omittedAnswers };
}

/** What the working report is built from: every stage as its rows are now, read in one snapshot (ADR 0023). Nothing here is stored. */
export interface DraftRecord {
  takenAt: UtcInstant;
  /** Every stage, never null: a stage with no answers is an empty stage. */
  stages: Record<Stage, SnapshotStage>;
  /** The stages with at least one current decision that is not a withdrawal, in STAGES order. */
  stagesWithAnswers: Stage[];
  contents: ReadonlyMap<string, LoadedContent>;
  project: DocumentSnapshot['project'];
  organisationName: string;
  today: CalendarDate;
  erasures: DocumentSnapshot['erasures'];
  developmentStage: string | null;
  /** Current answers left out because the running content no longer holds their question (conflict 23); Task 7's page 1 is to print a line for them. */
  omittedAnswers: number;
  /** The same, per stage: a stage's plan and its end screen say how many of their own stage's answers are left out (fix wave item 10). */
  omittedByStage: Readonly<Record<Stage, number>>;
  /** See `SnapshotProvenance`: the recorded wording of each title-less shortfall finding's question the running content lacks (fix I1). */
  recordedQuestionWords: ReadonlyMap<string, string | null>;
}

/**
 * A draft-read warning, said once per id per process (final review M12; silent-failure audit M3). Every report view, download and
 * end screen reads the draft record, so a per-read line would repeat the same id all day and drown the signal. The ids already
 * said live on `globalThis`: Next bundles this module into more than one chunk, and module state would be one set per chunk.
 */
const DRAFT_WARNED = Symbol.for('makrai.documents.draftWarned');
function warnOncePerProcess(event: 'DRAFT_ORPHAN_DECISION' | 'DRAFT_CONTENT_VERSION_UNLISTED', id: string, details: Record<string, unknown>): void {
  const store = globalThis as unknown as { [DRAFT_WARNED]?: Set<string> };
  const said = (store[DRAFT_WARNED] ??= new Set<string>());
  const key = `${event}:${id}`;
  if (said.has(key)) return;
  said.add(key);
  logSecurityEvent(event, 'warn', { details });
}

/**
 * For each title-less shortfall finding of the stages whose question the running content does not hold, that question's words in the
 * content version its raising decision was recorded against, or null when this deployment does not list that version
 * (`unknown_content_version`), the version lacks the question, or the finding names no decision (Task 6 fix I1). A draft prints such a
 * finding from this, so a question a release removed never makes the draft throw and its finding is never dropped.
 */
async function recordedQuestionWordsOf(tx: TenantTx, stages: Iterable<SnapshotStage>, content: LoadedContent): Promise<Map<string, string | null>> {
  const wanted = [...stages].flatMap((s) => s.findings.map((sf) => sf.finding))
    .filter((f) => f.source === 'shortfall' && f.title === null && f.questionId !== null && !content.questions.has(f.questionId));
  const out = new Map<string, string | null>();
  if (wanted.length === 0) return out;
  const versionIds = [...new Set(wanted.flatMap((f) => (f.decisionVersionId === null ? [] : [f.decisionVersionId])))];
  const rows = await tx.decisionVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, contentVersionId: true } });
  const recordedIn = new Map(rows.map((r) => [r.id, r.contentVersionId]));
  const loaded = new Map<string, LoadedContent | null>();
  for (const contentVersionId of new Set(rows.map((r) => r.contentVersionId))) {
    try {
      loaded.set(contentVersionId, loadContent((await contentRefById(tx, contentVersionId)).semver));
    } catch (e) {
      if (!(e instanceof AppError && e.code === 'unknown_content_version')) throw e;
      // A packaging fault: an answer was recorded against a bundle this deployment does not hold (silent-failure audit M1).
      warnOncePerProcess('DRAFT_CONTENT_VERSION_UNLISTED', contentVersionId, { contentVersionId });
      loaded.set(contentVersionId, null);
    }
  }
  for (const f of wanted) {
    const cv = f.decisionVersionId === null ? undefined : recordedIn.get(f.decisionVersionId);
    const recorded = cv === undefined ? null : loaded.get(cv) ?? null;
    out.set(f.id, recorded?.questions.get(f.questionId as string)?.text ?? null);
  }
  return out;
}

/**
 * The draft record of a project (Task 6), in the caller's transaction, which must be a REPEATABLE READ `withOrg` (NFR-INT-10):
 * for each stage, the rows a seal of it taken now would name (`readStageRows`, `stagePlan` on the running content,
 * `manifestFromRows` with an in-memory header), then those rows by id and the same hydration as a sealed document. It reads no
 * seal row, manifest or sealed answer: the stage's reviews are read only for their names and whether a seal exists for each
 * (a relation filter that selects no seal column). There is no `assertProjectWritable` and no authorisation here: a reader of an
 * archived project gets the record, and the caller holds the read gate (Task 9). A project not in the organisation is `NotFoundError`.
 */
export async function readDraftRecord(tx: TenantTx, projectId: string, viewer: Actor): Promise<DraftRecord> {
  const { project, organisationName } = await readProjectHeader(tx, projectId);
  const [{ at }] = await tx.$queryRaw<{ at: Date }[]>`SELECT date_trunc('milliseconds', transaction_timestamp()) AS at`;
  // The control switch and the planned questions come from the running content only, never from a version an answer was recorded against.
  const running = await resolveRunningContentVersion(tx);
  const content = loadContent(running.semver);
  const orgId = await currentOrg(tx);
  await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
  // Tombstones of the same snapshot: an erased field enters the manifest as its tombstone digest, as a seal taken now would hold it.
  const tombstones = (await tx.$queryRawUnsafe<{ r: TombstoneRow }[]>(SEAL_SOURCE_SQL.tombstones, orgId)).map((x) => x.r);

  const reviewSelect = { id: true, stage: true, numberInStage: true } as const;
  const newestOf = (rows: Array<{ id: string; stage: string; numberInStage: number }>, stage: Stage): DraftReviewRef | null => {
    const newest = rows.filter((x) => x.stage === stage).sort((x, y) => y.numberInStage - x.numberInStage)[0];
    return newest === undefined ? null : { reviewId: newest.id, reviewName: stageReviewName(stage, newest.numberInStage) };
  };
  const unsealed = await tx.stageReview.findMany({ where: { projectId, seals: { none: {} } }, select: reviewSelect });
  const sealedReviews = await tx.stageReview.findMany({ where: { projectId, seals: { some: {} } }, select: reviewSelect });

  const raw = new Map<Stage, RawStage>();
  let omittedAnswers = 0;
  const omittedByStage = Object.fromEntries(STAGES.map((st) => [st, 0])) as Record<Stage, number>;
  for (const stage of STAGES) {
    const live = liveDecisionRows(await readStageRows(tx, projectId, stage), content);
    for (const decisionVersionId of live.orphans) warnOncePerProcess('DRAFT_ORPHAN_DECISION', decisionVersionId, { decisionVersionId, stage });
    omittedAnswers += live.omittedAnswers;
    omittedByStage[stage] = live.omittedAnswers;
    const plan = stagePlan(live.rows, { stage, content });
    const header: DraftHeader = {
      sealRow: {
        id: `draft:${stage}`, orgId, stageReviewId: `draft-review:${stage}`, sealNumber: 0, contentVersionId: running.contentVersionId,
        sealedById: viewer.userId, sealedByRole: viewer.role, sealedAt: at.toISOString(),
      },
      reviewRow: { id: `draft-review:${stage}`, orgId, projectId, stage, numberInStage: 0, preparedFor: null, preparedForSalt: null },
    };
    const manifest = manifestFromRows(
      { ...live.rows, seals: [header.sealRow], stage_reviews: [...live.rows.stage_reviews, header.reviewRow] },
      { sealId: `draft:${stage}`, ...plan }, tombstones,
    );
    raw.set(stage, await readRawStage(tx, stage, {
      kind: 'draft', takenAt: at, header, openReview: newestOf(unsealed, stage), lastSealedReview: newestOf(sealedReviews, stage),
    }, manifest));
  }

  const today = eatDate(at);
  const { stages, contents, erasures } = await hydrateStages(tx, raw, today);
  const every = Object.fromEntries(STAGES.map((st) => {
    const s = stages[st];
    if (s === null) throw new Error(`documents: the draft record has no ${st} stage`);
    return [st, s];
  })) as Record<Stage, SnapshotStage>;
  return {
    takenAt: at.toISOString(), stages: every,
    stagesWithAnswers: STAGES.filter((st) => every[st].manifest.decisions.some((d) => 'id' in d)),
    contents, project, organisationName, today, erasures, developmentStage: project.metadata.developmentStage ?? null, omittedAnswers, omittedByStage,
    recordedQuestionWords: await recordedQuestionWordsOf(tx, Object.values(every), content),
  };
}

/** The draft snapshot of one document of a draft record (pure): the one resolver reads it as it reads an issued one (ADR 0023). */
export function draftSnapshot(r: DraftRecord, documentType: DocumentType, reviewStage: Stage): DocumentSnapshot {
  return {
    provenance: { kind: 'draft', takenAt: r.takenAt, omittedAnswers: r.omittedAnswers, recordedQuestionWords: r.recordedQuestionWords }, documentType, reviewStage, chosen: r.stages[reviewStage],
    stages: r.stages, contents: r.contents, project: r.project, organisationName: r.organisationName, today: r.today, erasures: r.erasures,
  };
}

// ─── Views ───────────────────────────────────────────────────────────────────────────────────────

/**
 * `IssuedDocumentView` of each document id of the transaction's organisation (contract G070). The bytes are never read:
 * `erased` comes from `pdf IS NULL` and the latest tombstone of the document or of a source row it printed (the erasure
 * functions null `pdf` when a printed field or file is erased). `seals[0]` is the seal the document came from (the home seal,
 * `issued_documents.sealId`); the rest follow in STAGES order (G069). `withdrawn` is the `document_events` row of kind `withdrawn`.
 */
export async function documentViews(tx: TenantTx, ids: readonly string[]): Promise<Map<string, IssuedDocumentView>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const rows = await tx.issuedDocument.findMany({
    where: { id: { in: wanted } },
    select: { id: true, projectId: true, stageReviewId: true, sealId: true, documentType: true, sha256: true, byteSize: true, issuedById: true, issuedAt: true, seals: { select: { sealId: true } } },
  });
  const sealIds = [...new Set(rows.flatMap((r) => [r.sealId, ...r.seals.map((s) => s.sealId)]))];
  const sealRows = await tx.seal.findMany({
    where: { id: { in: sealIds } },
    select: { id: true, sealNumber: true, fingerprint: true, stageReview: { select: { id: true, stage: true, numberInStage: true } } },
  });
  const sealOf = new Map(sealRows.map((s) => [s.id, {
    sealId: s.id, sealNumber: s.sealNumber, reviewId: s.stageReview.id, reviewName: stageReviewName(s.stageReview.stage as Stage, s.stageReview.numberInStage),
    fingerprint: s.fingerprint, stage: s.stageReview.stage as Stage,
  }]));
  const gone = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "issued_documents" WHERE "id" = ANY (${wanted}::text[]) AND "pdf" IS NULL`;
  // A tombstone carries erase_text_field's key ('fileName'); a source row may carry the key or the column ('filename'). The function nulls
  // a document through either, so a tombstone is found through the same mapping (ERASABLE_FIELDS, checked against the migration by a test).
  const gonePairs = gone.map((g) => g.id);
  const erasures = gone.length === 0 ? [] : await tx.$queryRawUnsafe<{ id: string; erasedOn: CalendarDate }[]>(`
    WITH m(tbl, key, col) AS (VALUES ${ERASABLE_FIELDS.map(([t, k, c]) => `('${t}', '${k}', '${c}')`).join(', ')})
    SELECT x."id", to_char(max(x."at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "erasedOn" FROM (
      SELECT t."targetId" AS "id", t."at" FROM "tombstones" t
      WHERE t."targetTable" = 'issued_documents' AND t."targetId" = ANY ($1::text[])
      UNION ALL
      SELECT s."documentId" AS "id", t."at" FROM "issued_document_sources" s
      JOIN "tombstones" t ON t."targetTable" = s."sourceTable" AND t."targetId" = s."sourceId"
        AND (t."field" IS NOT DISTINCT FROM s."field"
             OR EXISTS (SELECT 1 FROM m WHERE m.tbl = t."targetTable" AND m.key = t."field" AND m.col = s."field"))
      WHERE s."documentId" = ANY ($1::text[])
    ) x GROUP BY x."id"`, gonePairs);
  const erasedOn = new Map(erasures.map((e) => [e.id, e.erasedOn]));
  const events = await tx.documentEvent.findMany({ where: { documentId: { in: wanted }, kind: 'withdrawn' }, orderBy: { at: 'asc' }, select: { documentId: true, reason: true, at: true } });
  const refs = await userRefs(tx, rows.map((r) => r.issuedById));
  const out = new Map<string, IssuedDocumentView>();
  for (const r of rows) {
    const issuedBy = refs.get(r.issuedById);
    if (issuedBy === undefined) throw new Error(`documents: document ${r.id} names user ${r.issuedById}, which has no account row`);
    const home = sealOf.get(r.sealId);
    if (home === undefined) throw new Error(`documents: document ${r.id} names a seal that has no row`);
    const others = r.seals.filter((s) => s.sealId !== r.sealId).map((s) => {
      const known = sealOf.get(s.sealId);
      if (known === undefined) throw new Error(`documents: document ${r.id} names seal ${s.sealId}, which has no row`);
      return known;
    }).sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
    const withdrawn = events.find((e) => e.documentId === r.id);
    let erased: IssuedDocumentView['erased'] = null;
    if (gone.some((g) => g.id === r.id)) {
      const on = erasedOn.get(r.id);
      // The erasure functions write a tombstone with every null they make; bytes gone without one are a broken row, not a state to show.
      if (on === undefined) throw new Error(`documents: document ${r.id} has no bytes and no tombstone`);
      erased = { erasedOn: on };
    }
    out.set(r.id, {
      id: r.id, projectId: r.projectId, reviewId: r.stageReviewId, documentType: r.documentType as DocumentType, sha256: r.sha256, byteSize: r.byteSize,
      issuedBy, issuedAt: r.issuedAt.toISOString(),
      seals: [home, ...others].map(({ stage: _stage, ...s }) => s),
      withdrawn: withdrawn === undefined ? null : { on: day(withdrawn.at), reason: withdrawn.reason }, erased,
    });
  }
  return out;
}

/**
 * The body of routes 15 and 16: `{ documentType, sealId, typedFields }` and, for the issue, `requestId`. Any other key is refused on
 * its field; the values are checked further by the service (document type, typed field ids and lengths).
 */
export function parseDocumentRequest(body: unknown, keyed: false): PreviewDocumentRequest;
export function parseDocumentRequest(body: unknown, keyed: true): PreviewDocumentRequest & { requestId: string };
export function parseDocumentRequest(body: unknown, keyed: boolean): PreviewDocumentRequest & { requestId?: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: DOCUMENTS_COPY.fieldMessages.unreadable }]);
  }
  const known = keyed ? ['documentType', 'sealId', 'typedFields', 'requestId'] : ['documentType', 'sealId', 'typedFields'];
  const extra = Object.keys(body).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { documentType, sealId, typedFields, requestId } = body as Record<string, unknown>;
  if (keyed && !isRequestId(requestId)) throw new ValidationFailed([{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }]);
  if (typeof sealId !== 'string' || sealId === '') throw new ValidationFailed([{ field: 'sealId', message: DOCUMENTS_COPY.fieldMessages.chooseSeal }]);
  return {
    documentType: documentType as PreviewDocumentRequest['documentType'], sealId,
    typedFields: (typedFields === undefined ? {} : typedFields) as Record<string, string>,
    ...(keyed ? { requestId: requestId as string } : {}),
  };
}

// ─── Preview and issue ───────────────────────────────────────────────────────────────────────────

/** "A value over its length limit" (D5): each typed value is at most this many characters. */
export const TYPED_VALUE_MAX = 2000;
const ETHICS_STATE_VALUES: readonly string[] = ETHICS_STATES.map(([value]) => value);

const typedKeys = (map: FieldMap): ReadonlySet<string> => new Set(typedEntries(map).flatMap((e) => (e.structured === 'ethics_approval' ? ethicsFieldIds(e.fieldId) : [e.fieldId])));

/**
 * The typed values a request may carry (D5): only field ids the map declares typed (and the sub-fields of the ethics review), text of
 * at most 2000 characters, and a known ethics state. A blank value is not kept. What is kept is the value exactly as typed: the
 * issued copy and the project's draft must be byte-identical, because the erasure of a typed field removes a draft value only when
 * it equals the erased text (REV-b's `erase_typed_field`).
 */
function checkTyped(map: FieldMap, typedFields: unknown): Record<string, string> {
  if (typeof typedFields !== 'object' || typedFields === null || Array.isArray(typedFields)) {
    throw new ValidationFailed([{ field: 'typedFields', message: 'typedFields must be an object.' }]);
  }
  const allowed = typedKeys(map);
  const errors: FieldError[] = [];
  const kept: Record<string, string> = {};
  for (const [id, value] of Object.entries(typedFields)) {
    const field = `typedFields.${id}`;
    if (!allowed.has(id)) errors.push({ field, message: DOCUMENTS_COPY.fieldMessages.notTypeable });
    else if (typeof value !== 'string') errors.push({ field, message: DOCUMENTS_COPY.fieldMessages.mustBeText });
    else if (value.length > TYPED_VALUE_MAX) errors.push({ field, message: DOCUMENTS_COPY.fieldMessages.tooLong(TYPED_VALUE_MAX) });
    else if (id.endsWith(':state') && value.trim() !== '' && !ETHICS_STATE_VALUES.includes(value.trim())) errors.push({ field, message: DOCUMENTS_COPY.fieldMessages.chooseEthics });
    else if (value.trim() !== '') kept[id] = value;
  }
  // The ethics review (CG-10) prints through its state: a sub-value with no state, or one that state does not use, would be stored and never printed.
  for (const e of map.fields) {
    if (!e.sources.some((x) => x.kind === 'typed' && x.structured === 'ethics_approval')) continue;
    const state = (kept[`${e.fieldId}:state`] ?? '').trim();
    const usedBy: Record<string, readonly string[]> = { approved: ['committee', 'reference', 'date'], submitted: [], not_required: ['why', 'decidedBy'], '': [] };
    for (const sub of ['committee', 'reference', 'date', 'why', 'decidedBy']) {
      const id = `${e.fieldId}:${sub}`;
      if (kept[id] === undefined || errors.some((x) => x.field === `typedFields.${id}`)) continue;
      if (state === '') errors.push({ field: `typedFields.${e.fieldId}:state`, message: DOCUMENTS_COPY.fieldMessages.chooseEthics });
      else if (!usedBy[state].includes(sub)) errors.push({ field: `typedFields.${id}`, message: DOCUMENTS_COPY.fieldMessages.notOfState });
    }
  }
  if (errors.length > 0) throw new ValidationFailed(errors);
  return Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
}

function checkType(documentType: unknown): DocumentType {
  if (typeof documentType !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw new ValidationFailed([{ field: 'documentType', message: DOCUMENTS_COPY.fieldMessages.chooseDocument }]);
  }
  return documentType as DocumentType;
}

type DocumentRequest = PreviewDocumentRequest & { projectId: string; reviewId: string };

/**
 * One REPEATABLE READ transaction for everything a document holds (NFR-INT-10): the project must be writable (it takes the row
 * FOR SHARE, as every writer does, so PRJ's delete and the archive wait for it), then the snapshot, then the database's current
 * second (the issue time, G065). A 40001 means the project row changed after this snapshot; one more attempt reads a new one, as
 * `sealStageReview` does, and a second 40001 is thrown on.
 */
async function readForDocument(ctx: OrgContext, a: DocumentRequest): Promise<ReadForDocument> {
  const attempt = () => withOrg(ctx, async (tx) => {
    await assertProjectWritable(tx, a.projectId);
    const snap = await readDocumentSnapshot(tx, a);
    // What the seal check compares with each seal, from the same snapshot (FR-REV-06): the rows each manifest was built from (the stage's
    // own rows, STAGE_SOURCE_SQL, as the seal builder read them), the project's seals, and the organisation's tombstones. The comparison
    // runs after the transaction closes. checkSealRows reads only the named rows and the version before each (C4 CR-7: nothing outside the stage).
    const sealIds = STAGES.flatMap((st) => (snap.stages[st] === null ? [] : [snap.stages[st]!.seal.sealId]));
    const seals = await tx.seal.findMany({ where: { id: { in: sealIds } }, select: { id: true, manifest: true, fingerprint: true } });
    const stageRows: Partial<Record<Stage, SealSourceRows>> = {};
    for (const st of STAGES) if (snap.stages[st] !== null) stageRows[st] = await readStageRows(tx, a.projectId, st);
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);
    const sealRows = (await tx.$queryRaw<{ r: unknown }[]>`
      SELECT row_to_json(t) AS r FROM seals t WHERE t."orgId" = ${ctx.orgId} AND t."stageReviewId" IN (SELECT "id" FROM stage_reviews WHERE "orgId" = ${ctx.orgId} AND "projectId" = ${a.projectId})`).map((x) => x.r);
    const tombstones = (await tx.$queryRawUnsafe<{ r: unknown }[]>(SEAL_SOURCE_SQL.tombstones, ctx.orgId)).map((x) => x.r);
    const [{ at }] = await tx.$queryRaw<{ at: Date }[]>`SELECT date_trunc('second', clock_timestamp()) AS at`;
    return { snap, issuedAt: at, seals, stageRows, sealRows, tombstones };
  }, { isolationLevel: 'RepeatableRead', timeoutMs: READ_TIMEOUT_MS });
  let read: Awaited<ReturnType<typeof attempt>>;
  try {
    read = await attempt();
  } catch (e) {
    if (!isSerializationFailure(e)) throw e;
    read = await attempt();
  }
  checkSealsAgainstRows(read.snap, read.seals, read.stageRows, read.sealRows, read.tombstones);
  return {
    snap: read.snap, issuedAt: read.issuedAt,
    tombstoneIds: new Set(read.tombstones.map((t) => String((t as { id: unknown }).id))),
  };
}
interface ReadForDocument { snap: SealedSnapshot; issuedAt: Date; tombstoneIds: ReadonlySet<string> }

/**
 * M13 (FR-REV-06, FR-REV-08): before anything is rendered, every seal the document uses is compared with the rows it names, as "Check
 * this seal" does. A field the operator erased is a tombstone the seal check accepts, so it is not a mismatch and still generates. A
 * mismatch is logged at error with the seal id; the chosen seal answers 422 on sealId with the same words as a failed `trustedManifest`
 * check, and another stage's seal answers 500 `integrity_failure`.
 */
function checkSealsAgainstRows(
  snap: SealedSnapshot, seals: Array<{ id: string; manifest: Uint8Array; fingerprint: string }>, stageRows: Partial<Record<Stage, SealSourceRows>>,
  sealRows: unknown[], tombstones: unknown[],
): void {
  for (const st of STAGES) {
    const sealed = snap.stages[st];
    if (sealed === null) continue;
    const seal = seals.find((x) => x.id === sealed.seal.sealId);
    const rows = stageRows[st];
    if (seal === undefined || rows === undefined) throw new Error(`documents: seal ${sealed.seal.sealId} is not among the rows read for it`);
    const result = checkSealRows({
      sealId: seal.id, manifestBytes: seal.manifest, fingerprint: seal.fingerprint,
      rows: { ...rows, seals: sealRows } as unknown as SealSourceRows, tombstones: tombstones as TombstoneRow[],
    });
    if (result.kind === 'valid') continue;
    logSecurityEvent('SEAL_CHECK_FAILED', 'error', { details: { sealId: seal.id, kind: result.kind, stage: st, chosen: st === snap.reviewStage } });
    if (st === snap.reviewStage) throw new ValidationFailed([{ field: 'sealId', message: MSG_SEAL_CHECK_FAILED }]);
    throw new AppError(500, 'integrity_failure', MSG_OTHER_SEAL_CHECK_FAILED);
  }
}
/** Prisma's interactive-transaction default is 5 s; the snapshot of a large review reads more rows than that allows on a slow disk. */
const READ_TIMEOUT_MS = 15_000;

const sealsOf = (snap: SealedSnapshot, ids: readonly string[]): Extract<RenderInput['stamp'], { kind: 'issued' }>['seals'] => ids.map((id) => {
  const stage = STAGES.map((s) => snap.stages[s]).find((s) => s?.seal.sealId === id);
  if (stage === undefined || stage === null) throw new Error(`documents: the document used seal ${id}, which is not in its snapshot`);
  return { sealId: id, sealNumber: stage.seal.sealNumber, reviewId: stage.seal.reviewId, reviewName: stage.seal.reviewName, fingerprint: stage.seal.fingerprint };
});

/** A draft snapshot reached the issue path, past the `SealedSnapshot` type through a cast (anti-goal 5: a draft is never issued). */
class DraftSnapshotRefused extends Error {
  override readonly name = 'DraftSnapshotRefused';
  constructor() {
    super('documents: a draft snapshot reached the issue path; a draft is never issued (ADR 0023)');
  }
}

/**
 * Anti-goal 5 at run time. The type keeps a draft off this path, but a cast gets past a type, and a draft cast to `SealedSnapshot`
 * would resolve ("Not sealed", no seal ids) and be stored in `issued_documents`. So `build` refuses it before resolving anything.
 */
function assertSealedProvenance(provenance: SnapshotProvenance): void {
  switch (provenance.kind) {
    case 'sealed': return;
    case 'draft': throw new DraftSnapshotRefused();
  }
}

/** Resolves and renders outside every transaction (NFR-PERF-04: CPU in the one Node process). */
async function build(type: DocumentType, renderer: Renderer, snap: SealedSnapshot, typed: Record<string, string>, issuedAt: Date) {
  assertSealedProvenance(snap.provenance);
  const map = loadFieldMap(type);
  const resolved = resolveFields(map, snap, typed);
  const input: RenderInput = {
    map, fields: resolved.fields, stamp: { kind: 'issued', issuedAt: issuedAt.toISOString(), seals: sealsOf(snap, resolved.sealIds) },
    organisationName: snap.organisationName, projectName: snap.project.name,
  };
  return { map, resolved, rendered: await renderer(input) };
}

/** The renderer of a type, loaded here and only here (conflict 3 a): the draft pages read documents without pulling React PDF in. */
async function rendererFor(type: DocumentType): Promise<Renderer> {
  const { RENDERERS } = await import('@/lib/documents/render');
  const renderer = RENDERERS[type];
  if (renderer === null) throw new NotImplementedError('DOC-b');
  return renderer;
}

/** FR-DOC-08: the full text as it will print, with the fields that read "Not recorded" and the typed ones; nothing is stored. */
export async function previewDocument(ctx: OrgContext, actor: Actor, a: DocumentRequest): Promise<DocumentPreview> {
  assertCan(ctx, 'document:generate');
  const type = checkType(a.documentType);
  const renderer = await rendererFor(type);
  const typed = checkTyped(loadFieldMap(type), a.typedFields);
  const { snap, issuedAt } = await readForDocument(ctx, { ...a, documentType: type });
  const { resolved, rendered } = await build(type, renderer, snap, typed, issuedAt);
  return { documentType: type, sealId: a.sealId, text: rendered.plainText, notRecordedFields: resolved.notRecordedFields, typedFields: resolved.typedFieldIds };
}

/** An operator erasure committed after the snapshot a document was rendered from (F6). */
class StaleSnapshot extends Error {}

/**
 * In the write transaction, before the row goes in: no printed row has a tombstone the snapshot did not hold. A row inserted after an
 * erasure's UPDATE of the documents that named its source would keep the erased text, so this check narrows the window from the render
 * (seconds) to the milliseconds between this query and the commit; the advisory lock the write takes first (shared, keyed by the organisation) closes
 * the rest, since the erasure functions take the exclusive form (I1). A row lock on the sources is not possible: the application role may not
 * SELECT ... FOR SHARE the append-only tables (no UPDATE privilege).
 */
async function assertNoNewerErasure(tx: TenantTx, sources: ReadonlyArray<{ sourceTable: string; sourceId: string }>, known: ReadonlySet<string>): Promise<void> {
  const pairs = [...new Map(sources.map((s) => [`${s.sourceTable}|${s.sourceId}`, s])).values()];
  if (pairs.length === 0) return;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT t."id" FROM "tombstones" t JOIN unnest(${pairs.map((p) => p.sourceTable)}::text[], ${pairs.map((p) => p.sourceId)}::text[]) AS s(tbl, rid)
      ON t."targetTable" = s.tbl AND t."targetId" = s.rid`;
  if (rows.some((r) => !known.has(r.id))) throw new StaleSnapshot('documents: a printed row was erased after the snapshot');
}

const SECOND_KEY = 'issued_documents_second_key';
const MAX_SECOND_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until the database's second is later than `last` (FR-DOC-04: a second issue in the same second waits for the next one). */
async function waitPast(ctx: OrgContext, last: Date, busy: () => AppError): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const [{ ok }] = await withOrg(ctx, (tx) => tx.$queryRaw<{ ok: boolean }[]>`SELECT date_trunc('second', clock_timestamp()) > ${last}::timestamptz AS ok`);
    if (ok) return;
    await sleep(50);
  }
  throw busy();
}

/**
 * 503 `document_issue_busy` (S-18 shows its no-reply line with Retry): the same-second retries ran out, or the database clock never reached the next second. Logged with
 * the organisation, the seal, the type and the attempt count, under its own event name (not RATE_LIMIT_EXCEEDED, which counts abuse); no text of the document is in the line.
 */
function issueBusy(ctx: OrgContext, a: { sealId: string }, type: DocumentType, attempts: number): AppError {
  logSecurityEvent('DOCUMENT_ISSUE_BUSY', 'warn', { details: { orgId: ctx.orgId, sealId: a.sealId, documentType: type, attempts } });
  return new AppError(503, 'document_issue_busy');
}

/**
 * Issues one document (FR-DOC-04). The snapshot is read in one repeatable-read transaction, the document is rendered outside any
 * transaction with the database's second as its issue time, and `idempotentWrite` stores it: the row with its bytes and SHA-256,
 * a row per seal used, a row per printed record field and evidence file (SRS 5.6), and the project's draft of typed values, all in
 * one transaction that first calls `assertProjectWritable` (it takes the project row FOR SHARE, so a delete or archive that
 * commits meanwhile cannot leave this document behind it). A request id that is already stored replays without rendering. Two
 * documents of one seal and type in the same second collide on `issued_documents_second_key`: the later waits for the next
 * second, renders again with it, and tries again, at most three times.
 */
export async function issueDocument(ctx: OrgContext, actor: Actor, a: DocumentRequest & { requestId: string }, digest: string): Promise<WriteOutcome<IssuedDocumentView>> {
  assertCan(ctx, 'document:generate');
  if (!isRequestId(a.requestId)) throw new ValidationFailed([{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }]);
  const type = checkType(a.documentType);
  const renderer = await rendererFor(type);
  const typed = checkTyped(loadFieldMap(type), a.typedFields);

  const replay = (tx: TenantTx, rowId: string) => documentViews(tx, [rowId]).then((m) => {
    const view = m.get(rowId);
    if (view === undefined) throw new Error(`documents: document ${rowId} has no view`);
    return view;
  });
  // A stored request id replays, or answers 409, in idempotentWrite; looking first spares the render and does not depend on the
  // project still being writable (a replay writes nothing).
  const known = await withOrg(ctx, (tx) => tx.issuedDocument.findFirst({ where: { requestId: a.requestId }, select: { id: true } }));
  if (known !== null) {
    return idempotentWrite<IssuedDocumentView>(ctx, {
      table: 'issued_documents', requestId: a.requestId, digest, actorUserId: actor.userId, replay,
      write: () => { throw new Error('documents: a stored request id reached the write'); },
    });
  }

  let last: Date | null = null;
  let staleRetried = false;
  for (let retry = 0; ; retry += 1) {
    if (last !== null) await waitPast(ctx, last, () => issueBusy(ctx, a, type, retry + 1));
    const { snap, issuedAt, tombstoneIds } = await readForDocument(ctx, { ...a, documentType: type });
    const { map, resolved, rendered } = await build(type, renderer, snap, typed, issuedAt);
    const sha256 = createHash('sha256').update(rendered.pdf).digest('hex');
    try {
      const out = await idempotentWrite<IssuedDocumentView>(ctx, {
        // READ COMMITTED on purpose (I1): the erasure lock below is only met by statements that take a fresh snapshot after the wait.
        table: 'issued_documents', requestId: a.requestId, digest, actorUserId: actor.userId, replay, isolationLevel: 'ReadCommitted',
        write: async (tx) => {
          await assertProjectWritable(tx, a.projectId);
          // I1: the shared form of the erasure functions' lock (the doc_erasure_lock migration), so an erasure that overlaps this write waits
          // for its commit and then nulls this document, or has committed already and the check below sees its tombstone.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('makrai.erasure:' || ${ctx.orgId}::text, 0))`;
          await assertNoNewerErasure(tx, resolved.sources, tombstoneIds);
          const created = await tx.issuedDocument.create({
            data: {
              orgId: ctx.orgId, projectId: a.projectId, stageReviewId: a.reviewId, sealId: a.sealId, documentType: type, templateVersion: map.templateVersion,
              typedFields: Object.entries(typed).map(([fieldId, value]): TypedFieldValue => ({ fieldId, value, salt: randomBytes(16).toString('hex') })) as unknown as Prisma.InputJsonValue,
              pdf: Uint8Array.from(rendered.pdf), plainText: rendered.plainText, sha256, byteSize: rendered.pdf.length,
              issuedById: actor.userId, issuedAt, requestId: a.requestId, requestDigest: digest,
            },
            select: { id: true },
          });
          await tx.issuedDocumentSeal.createMany({ data: resolved.sealIds.map((sealId) => ({ orgId: ctx.orgId, documentId: created.id, sealId })) });
          if (resolved.sources.length > 0) {
            await tx.issuedDocumentSource.createMany({ data: resolved.sources.map((s) => ({ orgId: ctx.orgId, documentId: created.id, ...s })) });
          }
          await tx.documentDraftFields.upsert({
            where: { orgId_projectId_documentType: { orgId: ctx.orgId, projectId: a.projectId, documentType: type } },
            create: { orgId: ctx.orgId, projectId: a.projectId, documentType: type, fieldValues: typed, updatedById: actor.userId },
            update: { fieldValues: typed, updatedById: actor.userId },
          });
          return replay(tx, created.id);
        },
      });
      if (!out.replayed) {
        logSecurityEvent('DOCUMENT_ISSUED', 'info', { details: { orgId: ctx.orgId, documentId: out.value.id, documentType: type, sha256: out.value.sha256 } });
      }
      return out;
    } catch (e) {
      if (e instanceof StaleSnapshot) {
        // An erasure committed between the snapshot and this write: once more from a fresh snapshot, which then prints the erasure line.
        if (staleRetried) throw issueBusy(ctx, a, type, retry + 1);
        staleRetried = true;
        continue;
      }
      if (isUniqueViolation(e) && uniqueViolationIndex(e) === SECOND_KEY) {
        if (retry < MAX_SECOND_RETRIES) { last = issuedAt; continue; }
        throw issueBusy(ctx, a, type, retry + 1);
      }
      throw e;
    }
  }
}

// ─── Lists, drafts and downloads ─────────────────────────────────────────────────────────────────

/** The project's issued documents, newest first (S-18, S-16); the bytes stay in the table. */
export async function listDocuments(ctx: OrgContext, filter: { projectId: string; reviewId?: string }): Promise<IssuedDocumentView[]> {
  return withOrg(ctx, async (tx) => {
    const rows = await tx.issuedDocument.findMany({
      where: { projectId: filter.projectId, ...(filter.reviewId === undefined ? {} : { stageReviewId: filter.reviewId }) },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }], select: { id: true },
    });
    const views = await documentViews(tx, rows.map((r) => r.id));
    return rows.map((r) => views.get(r.id) as IssuedDocumentView);
  });
}

/** The typed values last issued for the project and document type, exactly as typed (FR-DOC-03); for those who may generate only (D12). */
export async function documentDraft(ctx: OrgContext, projectId: string, type: DocumentType): Promise<Record<string, string>> {
  assertCan(ctx, 'document:generate');
  const row = await withOrg(ctx, (tx) => tx.documentDraftFields.findFirst({ where: { projectId, documentType: type }, select: { fieldValues: true } }));
  return row === null ? {} : { ...(row.fieldValues as Record<string, string>) };
}

/** The fields a person types into for a document type (FR-DOC-03), in map order: S-18 shows these inputs. */
export function typedFieldsOf(type: DocumentType): Array<{ fieldId: string; label: string; structured?: 'ethics_approval' }> {
  return typedEntries(loadFieldMap(type));
}

/**
 * What S-18 says before generating (UX-20): for each document type whose renderer exists, how many fields come from how many
 * questions, how many would read "Not recorded" with the draft values, and the stages the document needs that were never
 * sealed (FR-DOC-05). One repeatable-read snapshot, nothing rendered. A type with no renderer yet (the mitigation plan until DOC-b
 * registers it) is `null`.
 */
export async function documentSummaries(
  ctx: OrgContext, a: { projectId: string; reviewId: string; sealId: string }, drafts: Readonly<Record<DocumentType, Record<string, string>>>,
): Promise<Record<DocumentType, { fields: number; questions: number; notRecorded: number; neverSealedStages: Stage[] } | null>> {
  assertCan(ctx, 'record:read');
  const { RENDERERS } = await import('@/lib/documents/render');
  const types = DOCUMENT_TYPES.filter((t) => RENDERERS[t] !== null);
  const snap = await withOrg(ctx, (tx) => readDocumentSnapshot(tx, { ...a, documentType: types[0] }), { isolationLevel: 'RepeatableRead', timeoutMs: READ_TIMEOUT_MS });
  const out = { data_card: null, model_card: null, mitigation_plan: null } as Record<DocumentType, { fields: number; questions: number; notRecorded: number; neverSealedStages: Stage[] } | null>;
  const running = runningContent();
  for (const type of types) {
    const map = loadFieldMap(type);
    const resolved = resolveFields(map, { ...snap, documentType: type }, drafts[type]);
    const questions = new Set(map.fields.flatMap((e) => e.sources.flatMap((s) => (s.kind === 'record' || s.kind === 'record_option' ? [s.questionId] : []))));
    const needed = new Set<Stage>([...questions].map((q) => (running.questions.get(q) as { stage: Stage }).stage));
    for (const e of map.fields) for (const s of e.sources) if ('stage' in s && s.stage !== undefined) needed.add(s.stage === 'review' ? snap.reviewStage : s.stage);
    out[type] = {
      fields: map.fields.length, questions: questions.size, notRecorded: resolved.notRecordedFields.length,
      neverSealedStages: STAGES.filter((st) => needed.has(st) && snap.stages[st] === null),
    };
  }
  return out;
}

const FILE_PREFIX: Readonly<Record<DocumentType, string>> = { data_card: 'data-card', model_card: 'model-card', mitigation_plan: 'mitigation-plan' };

/**
 * Route 17: the stored bytes, after their SHA-256 is compared with the stored one (NFR-INT-06). Nothing is regenerated. A missing
 * row or another organisation's is not found; bytes the operator erased answer 410 with the date; bytes that do not hash to the
 * stored value are never served: the failure is logged (ids only) and answers 500 `integrity_failure`.
 */
export async function readDocumentPdf(ctx: OrgContext, documentId: string): Promise<{ bytes: Buffer; fileName: string }> {
  const found = await withOrg(ctx, async (tx) => {
    const row = await tx.issuedDocument.findUnique({ where: { id: documentId }, select: { id: true, documentType: true, sha256: true, issuedAt: true, pdf: true } });
    if (row === null) return null;
    const erasedOn = row.pdf === null ? ((await documentViews(tx, [documentId])).get(documentId)?.erased?.erasedOn ?? null) : null;
    return { row, erasedOn };
  });
  if (found === null) throw new NotFoundError();
  if (found.row.pdf === null) {
    if (found.erasedOn === null) throw new Error(`documents: document ${documentId} has no bytes and no tombstone`);
    throw new ErasedError(found.erasedOn);
  }
  const bytes = Buffer.from(found.row.pdf.buffer, found.row.pdf.byteOffset, found.row.pdf.byteLength);
  if (createHash('sha256').update(bytes).digest('hex') !== found.row.sha256) {
    logSecurityEvent('DOCUMENT_INTEGRITY_FAILURE', 'critical', { details: { orgId: ctx.orgId, documentId } });
    throw new AppError(500, 'integrity_failure', MSG_DOCUMENT_CHECK_FAILED);
  }
  return { bytes, fileName: `${FILE_PREFIX[found.row.documentType as DocumentType]}-${day(found.row.issuedAt)}-${documentId.slice(0, 8)}.pdf` };
}

// ─── Withdrawal and the plain-text copy (FR-DOC-06, FR-DOC-07) ─────────────────────────────────────

/** The reason of a withdrawal is 1 to 1,000 characters after trimming (FR-DOC-06). */
const WITHDRAWAL_REASON_MAX = 1000;

/** The body of route 19: `{ requestId, reason }` and nothing else. The reason is trimmed and NFC-normalised, 1 to 1,000 characters, and storable. */
export function parseWithdrawDocumentRequest(body: unknown): WithdrawDocumentRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationFailed([{ field: 'body', message: FINDING_MESSAGES.body }]);
  }
  const extra = Object.keys(body).filter((k) => k !== 'requestId' && k !== 'reason');
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { requestId, reason } = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  if (!isRequestId(requestId)) errors.push({ field: 'requestId', message: FINDING_MESSAGES.requestId });
  if (typeof reason !== 'string' || textLength(reason) === 0) errors.push({ field: 'reason', message: FINDING_MESSAGES.eventReason });
  else if (textLength(reason) > WITHDRAWAL_REASON_MAX) errors.push({ field: 'reason', message: FINDING_MESSAGES.tooLong(textLength(reason), WITHDRAWAL_REASON_MAX) });
  else if (NOT_STORABLE.test(reason)) errors.push({ field: 'reason', message: FINDING_MESSAGES.notStorable });
  if (errors.length > 0) throw new ValidationFailed(errors);
  return { requestId: requestId as string, reason: (reason as string).trim().normalize('NFC') };
}

/**
 * Route 19 (FR-DOC-06): withdraws an issued document with a reason. Only a `document_events` row is written; the document, its bytes and its
 * SHA-256 are untouched (NFR-INT-06). A document of another organisation or none is not found; a withdrawn one cannot be withdrawn again
 * (409 `already_withdrawn`, the first reason stays); an archived project refuses (409 `project_archived`). The check for an earlier event
 * and the insert are serialised per document by an advisory lock, because the append-only tables cannot be row-locked by the application role.
 */
export async function withdrawDocument(
  ctx: OrgContext, actor: Actor, a: WithdrawDocumentRequest & { documentId: string }, digest: string,
): Promise<WriteOutcome<IssuedDocumentView>> {
  assertCan(ctx, 'document:withdraw');
  const req = parseWithdrawDocumentRequest({ requestId: a.requestId, reason: a.reason });
  const viewOf = async (tx: TenantTx, documentId: string): Promise<IssuedDocumentView> => {
    const view = (await documentViews(tx, [documentId])).get(documentId);
    if (view === undefined) throw new Error(`documents: document ${documentId} has no view`);
    return view;
  };
  const out = await idempotentWrite<IssuedDocumentView>(ctx, {
    table: 'document_events', requestId: req.requestId, digest, actorUserId: actor.userId,
    // The request columns of document_events say which document the request was for; a replay answers that one, never the path's.
    replay: async (tx, rowId) => {
      const event = await tx.documentEvent.findUniqueOrThrow({ where: { id: rowId }, select: { documentId: true } });
      return viewOf(tx, event.documentId);
    },
    write: async (tx) => {
      const doc = await tx.issuedDocument.findUnique({ where: { id: a.documentId }, select: { id: true, projectId: true } });
      if (doc === null) throw new NotFoundError();
      await assertProjectWritable(tx, doc.projectId);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('makrai.document-withdrawal:' || ${doc.id}::text, 0))`;
      const earlier = await tx.documentEvent.count({ where: { documentId: doc.id, kind: 'withdrawn' } });
      if (earlier > 0) throw new ConflictError('already_withdrawn');
      await tx.documentEvent.create({
        data: { orgId: ctx.orgId, documentId: doc.id, kind: 'withdrawn', reason: req.reason, byId: actor.userId, requestId: req.requestId, requestDigest: digest },
      });
      return viewOf(tx, doc.id);
    },
  });
  if (!out.replayed) logSecurityEvent('DOCUMENT_WITHDRAWN', 'info', { details: { orgId: ctx.orgId, documentId: a.documentId } });
  return out;
}

/** FR-DOC-07's marking, the first line of every copy (SRS line 1055; the date as 7.5.8 prints it, in UTC). */
const textCopyMarking = (type: DocumentType, issuedAt: Date): string =>
  `Copy of the ${DOCUMENT_TITLES[type].toLowerCase()} issued on ${formatUtcDay(issuedAt.toISOString())}; the PDF is the issued version`;

/**
 * Route 18 (FR-DOC-07): the plain-text copy of an issued document, as the marking, a blank line, and the text stored at issue (never
 * regenerated). A missing or foreign document is not found; a copy the operator erased with the document's bytes answers 410 with the date.
 */
export async function readDocumentText(ctx: OrgContext, documentId: string): Promise<string> {
  const found = await withOrg(ctx, async (tx) => {
    const row = await tx.issuedDocument.findUnique({ where: { id: documentId }, select: { documentType: true, issuedAt: true, plainText: true } });
    if (row === null) return null;
    const erasedOn = row.plainText === null ? ((await documentViews(tx, [documentId])).get(documentId)?.erased?.erasedOn ?? null) : null;
    return { row, erasedOn };
  });
  if (found === null) throw new NotFoundError();
  if (found.row.plainText === null) {
    if (found.erasedOn === null) throw new Error(`documents: document ${documentId} has no text and no tombstone`);
    throw new ErasedError(found.erasedOn);
  }
  return `${textCopyMarking(found.row.documentType as DocumentType, found.row.issuedAt)}\n\n${found.row.plainText}`;
}
