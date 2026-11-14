import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';
import { REVIEW_COPY } from '@/lib/review/copy';

export type SealMarkerProps = { seals: SealRef[] };

/**
 * The marker "In seal N of <review>" on a record that a seal holds (UX-31), one per seal, in text. A slot of S-15
 * (FND-b renders it; DEC-b may on S-12 and S-13); REV-b fills it. Nothing when the record is in no seal.
 */
export function SealMarker({ seals }: SealMarkerProps): ReactElement | null {
  if (seals.length === 0) return null;
  return (
    <ul className="seal-markers">
      {seals.map((s) => <li key={s.sealId}>{REVIEW_COPY.mounted.sealMarker(s.sealNumber, s.reviewName)}</li>)}
    </ul>
  );
}
