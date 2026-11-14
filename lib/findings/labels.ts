import type { AcceptedRiskView, FindingView } from '@/types/api';
import type { CalendarDate, FindingState, Stage, StoredDecisionStatus } from '@/types/record';
import { deciderLabel, STATUS_OPTIONS } from '@/lib/decision/copy';
import { formatDay } from '@/lib/format/dates';
import { FINDINGS_COPY } from '@/lib/findings/copy';

/**
 * The labels of the findings screens (SRS 7.5.6 line 2529 to 2532, 7.5.8), built from the words of `FINDINGS_COPY`
 * (lib/findings/copy.ts). Plain constants and functions with no imports from the server, so a client component can
 * import this module. The mitigation status words ("Planned", "In progress", "Done", "Cancelled") are not here: they stay
 * in `components/findings/MitigationForm.tsx` (`MitigationStatusWord`, which the page and the form share), where the
 * claims allow-list (`__tests__/lint/claim-allowlist.json`) names "In progress".
 */

/** The outside roles of FR-DEC-01 (SRS line 737), the one list S-12's "Decided by" and S-15's "Accepted by" share. */
export { OUTSIDE_ROLE_LABELS } from '@/lib/decision/copy';

/** The stage as the pages write it. */
export const STAGE_NAMES: Readonly<Record<Stage, string>> = FINDINGS_COPY.stages;

/** C#411: "Open", "Closed by a mitigation", "Closed by an accepted risk (<who>)", "Withdrawn". `<who>` is `deciderLabel`'s record form (7.5.8). */
export function findingStateLabel(state: FindingState, accepted: Pick<AcceptedRiskView, 'acceptedBy'> | null): string {
  switch (state) {
    case 'open': return FINDINGS_COPY.labels.open;
    case 'closed_mitigation': return FINDINGS_COPY.labels.closedByMitigation;
    case 'withdrawn': return FINDINGS_COPY.labels.withdrawn;
    case 'closed_accepted_risk':
      return accepted === null ? FINDINGS_COPY.labels.closedByAcceptedRisk : FINDINGS_COPY.labels.closedByAcceptedRiskBy(deciderLabel(accepted.acceptedBy, '', 'record'));
  }
}

/** The decision status as 7.5.6 words it. */
export function decisionStatusWord(status: StoredDecisionStatus | null): string {
  if (status === 'withdrawn') return FINDINGS_COPY.labels.withdrawn;
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? FINDINGS_COPY.labels.noStatus;
}

/** C#414: "From a decision: <status>" (or "From a decision" when the version is not known, G-a9) or "Raised by the team". */
export function findingSourceLabel(
  f: Pick<FindingView, 'source' | 'questionId'>, version: { versionNumber: number; status: StoredDecisionStatus | null } | null,
): string {
  if (f.source === 'team') return FINDINGS_COPY.labels.raisedByTeam;
  if (version === null) return FINDINGS_COPY.labels.fromDecision;
  return FINDINGS_COPY.labels.fromDecisionWith(decisionStatusWord(version.status));
}

/**
 * 7.5.6 "Overdue: was due <date>" in the two parts the markup needs: the overdue colour marks `label` only (spec 7.1), and
 * `label + rest` is the phrase. The date is written day, short month, year (7.5.8).
 */
export function overdueLabel(dueDate: CalendarDate): { label: string; rest: string } {
  return { label: FINDINGS_COPY.labels.overdue, rest: FINDINGS_COPY.labels.wasDue(formatDay(dueDate)) };
}

/** S-14's stage heading with its count: "<Stage>: <n> findings", "<Stage>: 1 finding" for one (UX-07; owner default B40, R13-9). */
export function stageCountHeading(stageName: string, n: number): string {
  return FINDINGS_COPY.labels.stageCount(stageName, n);
}
