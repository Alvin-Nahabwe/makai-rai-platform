import type { ShellProjectStage } from '@/lib/shell/types';
import { PROJECT_COPY } from '@/lib/project/copy';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { QUESTION_COPY } from '@/lib/question/copy';

/**
 * The words of the rail's project block (owner ruling R4) and of the narrow top bar's project context. Server only: the
 * block and the bar context are server components (components/layout/ShellProject.tsx), so none of these words reach a
 * browser bundle; lib/shell/copy.ts holds the words the client shell shows.
 *
 * The stage sentence is the project page's own ("You can work on the stages in any order.", PROJECT_COPY), not the
 * sketch's "Three stages. Record them in any order."; the stage names are the stage list's; "All questions" is the
 * question page's link. The state lines follow spec 5 principle 7: counts in words, no percentage, no total across stages.
 */
export const SHELL_PROJECT_COPY = Object.freeze({
  stagesLead: PROJECT_COPY.overview.anyOrder,
  stageTitle: STAGE_LIST_COPY.stageTitle,
  allQuestions: QUESTION_COPY.nav.allQuestions,
  youAreHere: 'You are here',
  notStarted: 'Not started',
  separator: ' · ',
});

/** "1 question", "22 questions". */
export function questionCount(n: number): string {
  return n === 1 ? '1 question' : `${n} questions`;
}

/** "3 no decision yet". */
export function noDecisionYet(n: number): string {
  return `${n} no decision yet`;
}

/**
 * The one line of state under a stage's name: "You are here · 22 questions" for the stage in the address; otherwise
 * "Not started" while every question has no decision, else "22 questions · 3 no decision yet", or "22 questions" when
 * none is left without one.
 */
export function stageStateLine(s: ShellProjectStage, current: boolean): string {
  const { separator } = SHELL_PROJECT_COPY;
  if (current) return `${SHELL_PROJECT_COPY.youAreHere}${separator}${questionCount(s.questions)}`;
  if (s.noDecision >= s.questions) return SHELL_PROJECT_COPY.notStarted;
  return s.noDecision > 0 ? `${questionCount(s.questions)}${separator}${noDecisionYet(s.noDecision)}` : questionCount(s.questions);
}
