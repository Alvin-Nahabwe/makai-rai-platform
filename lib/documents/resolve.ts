import type { OrgRole } from '@prisma/client';
import type { CalendarDate, DecisionVersionRow, DocumentType, Stage, UtcInstant } from '@/types/record';
import type {
  AcceptedRiskView, ContentRef, DeciderView, ErasedMark, EvidenceItemView, FindingEventView, FindingView, MitigationVersionView, UserRef,
} from '@/types/api';
import type { LoadedContent } from '@/types/content';
import type { SealManifestV1, SealRef } from '@/types/seal';

/**
 * Field resolution for the data card and the model card (FR-DOC-02, FR-DOC-03, FR-DOC-05; SRS 10.3.1). The copy below is
 * fixed by the SRS; the document tests import these constants rather than repeat the text.
 */

export const STATEMENT = 'Generated from this team\'s own records in the MAK-AI RAI Platform. Not an ethics approval, audit, certification or compliance statement.'; // FR-DOC-02, SRS line 1025
export const SEALED_NOTE = 'Sealed by the platform; not independently time-stamped.';   // 6.5, D8, R-56
export const NOT_RECORDED = 'Not recorded';                                           // FR-DOC-02, D1
export const NOT_RECORDED_AT_ISSUE = 'Not recorded at the time of issue';             // FR-DOC-05, D3
export const PROJECT_MARK = 'From the project description when this document was issued; not part of the sealed record'; // FR-DOC-02
export const TYPED_MARK = 'Typed for this document; not part of the sealed record';   // FR-DOC-03
export const NO_EVIDENCE = 'Evidence: none attached';                                 // FR-DOC-02, D9

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 7.5.8 "2 Nov 2026" from the UTC date of `iso`. A fixed month list: `Intl` prints "Sept" for September on this Node. */
export function formatUtcDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError('formatUtcDay: not a date');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** One decision version of a seal's manifest with the people, evidence and erasure marks of its row (contract G068, exact text). */
export interface SealedDecision {
  row: DecisionVersionRow; content: ContentRef; enteredBy: UserRef; decidedBy: DeciderView | null;
  evidence: EvidenceItemView[]; reasonErased: ErasedMark | null;
}
export interface SealedFinding {
  finding: FindingView; mitigations: MitigationVersionView[]; acceptedRisk: AcceptedRiskView | null; events: FindingEventView[];
}
export interface SealedStage {
  stage: Stage;
  seal: SealRef & { fingerprint: string; sealedAt: UtcInstant; sealedBy: UserRef; sealedByRole: OrgRole; enteredByPeople: number };
  preparedFor: string | null;
  manifest: SealManifestV1;
  decisions: ReadonlyMap<string, SealedDecision>;   // question id -> the sealed current version (manifest entries carrying an id)
  findings: readonly SealedFinding[];               // every finding of the manifest, its current mitigation versions and accepted risk
}
export interface DocumentSnapshot {
  documentType: DocumentType;
  reviewStage: Stage;
  chosen: SealedStage;
  stages: Readonly<Record<Stage, SealedStage | null>>;   // stages[reviewStage] is chosen; null: that stage was never sealed (D3)
  contents: ReadonlyMap<string, LoadedContent>;         // by contentVersionId, every version a sealed decision was answered against
  project: { name: string; description: string | null; metadata: Readonly<Record<string, string | null>> };
  organisationName: string;
  today: CalendarDate;                                  // eatDate(now) at the read (MP-02, MP-03 "overdue", DOC-b)
}
