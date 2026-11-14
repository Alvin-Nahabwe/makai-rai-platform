'use client';

import { useId, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import '@/components/ui/buttonStyles';
import '@/components/ui/formStyles';
import { formatFingerprint } from '@/lib/seal/format';
import { REVIEW_COPY } from '@/lib/review/copy';
import './review.css';

/**
 * A seal's fingerprint as 7.5.8 and UX-18 want it: lower-case hex in groups of four, the short form shown, the full
 * value one action away ("Show full fingerprint", a native button in the kit's classes, since the kit's Button takes
 * no `aria-expanded` or `aria-controls`), and the kit's button "Copy fingerprint" that writes the full value and says
 * so in a polite status region. A refused clipboard write is said too, and the full value is then shown so it can be
 * copied by hand.
 */
export function FingerprintDisplay({ fingerprint }: { fingerprint: string }): ReactElement {
  const [full, setFull] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const fullId = useId();
  const c = REVIEW_COPY.fingerprint;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopyStatus(c.copied);
    } catch {
      // No clipboard (an insecure page, a refused permission): say so and show the value to copy by hand.
      setFull(true);
      setCopyStatus(c.notCopied);
    }
  }

  return (
    <div className="fingerprint review-fingerprint">
      <p className="review-wrap">
        {c.label} <code className="review-code">{formatFingerprint(fingerprint, 'short')}</code>
      </p>
      {full ? <p id={fullId} className="review-wrap"><code className="review-code">{formatFingerprint(fingerprint, 'full')}</code></p> : null}
      <div className="review-row">
        <button type="button" className="ui-button ui-button--secondary" aria-expanded={full} aria-controls={full ? fullId : undefined} onClick={() => setFull((x) => !x)}>
          {full ? c.hideFull : c.showFull}
        </button>
        <Button variant="secondary" onClick={() => { void copy(); }}>{c.copy}</Button>
        <p role="status" className="ui-status review-inline-status">{copyStatus}</p>
      </div>
    </div>
  );
}
