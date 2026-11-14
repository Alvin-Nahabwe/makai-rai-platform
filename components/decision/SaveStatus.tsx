import type { ReactElement } from 'react';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import type { SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
import type { UtcInstant } from '@/types/record';

/** UX-26's line for a browser that cannot keep drafts (private windows, blocked or full storage). */
const NO_STORAGE = DECISION_FORM_COPY.noStorage;

export type SaveStatusProps = { status: SaveStatusValue | null; draftSavedAt: UtcInstant | null; storageUnavailable: boolean };

/**
 * The save status line beside Save (UX-25, NFR-A11Y-03): one `role="status"` element for M-01 to M-04 and one
 * `role="alert"` element for every failure, both in the first markup and empty until there is something to say,
 * so the first change is announced (a live region added with its text is often not read). Only the region of the
 * current message holds text, so each message is announced once. When the browser cannot keep drafts, a failure's
 * announcement carries that sentence too, so a screen reader does not hear "kept in this browser" alone. The unsaved line (plan line
 * 925's sentence) and the no-storage line are plain text beside them: they change on every key and are not announced.
 */
export function SaveStatus({ status, draftSavedAt, storageUnavailable }: SaveStatusProps): ReactElement {
  const polite = status !== null && status.live === 'polite' ? status.text : '';
  // F4: a failure says the text is kept; when the browser refused the draft, the same announcement says it could not.
  // Not on a gate (GATE): there the person cannot save until they pass it, so "Save before leaving" would be wrong.
  const noStorage = storageUnavailable && status?.id !== 'GATE';
  const assertive = status !== null && status.live === 'assertive' ? `${status.text}${noStorage ? ` ${NO_STORAGE}` : ''}` : '';
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
