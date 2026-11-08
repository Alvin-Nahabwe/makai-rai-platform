import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';

export type SealNoteProps = { seals: SealRef[]; nextVersionNumber: number };

/**
 * What saving will do to a decision that is in a seal (W-3 note 4, UX-31), said before the person saves: one sentence
 * per review, for that review's highest seal holding the decision. A slot of S-12 (contract "Screens and slots"):
 * DEC-b renders it, REV-b fills it. Nothing when the decision is in no seal.
 */
export function SealNote({ seals, nextVersionNumber }: SealNoteProps): ReactElement | null {
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
          {`This decision is in seal ${s.sealNumber}. Saving makes version ${nextVersionNumber}; seal ${s.sealNumber} keeps version ${nextVersionNumber - 1}, and the review will show "changed since seal ${s.sealNumber}".`}
        </p>
      ))}
    </div>
  );
}
