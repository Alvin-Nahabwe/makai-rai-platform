import type { OrgRole } from '@prisma/client';

export type Stage = 'pre-processing' | 'in-processing' | 'post-processing';
export const STAGES: readonly Stage[] = ['pre-processing', 'in-processing', 'post-processing'];

export type DecisionStatus = 'done' | 'partly' | 'not_yet' | 'not_applicable';
export type StoredDecisionStatus = DecisionStatus | 'withdrawn';
export type ScopeAnswer = 'yes' | 'no' | 'not_sure';
export type WithdrawalCode = 'entered_in_error' | 'wrong_project' | 'duplicate' | 'test_entry';
export type OutsideRole =
  | 'principal_investigator'
  | 'supervisor'
  | 'ethics_committee'
  | 'data_access_committee'
  | 'institutional_dpo'
  | 'funder'
  | 'other';
export const OUTSIDE_ROLES: readonly OutsideRole[] = [
  'principal_investigator', 'supervisor', 'ethics_committee', 'data_access_committee',
  'institutional_dpo', 'funder', 'other',
];
export type DeclaredPrecision = 'day' | 'month' | 'year';
/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD'; the precision is the length (W-3 note 7, SRS line 1909). */
export type DeclaredDate = string;
/** 'YYYY-MM-DD'. */
export type CalendarDate = string;
/** 'YYYY-MM-DDTHH:MM:SS.sssZ' (SRS line 1276). */
export type UtcInstant = string;
export type Decider = { kind: 'member'; userId: string } | { kind: 'outside_role'; role: OutsideRole };
export type ReasonCode = `na_${string}` | `ny_${string}`;

export type EvidenceKind = 'file' | 'link';
export type FindingSource = 'shortfall' | 'team';
export type FindingState = 'open' | 'closed_mitigation' | 'closed_accepted_risk' | 'withdrawn';
export type FindingEventKind = 'reopened' | 'withdrawn';
export type MitigationStatus = 'planned' | 'in_progress' | 'done' | 'cancelled';
export type MitigationKind = 'action' | 'decision_changed' | 'decision_withdrawn';
export type DocumentType = 'data_card' | 'model_card' | 'mitigation_plan';
/** S-18 order, FR-DOC-01 (SRS line 1019). */
export const DOCUMENT_TYPES: readonly DocumentType[] = ['data_card', 'model_card', 'mitigation_plan'];
export type ReminderKind = 'due' | 'overdue';
export type ReminderOutcome = 'claimed' | 'sent' | 'failed' | 'opted_out';
export type InvitationKind = 'member' | 'first_owner';
export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';
export type ActorRole = OrgRole | 'platform_admin';
export type OrgEventAction =
  | 'organisation_created' | 'agreement_recorded' | 'owner_invitation_issued'
  | 'owner_invitation_resent' | 'owner_invitation_revoked' | 'organisation_name_corrected'
  | 'organisation_legal_name_corrected'
  | 'account_deactivated' | 'account_reactivated'
  | 'member_invited' | 'member_joined' | 'member_role_changed' | 'member_removed' | 'member_left';
export type PlatformEventAction = 'account_deactivated' | 'account_reactivated';

/** The signed-in member acting in the organisation of the OrgContext. */
export type Actor = { userId: string; role: OrgRole };
export type FieldError = { field: string; message: string };
/** `replayed` is true when the request id was seen before with the same account and digest (5.3 item 4). */
export type WriteOutcome<T> = { replayed: boolean; value: T };

/** One `decision_versions` row as services read it, plus its evidence ids (the `DecisionVersion` model's columns). */
export interface DecisionVersionRow {
  id: string; orgId: string; projectId: string; stage: Stage; questionId: string; contentVersionId: string;
  versionNumber: number; baseVersionNumber: number | null; status: StoredDecisionStatus | null;
  scopeAnswer: ScopeAnswer | null; optionsInPlace: string[]; reasonCode: string | null; reason: string | null;
  reasonSalt: Uint8Array | null; decidedByUserId: string | null; decidedByRole: OutsideRole | null;
  declaredOn: Date | null; declaredPrecision: DeclaredPrecision | null; withdrawalCode: WithdrawalCode | null;
  enteredById: string; enteredByRole: OrgRole; receivedAt: Date; requestId: string; requestDigest: string;
  evidenceIds: string[];
}
