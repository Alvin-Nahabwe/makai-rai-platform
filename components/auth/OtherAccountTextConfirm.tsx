'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { AUTH_COPY } from '@/lib/auth/copy';
import './auth.css';

export type OtherAccountTextConfirmProps = {
  /** 'other': another account's text is kept here; 'unknown': the session read failed, so whose cannot be checked. */
  kind: 'other' | 'unknown';
  onRemove: () => void;
  onSignOut: () => void;
  /** Remove it and continue is being carried out. */
  removing: boolean;
  /** Sign out and leave it is being carried out. */
  leaving: boolean;
  /** Why Sign out and leave it did not end the session (the sign-out press's line), or null. */
  message: string | null;
};

/**
 * D16, option A (plan 1B Task 5; owner's answer to OD-1, 11 Nov 2026): the body of S-01's card after a sign-in that worked,
 * in place of the form, when this browser keeps unsaved text of another account (or of an account it cannot check). The
 * question itself is the card's h1 (LoginView; ruling L5-27), and focus moves to it when this appears. It reveals one bit,
 * that such text exists: no count, key, id, name, email, organisation, project or question (T5.2).
 *
 * The two choices are drawn here rather than in the kit's InlineConfirm, whose own bordered box would sit inside the card
 * (design review M-3) and whose cancel slot is never busy (code review A-2): each button shows its own progress. The safe
 * choice comes first, **Sign out and leave it** (the text stays for its owner), then **Remove it and continue**, the
 * destructive button, never orange. Each consequence is said before the buttons. A failed sign-out is said in the alert
 * region under them (the press never navigates then). Escape and leaving the page choose nothing: the session stays
 * signed in, the text stays, and the next sign-in on this browser asks again (T5.8).
 */
export function OtherAccountTextConfirm({ kind, onRemove, onSignOut, removing, leaving, message }: OtherAccountTextConfirmProps): ReactElement {
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const heading = box.current?.closest('.auth-view')?.querySelector<HTMLElement>(':scope > h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, []);
  return (
    <div ref={box} className="other-text">
      <p>{kind === 'other' ? AUTH_COPY.otherTextBody : AUTH_COPY.unknownTextBody}</p>
      <ul className="other-text__consequences">
        <li><strong>{AUTH_COPY.signOutAndLeave}:</strong> {AUTH_COPY.consequenceLeave}</li>
        <li><strong>{AUTH_COPY.removeAndContinue}:</strong> {AUTH_COPY.consequenceRemove}</li>
      </ul>
      <div className="other-text__actions">
        <Button variant="secondary" busy={leaving} onClick={onSignOut}>{AUTH_COPY.signOutAndLeave}</Button>
        <Button variant="destructive" busy={removing} onClick={onRemove}>{AUTH_COPY.removeAndContinue}</Button>
      </div>
      <StatusRegion message={message} politeness="assertive" tone="error" />
    </div>
  );
}
