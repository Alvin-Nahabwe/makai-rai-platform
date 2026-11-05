import type { OrgRole } from '@prisma/client';
import type {
  Stage, StoredDecisionStatus, DecisionStatus, ScopeAnswer, WithdrawalCode, OutsideRole, Decider,
  DeclaredDate, DeclaredPrecision, CalendarDate, UtcInstant, ReasonCode, EvidenceKind, FindingSource,
  FindingState, FindingEventKind, MitigationStatus, MitigationKind, DocumentType, InvitationKind,
  InvitationState, ActorRole, OrgEventAction, FieldError,
} from './record';
import type { SealRef } from './seal';
import type { LegalTextKind } from './legal';
// One definition: lib/legal/kinds.ts, which routes 30 and 31's guard (isAcceptancePairs) checks against. Type-only.
import type { AcceptancePair } from '../lib/legal/kinds';
export type { AcceptancePair };

export type UserRef = { userId: string; name: string; formerMember: boolean };
export type DeciderView = { kind: 'member'; user: UserRef } | { kind: 'outside_role'; role: OutsideRole };
export type ErasedMark = { erasedOn: CalendarDate };
export type ContentRef = { contentVersionId: string; semver: string; contentHash: string };

export interface EvidenceItemView {
  id: string; kind: EvidenceKind; fileName: string | null; mimeType: string | null; byteSize: number | null;
  sha256: string | null; url: string | null; label: string | null;
  uploadedBy: UserRef | null; uploadedAt: UtcInstant; erased: ErasedMark | null;
}
export interface DecisionVersionView {
  id: string; projectId: string; stage: Stage; questionId: string; versionNumber: number;
  baseVersionNumber: number | null; content: ContentRef; status: StoredDecisionStatus | null;
  scopeAnswer: ScopeAnswer | null; optionsInPlace: string[]; reasonCode: ReasonCode | null;
  reason: string | null; reasonErased: ErasedMark | null; decidedBy: DeciderView | null;
  declaredDate: DeclaredDate | null; declaredPrecision: DeclaredPrecision | null;
  withdrawalCode: WithdrawalCode | null; enteredBy: UserRef; enteredByRole: OrgRole;
  receivedAt: UtcInstant; evidence: EvidenceItemView[];
}
export interface SaveDecisionRequest {
  requestId: string; stage: Stage; questionId: string; baseVersionNumber: number | null;
  status: DecisionStatus | null; scopeAnswer: ScopeAnswer | null; optionsInPlace: string[];
  reasonCode: ReasonCode | null; reason: string; decidedBy: Decider; declaredDate: DeclaredDate;
  evidenceIds: string[];
}
export interface WithdrawDecisionRequest {
  requestId: string; stage: Stage; baseVersionNumber: number; withdrawalCode: WithdrawalCode; reason: string;
}
export interface CreateLinkEvidenceRequest { requestId: string; kind: 'link'; url: string; label: string | null }
/** A file upload is multipart/form-data with the text field `requestId` and the file field `file`. */

export interface MitigationVersionView {
  id: string; findingId: string; mitigationId: string; versionNumber: number; baseVersionNumber: number | null;
  what: string | null; changeNote: string | null; owner: UserRef; dueDate: CalendarDate;
  status: MitigationStatus; kind: MitigationKind; followsControl: string | null;
  closureNote: string | null; closureDecisionVersionId: string | null; cancelReason: string | null;
  enteredBy: UserRef; enteredByRole: OrgRole; findingSeq: number; receivedAt: UtcInstant;
  evidence: EvidenceItemView[]; erasedFields: string[];
}
export interface AcceptedRiskView {
  id: string; findingId: string; acceptedBy: DeciderView; accepterRole: OrgRole | null;
  reason: string | null; lookAgainNote: string | null; lookAgainOn: CalendarDate | null;
  enteredBy: UserRef; enteredByRole: OrgRole; findingSeq: number; receivedAt: UtcInstant; erasedFields: string[];
}
export interface FindingEventView {
  id: string; findingId: string; kind: FindingEventKind; eventCode: string | null; reason: string | null;
  by: UserRef; at: UtcInstant; findingSeq: number;
}
export interface FindingView {
  id: string; projectId: string; stage: Stage; source: FindingSource; questionId: string | null;
  decisionVersionId: string | null; riskArea: string | null; title: string | null; description: string | null;
  raisedBy: UserRef; raisedAt: UtcInstant; state: FindingState;
  openMitigations: number; hasNoMitigation: boolean;
  /** Gap G058: current mitigations planned or in progress whose due date is earlier than the caller's today. */
  overdueMitigations: number;
}
export interface FindingDetailView extends FindingView {
  mitigations: Array<{ mitigationId: string; current: MitigationVersionView; versions: number }>;
  acceptedRisk: AcceptedRiskView | null;
  /** Every accepted risk of the finding, newest first; earlier ones stay in its history after a reopen (FR-FND-07; gap G058). */
  acceptedRisks: AcceptedRiskView[];
  events: FindingEventView[];
  seals: SealRef[];
}
/** `ApiErrorBody.current` of 409 `finding_not_open` (7.4.4, SRS line 2435; gap G061). */
export interface FindingClosedConflict { state: FindingState; by: UserRef; at: UtcInstant }
export interface RaiseTeamFindingRequest {
  requestId: string; stage: Stage; title: string; description: string; riskArea: string | null;
  questionId: string | null; decisionVersionId: string | null;
}
export interface AddMitigationRequest {
  requestId: string; what: string; ownerUserId: string; dueDate: CalendarDate; status: MitigationStatus;
  followsControl: string | null; closureNote: string | null; cancelReason: string | null; evidenceIds: string[];
}
export interface UpdateMitigationRequest extends AddMitigationRequest { baseVersionNumber: number; changeNote: string | null }
export interface AcceptRiskRequest {
  requestId: string; mode: 'accept' | 'keep_accepted'; acceptedBy: Decider; reason: string;
  lookAgainOn: CalendarDate | null; lookAgainNote: string | null;
}
export interface FindingEventRequest { requestId: string; reason: string; eventCode: string | null }
export interface CloseByDecisionRequest { requestId: string; decisionVersionId: string }

export interface StageReviewView {
  id: string; projectId: string; stage: Stage; numberInStage: number; name: string;
  preparedFor: string | null; openedBy: UserRef; openedAt: UtcInstant;
  latestSeal: SealView | null; changedSinceLatestSeal: boolean;
  /** Gap G021: the change list behind `changedSinceLatestSeal`, and the erased note's mark. */
  changed: ChangedSinceSeal | null; preparedForErased: ErasedMark | null;
  /** C4 SF-1 ruling: the latest seal's bytes are no readable manifest of it (trustedManifest), whatever `bytesMatch` says. */
  latestSealUnreadable: boolean;
}
export interface OpenReviewRequest { requestId: string; stage: Stage; preparedFor: string | null }
export interface SealView {
  id: string; reviewId: string; sealNumber: number; fingerprint: string; sealedBy: UserRef;
  sealedByRole: OrgRole; sealedAt: UtcInstant; contentSemver: string;
  /** SHA-256 of the stored manifest bytes equals the stored fingerprint, checked on every read (NFR-INT-05; gap G015). */
  bytesMatch: boolean;
}
export interface SealRequest { requestId: string }
export interface ChangedSinceSeal {
  sealNumber: number;
  changedQuestions: string[];
  changedFindings: string[];
}

export interface TypedFieldValue { fieldId: string; value: string | null; salt: string | null }
export interface DocumentPreview {
  documentType: DocumentType; sealId: string; text: string;
  notRecordedFields: string[]; typedFields: string[];
}
export interface PreviewDocumentRequest { documentType: DocumentType; sealId: string; typedFields: Record<string, string> }
export interface IssueDocumentRequest extends PreviewDocumentRequest { requestId: string }
export interface IssuedDocumentView {
  id: string; projectId: string; reviewId: string; documentType: DocumentType; sha256: string;
  /** seals[0] is the seal the document was generated from (issued_documents.sealId); the rest follow in STAGES order (gap G069). */
  byteSize: number; issuedBy: UserRef; issuedAt: UtcInstant; seals: Array<SealRef & { fingerprint: string }>;
  withdrawn: { on: CalendarDate; reason: string } | null; erased: ErasedMark | null;
}
export interface WithdrawDocumentRequest { requestId: string; reason: string }

export interface FollowUpItem {
  mitigationId: string; versionId: string; findingId: string; projectId: string; stage: Stage;
  what: string | null; owner: UserRef; dueDate: CalendarDate; status: 'planned' | 'in_progress';
  overdue: boolean; ownerCanAct: boolean;
}
export interface StageCounts {
  questions: number; noDecision: number; byStatus: Record<DecisionStatus, number>;
  doneWithoutEvidence: number; openFindings: number; openFindingsWithoutMitigation: number;
  openMitigations: number; overdueMitigations: number; acceptedRisks: number;
  documentsIssued: number; notApplicableByGate: number;
}

export interface MemberView { userId: string; name: string; role: OrgRole; joinedAt: UtcInstant; createdFromShownLink: boolean }
export interface InvitationView {
  id: string; email: string; role: OrgRole; kind: InvitationKind; state: InvitationState;
  expiresAt: UtcInstant; createdAt: UtcInstant; linkShown: boolean;
  /** Set by ORG's organisationForAdmin for an accepted first-owner invitation (FR-ACC-10 on S-24; gap G005). */
  createdFromShownLink?: boolean;
}
export interface InviteMemberRequest { requestId: string; email: string; role: OrgRole; showLink: boolean }
export interface InviteMemberResponse { invitation: InvitationView; acceptUrl: string | null; emailSent: boolean }
export interface ResendInvitationRequest { requestId: string; showLink: boolean }
export interface ChangeRoleRequest { requestId: string; role: OrgRole }
/** The body of a write that carries nothing else (rows 21, 22, 24 DELETE, 26 DELETE, 27, 29; owner answer A1). */
export interface RequestIdBody { requestId: string }

export interface AgreementInput {
  agreementVersion: string; textHash: string; acceptedOn: CalendarDate; controllerLegalName: string; dpContactEmail: string;
}
export interface AgreementView extends AgreementInput { id: string; recordedAt: UtcInstant }
export interface OrgEventView {
  id: string; actorName: string; actorRole: ActorRole; action: OrgEventAction; targetName: string | null;
  reason: string | null; requestReference: string | null; previousValue: string | null; at: UtcInstant;
}
export interface CreateOrganisationRequest { requestId: string; name: string; agreement: AgreementInput; ownerEmail: string; showLink: boolean }
export interface CreateOrganisationResponse { orgId: string; slug: string; invitation: InvitationView; acceptUrl: string | null; emailSent: boolean }
export interface IssueOwnerInvitationRequest { email: string; requestReference: string; showLink: boolean }
export interface CorrectOrgNameRequest { name: string }
/**
 * Route 47 stays a form POST (finding F10): the fields `request.formData()` carries. `active` is the state the
 * pressed button names (Deactivate sends false, Reactivate true), never a toggle, so a repeated submit is a no-op;
 * `requestId` is the form's request id, logged with the change (controller ruling on ORG-1, route 47).
 */
export interface AdminUserForm { active: boolean | null; requestId: string | null; role: 'admin' | 'assessor' | null; requestReference: string | null }
export interface AdminOrganisationRow {
  orgId: string; name: string; createdAt: UtcInstant; currentAgreementVersion: string | null;
  memberCount: number; ownerInvitationState: InvitationState | null; hasActiveOwner: boolean; archived: boolean;
}

/** Route 30's body: each kind with the version the page showed (a version no longer current is a 409 legal_text_changed). */
export interface AcceptancesRequest { acceptances: AcceptancePair[] }
export interface PasswordResetRequest { email: string }
export interface PasswordResetCompleteRequest { token: string; newPassword: string }
export interface PreferencesRequest { reminderEmails: boolean }

/** FR-EXP-02, 6.4 (SRS lines 1079, 1420); gap G067. passwordHash and tokenHash values are the string 'withheld'. */
export type PersonalItemType = 'decision_version' | 'evidence' | 'finding' | 'finding_event' | 'mitigation_version'
  | 'accepted_risk' | 'stage_review' | 'seal' | 'issued_document' | 'document_event'
  // C4 EXP-1 SC-1 (NFR-PRIV-08): every other allow-list table that names a person.
  | 'project' | 'document_draft_field' | 'organisation_event' | 'request_receipt' | 'invitation' | 'organisation_agreement'
  | 'platform_event';
/**
 * One row that names the person. `kind` is the row's kind or action where the table has one (a draft's document type,
 * an event's action, a receipt's route, an invitation's kind, an agreement's version). `own` holds the row's fields
 * that are the person's own (an invitation to their address). No other person's id or address is ever included. A
 * platform_event belongs to no organisation: its orgId and organisation are null.
 */
export interface PersonalExportItem {
  orgId: string | null; organisation: string | null; type: PersonalItemType; id: string; date: UtcInstant;
  roles: Array<'entered' | 'decided' | 'owns' | 'accepted' | 'acted' | 'named' | 'invited'>;
  kind?: string;
  own?: Record<string, string | null>;
}
export interface PersonalExport {
  format: 'makrai.personal-export/1'; exportedAt: UtcInstant;
  account: Record<string, string | number | boolean | null>;
  memberships: Array<{ orgId: string; organisation: string; role: OrgRole; joinedAt: UtcInstant }>;
  acceptances: Array<Record<string, string | boolean | null>>;
  signIn: { knownDevices: Array<Record<string, string | number | null>>; passwordResets: Array<Record<string, string | null>> };
  items: PersonalExportItem[];
}

export interface ApiErrorBody {
  error: string;
  code: string;
  fields?: FieldError[];
  current?: unknown;
  retryAfterSeconds?: number;
  missing?: LegalTextKind[];
  erasedOn?: CalendarDate;
  organisation?: string;
  unit?: string;
  /** 8 lowercase hex characters on every body with status 500 or more; the same value is in the REQUEST_FAILED log line (NFR-OBS-05; gap G044). */
  reference?: string;
  /** Only on the 500 that `toResponse` gives an error nothing maps (contract round 19, R19-5); AppError's `extra` leaves it out, so no thrower sets it. */
  message?: string;
}
