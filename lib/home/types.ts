import type { Stage, UtcInstant } from '@/types/record';

/** Home's data types (plan 1B Task 9, spec 9.1). This cut builds the recorder's next step only. */

/** The person's newest saved entry in an active project of the organisation. */
export type SavedRef = { projectId: string; projectName: string; stage: Stage; questionId: string; at: UtcInstant };

/** Home's "Your next step" (rule C2): one question, where it is, and which rule chose it. */
export type NextStep = { projectId: string; projectName: string; stage: Stage; questionId: string; questionText: string;
  position: { n: number; of: number }; rule: 'next-open' | 'last-saved' | 'first-open'; lastSavedOn: UtcInstant | null };

/** The project page's primary action (plan 1C C11): where it goes and which of its two words it carries. */
export type ContinueTarget = { stage: Stage; questionId: string | null; label: 'continue' | 'start' };
