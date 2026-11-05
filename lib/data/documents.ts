/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producers replace the file's bodies. */
import type { OrgRole, Prisma } from '@prisma/client';
import { NotFoundError, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, CalendarDate, DecisionVersionRow, DocumentType, OutsideRole, Stage, StoredDecisionStatus, ScopeAnswer, DeclaredPrecision, WithdrawalCode, WriteOutcome } from '@/types/record';
import { STAGES } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, DocumentPreview, EvidenceItemView, FindingEventView, FindingView, IssueDocumentRequest, IssuedDocumentView,
  MitigationVersionView, PreviewDocumentRequest, UserRef, WithdrawDocumentRequest,
} from '@/types/api';
import type { SealManifestV1 } from '@/types/seal';
import type { LoadedContent } from '@/types/content';
import { AppError, NotImplementedError, ValidationFailed } from '@/lib/http/errors';
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
            : { kind: 'outside_role', role: riskRow.acceptedByRole as OutsideRole };
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

/** Preview, issue, list, download, withdraw and plain text of issued documents (FR-DOC-01 to 08). Typed stubs until the producers merge. */

// CONTRACT_STUB: DOC-a
export async function previewDocument(
  ctx: OrgContext, actor: Actor, a: PreviewDocumentRequest & { projectId: string; reviewId: string },
): Promise<DocumentPreview> {
  throw new NotImplementedError('DOC-a');
}

// CONTRACT_STUB: DOC-a
export async function issueDocument(
  ctx: OrgContext, actor: Actor, a: IssueDocumentRequest & { projectId: string; reviewId: string }, digest: string,
): Promise<WriteOutcome<IssuedDocumentView>> {
  throw new NotImplementedError('DOC-a');
}

// CONTRACT_STUB: DOC-a
export async function listDocuments(
  ctx: OrgContext, filter: { projectId: string; reviewId?: string },
): Promise<IssuedDocumentView[]> {
  return [];
}

// CONTRACT_STUB: DOC-a
export async function readDocumentPdf(
  ctx: OrgContext, documentId: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  throw new NotImplementedError('DOC-a');
}

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
