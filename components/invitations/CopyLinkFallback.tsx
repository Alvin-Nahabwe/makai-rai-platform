'use client';

import { useId, useState } from 'react';
import type { ReactElement, Ref } from 'react';
import type { UtcInstant } from '@/types/record';
import { formatDay } from '@/lib/format/dates';
import { COPY_LINK_COPY } from '@/lib/invitations/link/copy';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { TextInput } from '@/components/ui/TextInput';

export interface CopyLinkFallbackProps {
  acceptUrl: string | null;
  expiresAt: UtcInstant;
  emailSent: boolean;
  /** Offered when no link is shown and the email failed. */
  onResendWithLink?: () => void;
  /** The screen announces the email-failure sentence in its own persistent status region, so the box does not print it. */
  noticeShownElsewhere?: boolean;
  /** The box itself, for a screen that brings it into view after the answer that showed it (Members, finding S6). */
  ref?: Ref<HTMLDivElement>;
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
  const message = copy === null || copy.url !== p.acceptUrl ? null
    : copy.result === 'done' ? COPY_LINK_COPY.copied
    : COPY_LINK_COPY.copyFailed;
  return (
    <div className="card" ref={p.ref}>
      <StatusRegion message={message} />
      {!p.emailSent && !p.noticeShownElsewhere && <p>{COPY_LINK_COPY.emailFailed}</p>}
      {p.acceptUrl !== null && (
        <>
          <TextInput id={fieldId} name="invitationLink" label={COPY_LINK_COPY.linkLabel} readOnly value={p.acceptUrl} />
          <Button variant="secondary" onClick={() => { void copyLink(); }}>{COPY_LINK_COPY.copy}</Button>
          <p style={{ margin: 'var(--space-3) 0 0' }}>{COPY_LINK_COPY.worksOnce(formatDay(p.expiresAt))}</p>
        </>
      )}
      {p.acceptUrl === null && !p.emailSent && p.onResendWithLink !== undefined && (
        <Button variant="secondary" onClick={p.onResendWithLink}>{COPY_LINK_COPY.resend}</Button>
      )}
    </div>
  );
}
