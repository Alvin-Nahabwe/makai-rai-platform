import type { AcceptedRiskView, FindingView } from '@/types/api';
import type { CalendarDate, FindingState, Stage, StoredDecisionStatus } from '@/types/record';
import { deciderLabel, STATUS_OPTIONS } from '@/lib/decision/copy';
import { formatDay } from '@/lib/format/dates';

/**
 * The fixed words of the findings screens (SRS 7.5.6 line 2529 to 2532, 7.5.8). Plain constants and functions with no
 * imports from the server, so a client component can import this module. The mitigation status words ("Planned", "In
 * progress", "Done", "Cancelled") are not here: "In progress" would be flagged by the claims lint (FR-PUB-01), and moving
 * it out of the components the lint reads would only hide it. They stay in `components/findings/FindingPageView.tsx`
 * (`MitigationStatusWord`) and `MitigationForm.tsx`, marked `data-claims-allowed` with the reason.
 */

/** The outside roles of FR-DEC-01 (SRS line 737), the one list S-12's "Decided by" and S-15's "Accepted by" share. */
export { OUTSIDE_ROLE_LABELS } from '@/lib/decision/copy';

/** The stage as the pages write it. */
export const STAGE_NAMES: Readonly<Record<Stage, string>> = Object.freeze({
  'pre-processing': 'Pre-processing', 'in-processing': 'In-processing', 'post-processing': 'Post-processing',
});

/** 7.5.6: "Open", "Closed by mitigation", "Closed: risk accepted by <who>", "Withdrawn". `<who>` is a member's name or "<Role> (outside role)" (7.5.8). */
export function findingStateLabel(state: FindingState, accepted: AcceptedRiskView | null): string {
  switch (state) {
    case 'open': return 'Open';
    case 'closed_mitigation': return 'Closed by mitigation';
    case 'withdrawn': return 'Withdrawn';
    case 'closed_accepted_risk':
      return accepted === null ? 'Closed: risk accepted' : `Closed: risk accepted by ${deciderLabel(accepted.acceptedBy, '', 'record')}`;
  }
}

/** The decision status as 7.5.6 words it. */
export function decisionStatusWord(status: StoredDecisionStatus | null): string {
  if (status === 'withdrawn') return 'Withdrawn';
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? 'No status';
}

/** 7.5.6: "From question <id> (version <n>, status <status>)" or "Raised by the team". */
export function findingSourceLabel(
  f: Pick<FindingView, 'source' | 'questionId'>, version: { versionNumber: number; status: StoredDecisionStatus | null } | null,
): string {
  if (f.source === 'team') return 'Raised by the team';
  if (version === null) return `From question ${f.questionId ?? ''}`.trim();
  return `From question ${f.questionId} (version ${version.versionNumber}, status ${decisionStatusWord(version.status)})`;
}

/**
 * 7.5.6 "Overdue: was due <date>" in the two parts the markup needs: the tint wraps `label` only (R13-7), and
 * `label + rest` is the phrase. The date is written day, short month, year (7.5.8).
 */
export function overdueLabel(dueDate: CalendarDate): { label: 'Overdue'; rest: string } {
  return { label: 'Overdue', rest: `: was due ${formatDay(dueDate)}` };
}

/** S-14's stage heading with its count: "<Stage>: <n> findings", "<Stage>: 1 finding" for one (UX-07; owner default B40, R13-9). */
export function stageCountHeading(stageName: string, n: number): string {
  return `${stageName}: ${n} ${n === 1 ? 'finding' : 'findings'}`;
}
