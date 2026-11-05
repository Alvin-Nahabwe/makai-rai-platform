/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producers replace the file's bodies. */
import type { OrgRole, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { assertCan, NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, DecisionVersionRow, DocumentType, FieldError, OutsideRole, Stage, StoredDecisionStatus, ScopeAnswer, DeclaredPrecision, WithdrawalCode, WriteOutcome } from '@/types/record';
import { DOCUMENT_TYPES, STAGES } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, DocumentPreview, EvidenceItemView, FindingEventView, FindingView, IssuedDocumentView,
  MitigationVersionView, PreviewDocumentRequest, TypedFieldValue, UserRef, WithdrawDocumentRequest,
} from '@/types/api';
import type { FieldMap } from '@/types/documents';
import type { SealManifestV1 } from '@/types/seal';
import type { LoadedContent } from '@/types/content';
import { AppError, ErasedError, NotImplementedError, ValidationFailed } from '@/lib/http/errors';
import { idempotentWrite, isRequestId } from '@/lib/data/idempotency';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { isSerializationFailure, isUniqueViolation, uniqueViolationIndex } from '@/lib/data/pgErrors';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { RENDERERS, type RenderInput, type Renderer } from '@/lib/documents/render';
import { ethicsFieldIds, resolveFields } from '@/lib/documents/resolve';
import { contentRefById } from '@/lib/data/framework';
import { erasedFields, evidenceViews, userRefs } from '@/lib/data/views';
import { loadContent } from '@/lib/content/loader';
import { logSecurityEvent } from '@/lib/security-logger';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { manifestIds } from '@/lib/seal/ids';
import { stageReviewName } from '@/lib/seal/reviewName';
import { trustedManifest } from '@/lib/integrity/sealCheck.mjs';
import type { DocumentSnapshot, SealedDecision, SealedFinding, SealedStage } from '@/lib/documents/resolve';

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

/** The rows one seal's manifest names, as stored (nothing saved after the seal is read: the ids come from the manifest). */
interface RawStage {
  seal: SealRow; manifest: SealManifestV1;
  decisions: DecisionRow[]; findings: FindingRow[]; events: EventRow[]; mitigations: MitigationRow[]; risks: RiskRow[];
}

/** The `ProjectMetadata` columns a document can print, in schema order (ids and `updatedAt` are not fields). */
const METADATA_KEYS = [
  'aiSystemType', 'aiSystemTypeOther', 'institution', 'department', 'country', 'developmentStage', 'deploymentSector', 'deploymentSectorOther',
  'targetPopulation', 'processesPersonalData', 'datasetSize', 'datasetType', 'datasetTypeOther', 'datasetDescription', 'teamSize',
  'fundingSource', 'regulatoryContext', 'projectStart', 'projectEnd',
] as const;

/** A boolean as 'true' or 'false', an enum as its name, a number in decimal, a date as YYYY-MM-DD; null stays null (contract G068). */
function metadataText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return day(v);
  return String(v);
}

/** The id the 500 `integrity_failure` of a seal that cannot vouch for itself carries in the log, never in the answer. */
function sealIntegrityFailure(sealId: string, kind: 'mismatch' | 'fingerprint_mismatch'): void {
  logSecurityEvent('SEAL_CHECK_FAILED', 'warn', { details: { sealId, kind } });
}

/** A seal whose stored bytes vouch for it (fingerprint, a readable manifest that names this seal), else null (NFR-INT-05). */
function trusted(seal: SealRow): SealManifestV1 | null {
  const gate = trustedManifest({ sealId: seal.id, manifestBytes: seal.manifest, fingerprint: seal.fingerprint });
  if (gate.kind === 'trusted') return gate.manifest;
  sealIntegrityFailure(seal.id, gate.kind);
  return null;
}

async function readRawStage(tx: TenantTx, seal: SealRow, manifest: SealManifestV1): Promise<RawStage> {
  const ids = manifestIds(manifest);
  const decisionIds = manifest.decisions.flatMap((d) => ('id' in d ? [d.id] : []));
  const [decisions, findings, events, mitigations, risks] = [
    await tx.decisionVersion.findMany({ where: { id: { in: decisionIds } }, select: DECISION_SELECT }),
    await tx.finding.findMany({ where: { id: { in: [...ids.findings] } }, select: FINDING_SELECT }),
    await tx.findingEvent.findMany({ where: { id: { in: [...ids.findingEvents] } }, select: EVENT_SELECT, orderBy: { findingSeq: 'asc' } }),
    await tx.mitigationVersion.findMany({ where: { id: { in: [...ids.mitigationVersions] } }, select: MITIGATION_SELECT, orderBy: { findingSeq: 'asc' } }),
    await tx.acceptedRisk.findMany({ where: { id: { in: [...ids.acceptedRisks] } }, select: RISK_SELECT }),
  ];
  // A sealed id with no row is a broken database, not a user's mistake: ids only in the message (NFR-PRIV-03).
  if (decisions.length !== decisionIds.length) throw new Error(`documents: seal ${seal.id} names decision versions that have no row`);
  if (findings.length !== ids.findings.length) throw new Error(`documents: seal ${seal.id} names findings that have no row`);
  if (events.length !== ids.findingEvents.length || mitigations.length !== ids.mitigationVersions.length || risks.length !== ids.acceptedRisks.length) {
    throw new Error(`documents: seal ${seal.id} names events, mitigation versions or accepted risks that have no row`);
  }
  return { seal, manifest, decisions, findings, events, mitigations, risks };
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
): Promise<DocumentSnapshot> {
  const review = await tx.stageReview.findFirst({ where: { id: a.reviewId, projectId: a.projectId }, select: { id: true, stage: true } });
  if (review === null) throw new NotFoundError();
  const chosenRow = await tx.seal.findFirst({ where: { id: a.sealId }, select: SEAL_SELECT });
  if (chosenRow === null) throw new NotFoundError();
  if (chosenRow.stageReviewId !== review.id || chosenRow.stageReview.projectId !== a.projectId) {
    throw new ValidationFailed([{ field: 'sealId', message: 'This seal is not from this review.' }]);
  }
  const chosenManifest = trusted(chosenRow);
  if (chosenManifest === null) throw new ValidationFailed([{ field: 'sealId', message: 'This seal cannot be used: its check failed.' }]);
  const reviewStage = chosenRow.stageReview.stage as Stage;

  const sealed = new Map<Stage, { row: SealRow; manifest: SealManifestV1 }>([[reviewStage, { row: chosenRow, manifest: chosenManifest }]]);
  for (const stage of STAGES) {
    if (stage === reviewStage) continue;
    const row = await tx.seal.findFirst({
      where: { stageReview: { projectId: a.projectId, stage } }, orderBy: [{ sealedAt: 'desc' }, { sealNumber: 'desc' }], select: SEAL_SELECT,
    });
    if (row === null) continue;
    const manifest = trusted(row);
    // Skipping it would print "Not recorded at the time of issue" for a stage that was sealed (D3): a false statement on a document that cannot be recalled.
    if (manifest === null) throw new AppError(500, 'integrity_failure', 'Document integrity check failed');
    sealed.set(stage, { row, manifest });
  }

  await hooks?.afterSeals?.(tx);

  const raw = new Map<Stage, RawStage>();
  for (const [stage, s] of sealed) raw.set(stage, await readRawStage(tx, s.row, s.manifest));

  // Lookups for every stage at once.
  const all = [...raw.values()];
  const people = all.flatMap((r) => [
    r.seal.sealedById,
    ...r.decisions.flatMap((d) => (d.decidedByUserId === null ? [d.enteredById] : [d.enteredById, d.decidedByUserId])),
    ...r.findings.map((f) => f.raisedById), ...r.events.map((e) => e.byId),
    ...r.mitigations.flatMap((m) => [m.ownerUserId, m.enteredById]),
    ...r.risks.flatMap((x) => (x.acceptedByUserId === null ? [x.enteredById] : [x.enteredById, x.acceptedByUserId])),
  ]);
  const evidenceIds = all.flatMap((r) => [...r.decisions.flatMap((d) => d.evidence.map((e) => e.evidenceId)), ...r.mitigations.flatMap((m) => m.evidence.map((e) => e.evidenceId))]);
  const [refs, evidence, erasedDecisions, erasedMitigations, erasedRisks, erasedReviews] = [
    await userRefs(tx, people),
    await evidenceViews(tx, evidenceIds),
    await erasedFields(tx, 'decision_versions', all.flatMap((r) => r.decisions.map((d) => d.id))),
    await erasedFields(tx, 'mitigation_versions', all.flatMap((r) => r.mitigations.map((m) => m.id))),
    await erasedFields(tx, 'accepted_risks', all.flatMap((r) => r.risks.map((x) => x.id))),
    await erasedFields(tx, 'stage_reviews', all.map((r) => r.seal.stageReview.id)),
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

  const today = eatDate(new Date());
  const stages: Record<Stage, SealedStage | null> = { 'pre-processing': null, 'in-processing': null, 'post-processing': null };
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

    const review = r.seal.stageReview;
    const erasedNote = erasedReviews.get(review.id)?.fields.includes('preparedFor') === true;
    stages[stage] = {
      stage,
      seal: {
        sealId: r.seal.id, sealNumber: r.seal.sealNumber, reviewId: review.id, reviewName: stageReviewName(stage, review.numberInStage),
        fingerprint: r.seal.fingerprint, sealedAt: r.seal.sealedAt.toISOString(), sealedBy: person(r.seal.id, r.seal.sealedById),
        sealedByRole: r.seal.sealedByRole, enteredByPeople: new Set([...decisions.values()].map((d) => d.row.enteredById)).size,
      },
      preparedFor: erasedNote ? null : review.preparedFor,
      manifest: r.manifest, decisions, findings,
    };
  }

  const project = await tx.project.findFirst({ where: { id: a.projectId }, select: { name: true, description: true } });
  if (project === null) throw new NotFoundError();
  const meta = await tx.projectMetadata.findFirst({ where: { projectId: a.projectId } });
  const metadata = Object.fromEntries(METADATA_KEYS.map((k) => [k, metadataText(meta === null ? null : (meta as Record<string, unknown>)[k])]));
  const [{ name: organisationName }] = await tx.$queryRaw<{ name: string }[]>`
    SELECT "name" FROM "organizations" WHERE "id" = NULLIF(current_setting('app.current_org_id', true), '')`;

  return {
    documentType: a.documentType, reviewStage, chosen: stages[reviewStage] as SealedStage, stages, contents, project: { ...project, metadata },
    organisationName, today,
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
  const erasures = gone.length === 0 ? [] : await tx.$queryRaw<{ id: string; erasedOn: CalendarDate }[]>`
    SELECT x."id", to_char(max(x."at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS "erasedOn" FROM (
      SELECT t."targetId" AS "id", t."at" FROM "tombstones" t
      WHERE t."targetTable" = 'issued_documents' AND t."targetId" = ANY (${gone.map((g) => g.id)}::text[])
      UNION ALL
      SELECT s."documentId" AS "id", t."at" FROM "issued_document_sources" s
      JOIN "tombstones" t ON t."targetTable" = s."sourceTable" AND t."targetId" = s."sourceId" AND t."field" IS NOT DISTINCT FROM s."field"
      WHERE s."documentId" = ANY (${gone.map((g) => g.id)}::text[])
    ) x GROUP BY x."id"`;
  const erasedOn = new Map(erasures.map((e) => [e.id, e.erasedOn]));
  const events = await tx.documentEvent.findMany({ where: { documentId: { in: wanted }, kind: 'withdrawn' }, orderBy: { at: 'asc' }, select: { documentId: true, reason: true, at: true } });
  const refs = await userRefs(tx, rows.map((r) => r.issuedById));
  const out = new Map<string, IssuedDocumentView>();
  for (const r of rows) {
    const issuedBy = refs.get(r.issuedById);
    if (issuedBy === undefined) throw new Error(`documents: document ${r.id} names user ${r.issuedById}, which has no account row`);
    const home = sealOf.get(r.sealId);
    if (home === undefined) throw new Error(`documents: document ${r.id} names a seal that has no row`);
    const others = r.seals.map((s) => sealOf.get(s.sealId)).filter((s): s is NonNullable<typeof s> => s !== undefined && s.sealId !== r.sealId)
      .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
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
    throw new ValidationFailed([{ field: 'body', message: 'The body must be a JSON object.' }]);
  }
  const known = keyed ? ['documentType', 'sealId', 'typedFields', 'requestId'] : ['documentType', 'sealId', 'typedFields'];
  const extra = Object.keys(body).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new ValidationFailed(extra.map((field) => ({ field, message: 'This field cannot be sent.' })));
  const { documentType, sealId, typedFields, requestId } = body as Record<string, unknown>;
  if (keyed && !isRequestId(requestId)) throw new ValidationFailed([{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }]);
  if (typeof sealId !== 'string' || sealId === '') throw new ValidationFailed([{ field: 'sealId', message: 'Choose a seal.' }]);
  return {
    documentType: documentType as PreviewDocumentRequest['documentType'], sealId,
    typedFields: (typedFields === undefined ? {} : typedFields) as Record<string, string>,
    ...(keyed ? { requestId: requestId as string } : {}),
  };
}

// ─── Preview and issue ───────────────────────────────────────────────────────────────────────────

/** "A value over its length limit" (D5): each typed value is at most this many characters. */
export const TYPED_VALUE_MAX = 2000;
const ETHICS_STATES: readonly string[] = ['approved', 'submitted', 'not_required'];

const typedKeys = (map: FieldMap): ReadonlySet<string> => new Set(map.fields.flatMap((e) =>
  e.sources.some((s) => s.kind === 'typed' && s.structured === 'ethics_approval') ? ethicsFieldIds(e.fieldId)
    : e.typedAddition || e.sources.some((s) => s.kind === 'typed') ? [e.fieldId] : []));

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
    if (!allowed.has(id)) errors.push({ field, message: 'This is not a field you can type into for this document.' });
    else if (typeof value !== 'string') errors.push({ field, message: 'This must be text.' });
    else if (value.length > TYPED_VALUE_MAX) errors.push({ field, message: `Use at most ${TYPED_VALUE_MAX} characters.` });
    else if (id.endsWith(':state') && value.trim() !== '' && !ETHICS_STATES.includes(value.trim())) errors.push({ field, message: 'Choose approved, submitted or not required.' });
    else if (value.trim() !== '') kept[id] = value;
  }
  if (errors.length > 0) throw new ValidationFailed(errors);
  return Object.fromEntries(Object.entries(kept).sort(([a], [b]) => a.localeCompare(b)));
}

function checkType(documentType: unknown): DocumentType {
  if (typeof documentType !== 'string' || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw new ValidationFailed([{ field: 'documentType', message: 'Choose a data card, a model card or a mitigation plan.' }]);
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
async function readForDocument(ctx: OrgContext, a: DocumentRequest): Promise<{ snap: DocumentSnapshot; issuedAt: Date }> {
  const attempt = () => withOrg(ctx, async (tx) => {
    await assertProjectWritable(tx, a.projectId);
    const snap = await readDocumentSnapshot(tx, a);
    const [{ at }] = await tx.$queryRaw<{ at: Date }[]>`SELECT date_trunc('second', clock_timestamp()) AS at`;
    return { snap, issuedAt: at };
  }, { isolationLevel: 'RepeatableRead', timeoutMs: READ_TIMEOUT_MS });
  try {
    return await attempt();
  } catch (e) {
    if (!isSerializationFailure(e)) throw e;
    return attempt();
  }
}
/** Prisma's interactive-transaction default is 5 s; the snapshot of a large review reads more rows than that allows on a slow disk. */
const READ_TIMEOUT_MS = 15_000;

const sealsOf = (snap: DocumentSnapshot, ids: readonly string[]): RenderInput['seals'] => ids.flatMap((id) => {
  const stage = STAGES.map((s) => snap.stages[s]).find((s) => s?.seal.sealId === id);
  return stage === undefined || stage === null ? [] : [{ sealId: id, sealNumber: stage.seal.sealNumber, reviewId: stage.seal.reviewId, reviewName: stage.seal.reviewName, fingerprint: stage.seal.fingerprint }];
});

/** Resolves and renders outside every transaction (NFR-PERF-04: CPU in the one Node process). */
async function build(type: DocumentType, renderer: Renderer, snap: DocumentSnapshot, typed: Record<string, string>, issuedAt: Date) {
  const map = loadFieldMap(type);
  const resolved = resolveFields(map, snap, typed);
  const input: RenderInput = {
    map, fields: resolved.fields, seals: sealsOf(snap, resolved.sealIds), issuedAt: issuedAt.toISOString(),
    organisationName: snap.organisationName, projectName: snap.project.name,
  };
  return { map, resolved, rendered: await renderer(input) };
}

function rendererFor(type: DocumentType): Renderer {
  const renderer = RENDERERS[type];
  if (renderer === null) throw new NotImplementedError('DOC-b');
  return renderer;
}

/** FR-DOC-08: the full text as it will print, with the fields that read "Not recorded" and the typed ones; nothing is stored. */
export async function previewDocument(ctx: OrgContext, actor: Actor, a: DocumentRequest): Promise<DocumentPreview> {
  assertCan(ctx, 'document:generate');
  const type = checkType(a.documentType);
  const renderer = rendererFor(type);
  const typed = checkTyped(loadFieldMap(type), a.typedFields);
  const { snap, issuedAt } = await readForDocument(ctx, { ...a, documentType: type });
  const { resolved, rendered } = await build(type, renderer, snap, typed, issuedAt);
  return { documentType: type, sealId: a.sealId, text: rendered.plainText, notRecordedFields: resolved.notRecordedFields, typedFields: resolved.typedFieldIds };
}

const SECOND_KEY = 'issued_documents_second_key';
const MAX_SECOND_RETRIES = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Waits until the database's second is later than `last` (FR-DOC-04: a second issue in the same second waits for the next one). */
async function waitPast(ctx: OrgContext, last: Date): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const [{ ok }] = await withOrg(ctx, (tx) => tx.$queryRaw<{ ok: boolean }[]>`SELECT date_trunc('second', clock_timestamp()) > ${last}::timestamptz AS ok`);
    if (ok) return;
    await sleep(50);
  }
  throw new Error('documents: the database clock did not reach the next second');
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
  const renderer = rendererFor(type);
  const typed = checkTyped(loadFieldMap(type), a.typedFields);

  const replay = (tx: TenantTx, rowId: string) => documentViews(tx, [rowId]).then((m) => m.get(rowId) as IssuedDocumentView);
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
  for (let retry = 0; ; retry += 1) {
    if (last !== null) await waitPast(ctx, last);
    const { snap, issuedAt } = await readForDocument(ctx, { ...a, documentType: type });
    const { map, resolved, rendered } = await build(type, renderer, snap, typed, issuedAt);
    const sha256 = createHash('sha256').update(rendered.pdf).digest('hex');
    try {
      const out = await idempotentWrite<IssuedDocumentView>(ctx, {
        table: 'issued_documents', requestId: a.requestId, digest, actorUserId: actor.userId, replay,
        write: async (tx) => {
          await assertProjectWritable(tx, a.projectId);
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
      if (retry < MAX_SECOND_RETRIES && isUniqueViolation(e) && uniqueViolationIndex(e) === SECOND_KEY) { last = issuedAt; continue; }
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
    throw new AppError(500, 'integrity_failure', 'Document integrity check failed');
  }
  return { bytes, fileName: `${FILE_PREFIX[found.row.documentType as DocumentType]}-${day(found.row.issuedAt)}-${documentId.slice(0, 8)}.pdf` };
}

/** Withdraw and plain text of issued documents (DOC-b). Typed stubs until it merges. */

// CONTRACT_STUB: DOC-b
export async function withdrawDocument(
  ctx: OrgContext, actor: Actor, a: WithdrawDocumentRequest & { documentId: string }, digest: string,
): Promise<WriteOutcome<IssuedDocumentView>> {
  throw new NotImplementedError('DOC-b');
}

// CONTRACT_STUB: DOC-b
export async function readDocumentText(ctx: OrgContext, documentId: string): Promise<string> {
  throw new NotImplementedError('DOC-b');
}
