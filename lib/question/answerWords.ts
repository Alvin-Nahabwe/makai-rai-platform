import { STATUS_OPTIONS } from '@/lib/decision/copy';
import type { AnswerKey, ContentQuestion } from '@/types/content';

/**
 * The one lookup for a question's own words (content 5.2.0) and for "the practice changed" (FR-CNT-08).
 * A question without `answerLabels` or `answerPrompts` (the gate, content before 5.2.0) falls back to the
 * shared status words and to `reasonPrompt`.
 */

/** The question's label for a stored status, else the shared one. */
export function answerLabel(q: Pick<ContentQuestion, 'answerLabels'>, status: AnswerKey): string {
  return q.answerLabels?.[status] ?? STATUS_OPTIONS.find((o) => o.value === status)!.label;
}

/** What to write in the reason box for the status; `reasonPrompt` (or '') when the question has no per-status prompt or no status is chosen. */
export function answerPrompt(q: Pick<ContentQuestion, 'answerPrompts' | 'reasonPrompt'>, status: AnswerKey | null): string {
  if (q.answerPrompts !== undefined && status !== null) return q.answerPrompts[status];
  return q.reasonPrompt ?? '';
}

/**
 * True when the practice a decision was answered against reads differently now and the running question does
 * not list the answered version in `practiceSameAs`. A `then` that does not hold the question counts as changed.
 */
export function practiceChanged(
  then: Pick<ContentQuestion, 'expectedPractice'> | undefined, thenSemver: string,
  now: Pick<ContentQuestion, 'expectedPractice' | 'practiceSameAs'>,
): boolean {
  if (then === undefined) return true;
  return then.expectedPractice !== now.expectedPractice && !(now.practiceSameAs ?? []).includes(thenSemver);
}
