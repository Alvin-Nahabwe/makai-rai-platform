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
  /** The screen announces the email-failure sentence in its own persistent status region, so the box does not print it. */
  noticeShownElsewhere?: boolean;
}

/**
 * UX-23 (SRS lines 2343-2344): the accept link in a read-only field (so it can be selected when the clipboard
 * is unavailable), a Copy button, and the two sentences. The box's status region mounts empty and carries only the
 * copy result: a live region inserted together with its text is often not announced (4.1.3). A copy result belongs to
 * one link: it is remembered with the link it was made for, so a later invitation never shows an earlier "copied".
 */
export function CopyLinkFallback(p: CopyLinkFallbackProps): ReactElement {
  const fieldId = useId();
  const [copy, setCopy] = useState<{ url: string; result: 'done' | 'blocked' } | null>(null);
  async function copyLink(): Promise<void> {
    const url = p.acceptUrl;
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopy({ url, result: 'done' });
    } catch {
      setCopy({ url, result: 'blocked' }); // reported in the status region below; the field stays selectable
    }
  }
  const message = copy === null || copy.url !== p.acceptUrl ? ''
    : copy.result === 'done' ? 'Link copied.'
    : 'The link could not be copied. Select it and copy it by hand.';
  return (
    <div className="card">
      <div role="status">{message}</div>
      {!p.emailSent && !p.noticeShownElsewhere && <p>The invitation email could not be sent. Send this link another way.</p>}
      {p.acceptUrl !== null && (
        <>
          <label htmlFor={fieldId}>Invitation link</label>
          <input id={fieldId} type="text" readOnly value={p.acceptUrl} />
          <button type="button" className="btn btn--secondary" onClick={() => { void copyLink(); }}>Copy link</button>
          <p>The link works once and expires on {formatDay(p.expiresAt)}.</p>
        </>
      )}
      {p.acceptUrl === null && !p.emailSent && p.onResendWithLink !== undefined && (
        <button type="button" className="btn btn--secondary" onClick={p.onResendWithLink}>Resend and show link</button>
      )}
    </div>
  );
}
