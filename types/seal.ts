import type { OrgRole } from '@prisma/client';
import type {
  Stage, StoredDecisionStatus, ScopeAnswer, OutsideRole, DeclaredPrecision, DeclaredDate, UtcInstant,
  CalendarDate, EvidenceKind, FindingSource, FindingState, FindingEventKind, MitigationStatus, MitigationKind,
} from './record';

export type SaltedDigest = { d: string };
export type ManifestContent = { semver: string; contentHash: string };
export type ManifestDecider = { userId: string | null; outsideRole: OutsideRole | null };
export interface ManifestEvidence {
  id: string; kind: EvidenceKind; sha256: string | null;
  fileName: SaltedDigest | null; url: SaltedDigest | null; label: SaltedDigest | null;
}
export type ManifestDecision =
  | { question: string; none: true; withdrawal: string | null }
  | { question: string; derived: 'not_applicable_gate'; from: string; content: ManifestContent }
  | {
      question: string; id: string; number: number; content: ManifestContent;
      status: StoredDecisionStatus | null; scopeAnswer: ScopeAnswer | null; optionsInPlace: string[];
      decidedBy: ManifestDecider; declaredDate: DeclaredDate; declaredPrecision: DeclaredPrecision;
      reasonCode: string | null; enteredBy: string; enteredByRole: OrgRole; receivedAt: UtcInstant;
      reason: SaltedDigest | null; evidence: ManifestEvidence[];
    };
export interface ManifestFindingEvent { id: string; kind: FindingEventKind; findingSeq: number; by: string; reason: SaltedDigest | null }
export interface ManifestMitigation {
  versionId: string; mitigationId: string; number: number; findingSeq: number;
  kind: MitigationKind; status: MitigationStatus; owner: string; dueDate: CalendarDate;
  followsControl: string | null; what: SaltedDigest | null; changeNote: SaltedDigest | null;
  closureNote: SaltedDigest | null; cancelReason: SaltedDigest | null;
  enteredBy: string; enteredByRole: OrgRole; evidence: ManifestEvidence[];
}
export interface ManifestAcceptedRisk {
  id: string; findingSeq: number; acceptedBy: ManifestDecider; accepterRole: OrgRole | null;
  enteredBy: string; enteredByRole: OrgRole; reason: SaltedDigest | null;
  lookAgainNote: SaltedDigest | null; lookAgainDate: CalendarDate | null;
}
export interface ManifestFinding {
  id: string; source: FindingSource; question: string | null; decisionVersion: string | null;
  riskArea: string | null; title: SaltedDigest | null; description: SaltedDigest | null;
  state: FindingState; events: ManifestFindingEvent[]; mitigations: ManifestMitigation[];
  acceptedRisk: ManifestAcceptedRisk | null;
}
export interface SealManifestV1 {
  format: 'makrai.seal/1';
  seal: {
    id: string; number: number; stageReviewId: string; stage: Stage; preparedFor: SaltedDigest | null;
    sealedBy: string; sealedByRole: OrgRole; sealedAt: UtcInstant;
  };
  project: string;
  organisation: string;
  content: ManifestContent;
  decisions: ManifestDecision[];
  findings: ManifestFinding[];
}
export type SealCheckResult =
  | { kind: 'valid'; erasedFields: number; erasedFiles: number; erasedOn: CalendarDate | null; clockWarnings: string[] }
  | { kind: 'mismatch'; firstDifference: string }
  | { kind: 'fingerprint_mismatch' };
export interface SealRef { sealId: string; sealNumber: number; reviewId: string; reviewName: string }
