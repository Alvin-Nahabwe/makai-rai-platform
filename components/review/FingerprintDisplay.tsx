'use client';

import { useId, useState, type ReactElement } from 'react';
import { formatFingerprint } from '@/lib/seal/format';

/**
 * A seal's fingerprint as 7.5.8 and UX-18 want it: lower-case hex in groups of four, the short form shown, the full
 * value one action away ("Show full fingerprint", a native button with `aria-expanded`), and a Copy button that writes
 * the full value and says so in a polite status region. A refused clipboard write is said too, and the full value is
 * then shown so it can be copied by hand.
 */
export function FingerprintDisplay({ fingerprint }: { fingerprint: string }): ReactElement {
  const [full, setFull] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const fullId = useId();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(fingerprint);
      setCopyStatus('Copied.');
    } catch {
      // No clipboard (an insecure page, a refused permission): say so and show the value to copy by hand.
      setFull(true);
      setCopyStatus('Not copied. The full fingerprint is shown; select it to copy.');
    }
  }

  return (
    <div className="fingerprint">
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
        Fingerprint <code>{formatFingerprint(fingerprint, 'short')}</code>
      </p>
      {full ? <p id={fullId} style={{ margin: 0, overflowWrap: 'anywhere' }}><code>{formatFingerprint(fingerprint, 'full')}</code></p> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)', alignItems: 'center' }}>
        <button type="button" className="btn btn--secondary" aria-expanded={full} aria-controls={full ? fullId : undefined} onClick={() => setFull((x) => !x)}>
          {full ? 'Hide full fingerprint' : 'Show full fingerprint'}
        </button>
        <button type="button" className="btn btn--secondary" onClick={() => { void copy(); }}>Copy</button>
        <p role="status" style={{ margin: 0 }}>{copyStatus}</p>
      </div>
    </div>
  );
}
