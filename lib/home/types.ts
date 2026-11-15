import type { OrgRole } from '@prisma/client';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import type { Tally } from '@/lib/ui/marks';
import type { FindingView, FollowUpItem, StageReviewView, UserRef } from '@/types/api';
import type { CalendarDate, Stage, UtcInstant } from '@/types/record';

/** Home's data types (plan 1B Task 9, spec 9.1): the next step, the changes since, and each role's variant. */

/** The person's newest saved entry in an active project of the organisation. */
export type SavedRef = { projectId: string; projectName: string; stage: Stage; questionId: string; at: UtcInstant };

/** Home's "Your next step" (rule C2): one question, where it is, and which rule chose it. */
export type NextStep = { projectId: string; projectName: string; stage: Stage; questionId: string; questionText: string;
  position: { n: number; of: number }; rule: 'next-open' | 'last-saved' | 'first-open'; lastSavedOn: UtcInstant | null };

/** The project page's primary action (plan 1C C11): where it goes and which of its two words it carries. */
export type ContinueTarget = { stage: Stage; questionId: string | null; label: 'continue' | 'start' };

/**
 * Saved changes of one person, of one kind, in one project's stage, on one day: `decisions` counts the questions decided
 * (a withdrawal included), `finding` the findings raised, `seal` the seals made. `day` is the East Africa date of the
 * changes, as "today" is (D5); `latestAt` the newest of them.
 */
export type ChangeGroup = { day: CalendarDate; latestAt: UtcInstant; who: UserRef; kind: 'decisions' | 'finding' | 'seal';
  count: number; projectId: string; projectName: string; stage: Stage };

/**
 * One stage of a project as Home shows it: its open items, then its recorded part as a row of marks with the tally.
 * `nextOpen` is the stage's first question with no decision, in question order, for the stage plate's "Next:" line
 * (not in the plan's interface block: added for the Route sketch's stage plate, lane 3 Task 2); `null` when none is open.
 */
export type StageOpen = { stage: Stage; noDecision: number; openFindings: number; overdueMitigations: number;
  stops: RouteStop[]; tally: Tally;
  nextOpen: { questionId: string; questionText: string; position: { n: number; of: number } } | null };

/**
 * A stop of a stage's row of marks, equal to RouteRow's `stops` element (a type test pins the two). `scopeAnswer` is the
 * personal data question's answer, which the kit's RouteRow gained after the plan's interface block was written.
 */
export type RouteStop = { id: string; kind: StatusMarkKind; title: string; href?: string; current?: boolean; scopeAnswer?: ScopeAnswer };

export type HomeData =
  | { variant: 'recorder'; base: HomeBase; next: NextStep | null; assigned: FollowUpItem[]; since: { from: UtcInstant; groups: ChangeGroup[]; more: boolean } | null;
      focus: { projectId: string; projectName: string; stages: StageOpen[] } | null; lead: TeamLead | null; otherProjects: number }
  | { variant: 'reviewer'; base: HomeBase; unsealed: StageReviewView[]; changedSinceSeal: StageReviewView[]; raisedByMe: FindingView[] }
  | { variant: 'viewer'; base: HomeBase; recent: { groups: ChangeGroup[]; more: boolean }; open: Array<{ projectId: string; projectName: string; stages: StageOpen[] }> }
  | { variant: 'first-time'; base: HomeBase; canCreate: boolean };

export type HomeBase = { orgSlug: string; orgId: string; orgName: string; role: OrgRole; userId: string; userName: string; welcome: boolean; archivedCount: number };

/** The Owner's and Admin's addition: overdue mitigations and open findings with no mitigation, of active projects. */
export type TeamLead = { overdue: FollowUpItem[]; withoutMitigation: FindingView[]; multiProject: boolean };
