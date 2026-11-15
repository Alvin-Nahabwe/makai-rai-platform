import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';
import { Definition } from '@/components/ui/Definition';
import { markTerms } from '@/components/review/markTerms';
import { TERM_SEAL } from '@/lib/vocabulary/terms';
import { REVIEW_COPY, STAGE_TERMS } from '@/lib/review/copy';
import { STAGES } from '@/types/record';
import type { DefinedEntry } from '@/lib/vocabulary/types';

/**
 * `defineTerms` (ruling X-5): the marker can repeat on a page, so the page sets it on the marker that holds the page's
 * first use of "seal" and of the stage name. That marker's first item then marks both with `Term` and shows their
 * definitions in the same item; every other item, and every marker without it, is plain text.
 */
export type SealMarkerProps = { seals: SealRef[]; defineTerms?: boolean };

/** The stage a review's name begins with ("In-processing review 1"), as `stageReviewName` (lib/seal/reviewName.ts) writes it. */
function stageTermOf(reviewName: string): DefinedEntry | null {
  const stage = STAGES.find((s) => reviewName.startsWith(`${REVIEW_COPY.stageNames[s]} `));
  return stage === undefined ? null : STAGE_TERMS[stage];
}

/**
 * The marker "In seal N of <review>" on a record that a seal holds (UX-31), one per seal, in text. A slot of S-15
 * (FND-b renders it; DEC-b may on S-12 and S-13); REV-b fills it. Nothing when the record is in no seal.
 */
export function SealMarker({ seals, defineTerms = false }: SealMarkerProps): ReactElement | null {
  if (seals.length === 0) return null;
  return (
    <ul className="seal-markers">
      {seals.map((s, i) => {
        const text = REVIEW_COPY.mounted.sealMarker(s.sealNumber, s.reviewName);
        if (!defineTerms || i > 0) return <li key={s.sealId}>{text}</li>;
        const defined = [TERM_SEAL, stageTermOf(s.reviewName)].filter((t): t is DefinedEntry => t !== null);
        return (
          <li key={s.sealId}>
            {markTerms(text, defined)}
            {defined.map((t) => <Definition key={t.id} of={t} as="p" />)}
          </li>
        );
      })}
    </ul>
  );
}
