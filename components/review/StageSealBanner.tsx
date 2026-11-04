import type { ChangedSinceSeal } from '@/types/api';
import type { ReactElement } from 'react';

export type StageSealBannerProps = { changed: ChangedSinceSeal | null; reviewHref: string | null };

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The "changed since seal N" banner of S-11 (W-2: "<name>: changed since seal 1 in 2 questions. [Open review >]";
 * FR-REV-05, NFR-A11Y-05). The page prints the review's name before it; this prints the rest, in text, with "Open
 * review" as a native link when the page gives its address. A slot of S-11: DEC-b renders it, REV-b fills it.
 */
export function StageSealBanner({ changed, reviewHref }: StageSealBannerProps): ReactElement | null {
  if (changed === null) return null;
  const parts = [
    changed.changedQuestions.length > 0 ? count(changed.changedQuestions.length, 'question', 'questions') : null,
    changed.changedFindings.length > 0 ? count(changed.changedFindings.length, 'finding', 'findings') : null,
  ].filter((x): x is string => x !== null);
  const where = parts.length > 0 ? ` in ${parts.join(' and ')}` : '';
  return (
    <p className="stage-seal-banner">
      {`changed since seal ${changed.sealNumber}${where}.`}
      {reviewHref !== null ? <> <a href={reviewHref}>Open review</a></> : null}
    </p>
  );
}
