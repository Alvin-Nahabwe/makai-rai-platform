import { loadContent } from '@/lib/content/loader';
import type { LoadedContent, LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';

/**
 * FR-CNT-08's marker: a decision is measured against the expected practice of the content version it was
 * answered against (FR-CNT-07); when the running version words that practice differently, S-12 and S-11
 * say so. Only the expected practice is compared: a reworded question text does not change what the
 * decision was measured against.
 */
export function isReworded(answeredAgainst: LoadedQuestion, running: LoadedQuestion): boolean {
  return answeredAgainst.expectedPractice !== running.expectedPractice;
}

/**
 * The questions whose current decision (a withdrawal is no decision, 5.3 item 2) was answered against an
 * expected practice the running content now words differently, in question id order. `load` reads a listed
 * content version (default `loadContent`, which throws `unknown_content_version` for one not listed).
 */
export function rewordedQuestionIds(
  current: ReadonlyMap<string, DecisionVersionView>, running: LoadedContent,
  load: (semver: string) => LoadedContent = loadContent,
): string[] {
  const ids: string[] = [];
  // One read per content version, not per decision (loadContent re-reads the index each call; SI-5).
  const loaded = new Map<string, LoadedContent>();
  const once = (semver: string): LoadedContent => {
    let c = loaded.get(semver);
    if (c === undefined) { c = load(semver); loaded.set(semver, c); }
    return c;
  };
  for (const [questionId, v] of current) {
    if (v.status === 'withdrawn' || v.content.semver === running.semver) continue;
    const now = running.questions.get(questionId);
    const then = once(v.content.semver).questions.get(questionId);
    if (now !== undefined && then !== undefined && isReworded(then, now)) ids.push(questionId);
  }
  return ids.sort();
}
