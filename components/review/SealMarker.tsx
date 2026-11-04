import type { SealRef } from '@/types/seal';
import type { ReactElement } from 'react';

export type SealMarkerProps = { seals: SealRef[] };

/**
 * The marker "In seal N of <review>" on a record that a seal holds (UX-31), one per seal, in text. A slot of S-15
 * (FND-b renders it; DEC-b may on S-12 and S-13); REV-b fills it. Nothing when the record is in no seal.
 */
export function SealMarker({ seals }: SealMarkerProps): ReactElement | null {
  if (seals.length === 0) return null;
  return (
    <ul className="seal-markers">
      {seals.map((s) => <li key={s.sealId}>{`In seal ${s.sealNumber} of ${s.reviewName}`}</li>)}
    </ul>
  );
}
