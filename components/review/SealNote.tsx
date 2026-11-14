import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';
import { REVIEW_COPY } from '@/lib/review/copy';

export type SealNoteProps = {
  seals: SealRef[];
  /** Kept for the pages that mount this (ruling T18-c); the sentence no longer names version numbers (C#244, Q9). */
  nextVersionNumber: number;
};

/**
 * What saving will do to a decision that is in a seal (W-3 note 4, UX-31), said before the person saves: one sentence
 * per review, for that review's highest seal holding the decision. A slot of S-12 (contract "Screens and slots"):
 * DEC-b renders it, REV-b fills it. Nothing when the decision is in no seal.
 */
export function SealNote({ seals }: SealNoteProps): ReactElement | null {
  const highest = new Map<string, SealRef>();
  for (const s of seals) {
    const cur = highest.get(s.reviewId);
    if (cur === undefined || s.sealNumber > cur.sealNumber) highest.set(s.reviewId, s);
  }
  if (highest.size === 0) return null;
  return (
    <div className="seal-note">
      {[...highest.values()].map((s) => (
        <p key={s.reviewId}>
          {REVIEW_COPY.mounted.sealNote(s.sealNumber)}
        </p>
      ))}
    </div>
  );
}
