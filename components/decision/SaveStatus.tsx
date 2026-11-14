import type { ReactElement } from 'react';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import type { SaveMessageId, SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
import type { UtcInstant } from '@/types/record';

/** UX-26's line for a browser that cannot keep drafts (private windows, blocked or full storage). */
const NO_STORAGE = DECISION_FORM_COPY.noStorage;

/**
 * The lines that say the text is kept in this browser, as they read when it can keep nothing (the coordinator's answer to
 * Q18 (a)): M-02 without its sentence about the copy; M-08 in the gate lines' shape, which says to copy the text first
 * and so, like the gate, is not followed by the no-storage line ("Save before you leave this page" cannot be done once
 * signed out). Every other line reads the same with or without storage.
 */
const WITHOUT_STORAGE: Partial<Record<SaveMessageId, string>> = {
  'M-02': DECISION_OUTCOME_COPY.save.slowNoStorage,
  'M-08': DECISION_OUTCOME_COPY.save.signedOutNoStorage,
};

export type SaveStatusProps = { status: SaveStatusValue | null; draftSavedAt: UtcInstant | null; storageUnavailable: boolean };

/**
 * The save status line beside Save (UX-25, NFR-A11Y-03): one `role="status"` element for M-01 to M-04 and one
 * `role="alert"` element for every failure, both in the first markup and empty until there is something to say,
 * so the first change is announced (a live region added with its text is often not read). Only the region of the
 * current message holds text, so each message is announced once. When the browser cannot keep drafts, a line that would
 * say the text is kept reads its no-storage form, and a failure's announcement carries the no-storage sentence too. The unsaved line (plan line
 * 925's sentence) and the no-storage line are plain text beside them: they change on every key and are not announced.
 */
export function SaveStatus({ status, draftSavedAt, storageUnavailable }: SaveStatusProps): ReactElement {
  const text = status === null ? '' : (storageUnavailable ? WITHOUT_STORAGE[status.id] ?? status.text : status.text);
  const polite = status !== null && status.live === 'polite' ? text : '';
  // F4: when the browser refused the draft, a failure's announcement says so too. Not on a gate (GATE) or a sign-out
  // (M-08): there the person cannot save until they pass it, so "Save before you leave this page" would be wrong, and
  // their line already says the browser cannot keep the text.
  const noStorage = storageUnavailable && status?.id !== 'GATE' && status?.id !== 'M-08';
  const assertive = status !== null && status.live === 'assertive' ? `${text}${noStorage ? ` ${NO_STORAGE}` : ''}` : '';
  return (
    <div className="save-status">
      <p role="status" data-message-id={polite === '' ? undefined : status?.id}>{polite}</p>
      <p role="alert" data-message-id={assertive === '' ? undefined : status?.id}>{assertive}</p>
      {storageUnavailable && assertive === '' ? <p className="text-muted">{NO_STORAGE}</p> : null}
      {/* The unsaved line also follows "Saved" when the person typed past the save: the field then holds newer text than
          the one saved, and it is in this browser only (ruling on CR-1). */}
      {!storageUnavailable && draftSavedAt !== null && (status === null || status.id === 'M-03' || status.id === 'M-04')
        ? <p className="text-muted">{DECISION_FORM_COPY.unsaved}</p>
        : null}
    </div>
  );
}
