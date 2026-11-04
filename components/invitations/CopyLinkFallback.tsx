'use client';

import { useId, useState } from 'react';
import type { ReactElement } from 'react';
import type { UtcInstant } from '@/types/record';
import { formatDay } from '@/lib/format/dates';

export interface CopyLinkFallbackProps {
  acceptUrl: string | null;
  expiresAt: UtcInstant;
  emailSent: boolean;
  /** Offered when no link is shown and the email failed. */
  onResendWithLink?: () => void;
}

/**
 * UX-23 (SRS lines 2343-2344): the accept link in a read-only field (so it can be selected when the clipboard
 * is unavailable), a Copy button, and the two sentences. Results are announced in one polite status region.
 */
export function CopyLinkFallback(p: CopyLinkFallbackProps): ReactElement {
  const fieldId = useId();
  const [copied, setCopied] = useState<'idle' | 'done' | 'blocked'>('idle');
  async function copy(): Promise<void> {
    if (p.acceptUrl === null) return;
    try {
      await navigator.clipboard.writeText(p.acceptUrl);
      setCopied('done');
    } catch {
      setCopied('blocked'); // reported in the status region below; the field stays selectable
    }
  }
  const message = copied === 'done' ? 'Link copied.'
    : copied === 'blocked' ? 'The link could not be copied. Select it and copy it by hand.'
    : !p.emailSent ? 'The invitation email could not be sent. Send this link another way.'
    : '';
  return (
    <div className="card">
      <div role="status">{message}</div>
      {p.acceptUrl !== null && (
        <>
          <label htmlFor={fieldId}>Invitation link</label>
          <input id={fieldId} type="text" readOnly value={p.acceptUrl} />
          <button type="button" className="btn btn--secondary" onClick={() => { void copy(); }}>Copy link</button>
          <p>The link works once and expires on {formatDay(p.expiresAt)}.</p>
        </>
      )}
      {p.acceptUrl === null && !p.emailSent && p.onResendWithLink !== undefined && (
        <button type="button" className="btn btn--secondary" onClick={p.onResendWithLink}>Resend and show link</button>
      )}
    </div>
  );
}
