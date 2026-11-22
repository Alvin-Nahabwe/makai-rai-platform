import type { ReactElement } from 'react';
import { SavedArrivalLine } from '@/components/question/SavedArrivalLine';
import { deciderLabel, savedArrivalBack, savedArrivalLine } from '@/lib/decision/copy';
import { formatDeclaredDate } from '@/lib/format/dates';
import { questionHref } from '@/lib/question/draft';
import type { StageRow } from '@/lib/question/stageList';
import type { DecisionVersionView } from '@/types/api';
import type { Stage } from '@/types/record';

/** What `savedArrivalFor` reads: the stage's rows in order (one per question) and the project's current decisions of the stage, with its address. */
export type SavedArrivalInput = {
  orgSlug: string; projectId: string; stage: Stage;
  rows: readonly Pick<StageRow, 'questionId'>[];
  current: ReadonlyMap<string, DecisionVersionView>;
};

/** What the line shows: the saved version, the question's place in its stage, and the address of that question. */
export type SavedArrivalData = { version: DecisionVersionView; questionNumber: number; href: string };

/**
 * The line's data for the page's `saved` parameter (answer cost, design 8, "The 'saved' line"): the current version of that question
 * of this project, and only that. Null for no parameter, an id that is not a question of this stage, a question with no current
 * answer or a withdrawn one, and a version that carries no decider or no date (there is nothing true to say about who and when). The
 * parameter is never printed: every word on the line comes from the database and the content, so an address cannot put its own text
 * on the page. `current` is read through the viewer's organisation (lib/question/savedArrival.ts), so it never holds another project's answer.
 */
export function savedArrivalFor(d: SavedArrivalInput, saved: string | undefined): SavedArrivalData | null {
  if (saved === undefined) return null;
  const at = d.rows.findIndex((r) => r.questionId === saved);
  if (at < 0) return null;
  const version = d.current.get(saved);
  if (version === undefined || version.status === 'withdrawn' || version.decidedBy === null || version.declaredDate === null) return null;
  return { version, questionNumber: at + 1, href: questionHref(d, saved) };
}

/**
 * "Your answer to question 4 is saved: decided by you, 22 Nov 2026. Back to question 4". The decider is named as the save's own
 * confirmation names them ("you" for the viewer, `deciderLabel` 'confirmation'), the date as the interface writes a declared date.
 * Rendered on the server; the client part, which takes focus, holds only strings (SavedArrivalLine.tsx). The page gives it a `key`
 * of the saved version's id, so a second arrival on the same route is a new element.
 */
export function SavedArrival({ version, questionNumber, href, viewerId }: SavedArrivalData & { viewerId: string }): ReactElement | null {
  if (version.decidedBy === null || version.declaredDate === null) return null;
  const line = savedArrivalLine(questionNumber, deciderLabel(version.decidedBy, viewerId, 'confirmation'), formatDeclaredDate(version.declaredDate));
  return <SavedArrivalLine line={line} backText={savedArrivalBack(questionNumber)} href={href} />;
}
