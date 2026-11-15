'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { AUTH_COPY } from '@/lib/auth/copy';
import './auth.css';

export type OtherAccountTextConfirmProps = {
  /** 'other': another account's text is kept here; 'unknown': the session read failed, so whose cannot be checked. */
  kind: 'other' | 'unknown';
  onRemove: () => void;
  onSignOut: () => void;
  /** Remove it and continue is being carried out. */
  busy: boolean;
  /** Why Sign out and leave it did not end the session (the sign-out press's line), or null. */
  message: string | null;
};

/**
 * D16, option A (plan 1B Task 5; owner's answer to OD-1, 11 Nov 2026): shown on S-01 after a sign-in that worked, in place
 * of the form, when this browser keeps unsaved text of another account (or of an account it cannot check). It reveals one
 * bit, that such text exists: no count, key, id, name, email, organisation, project or question (T5.2). Built on the kit's
 * InlineConfirm, whose order puts the safe choice first: **Sign out and leave it** (the text stays for its owner), then
 * **Remove it and continue**, the destructive button (never orange). Each consequence is said before the buttons.
 *
 * Focus moves to its title when it appears, so a keyboard or screen-reader user starts at the question. A failed sign-out
 * is said in the alert region under it (the press never navigates then). Escape and leaving the page choose nothing: the
 * session stays signed in, the text stays, and the next sign-in on this browser asks again (T5.8).
 */
export function OtherAccountTextConfirm({ kind, onRemove, onSignOut, busy, message }: OtherAccountTextConfirmProps): ReactElement {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // InlineConfirm's title is its first paragraph; it takes focus here, once, as the plan asks (tabIndex -1).
    const title = box.current?.querySelector<HTMLElement>('.ui-confirm__object');
    if (title) {
      title.tabIndex = -1;
      title.focus();
    }
  }, []);
  const other = kind === 'other';
  return (
    <div ref={box} className="other-text">
      <InlineConfirm
        objectName={other ? AUTH_COPY.otherTextTitle : AUTH_COPY.unknownTextTitle}
        consequence={other ? AUTH_COPY.otherTextBody : AUTH_COPY.unknownTextBody}
        actionLabel={AUTH_COPY.removeAndContinue}
        cancelLabel={AUTH_COPY.signOutAndLeave}
        destructive
        busy={busy}
        onConfirm={onRemove}
        onCancel={onSignOut}
      >
        <ul className="other-text__consequences">
          <li><strong>{AUTH_COPY.signOutAndLeave}:</strong> {AUTH_COPY.consequenceLeave}</li>
          <li><strong>{AUTH_COPY.removeAndContinue}:</strong> {AUTH_COPY.consequenceRemove}</li>
        </ul>
      </InlineConfirm>
      <StatusRegion message={message} politeness="assertive" tone="error" />
    </div>
  );
}
