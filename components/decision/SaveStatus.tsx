import type { ReactElement } from 'react';
import { formatTime } from '@/lib/format/dates';
import type { SaveStatus as SaveStatusValue } from '@/lib/question/saveOutcome';
import type { UtcInstant } from '@/types/record';

/** UX-26's line for a browser that cannot keep drafts (private windows, blocked or full storage). */
const NO_STORAGE = 'This browser cannot keep drafts. Save before leaving this page.';

export type SaveStatusProps = { status: SaveStatusValue | null; draftSavedAt: UtcInstant | null; storageUnavailable: boolean };

/**
 * The save status line beside Save (UX-25, NFR-A11Y-03): one `role="status"` element for M-01 to M-04 and one
 * `role="alert"` element for every failure, both in the first markup and empty until there is something to say,
 * so the first change is announced (a live region added with its text is often not read). Only the region of the
 * current message holds text, so each message is announced once. When the browser cannot keep drafts, a failure's
 * announcement carries that sentence too, so a screen reader does not hear "kept on this device" alone. The draft line and the no-storage line are plain
 * text beside them: they change on every key and are not announced.
 */
export function SaveStatus({ status, draftSavedAt, storageUnavailable }: SaveStatusProps): ReactElement {
  const polite = status !== null && status.live === 'polite' ? status.text : '';
  // F4: a failure says "kept on this device"; when the browser refused the draft, the same announcement says it could not.
  const assertive = status !== null && status.live === 'assertive' ? `${status.text}${storageUnavailable ? ` ${NO_STORAGE}` : ''}` : '';
  return (
    <div className="save-status">
      <p role="status" data-message-id={polite === '' ? undefined : status?.id}>{polite}</p>
      <p role="alert" data-message-id={assertive === '' ? undefined : status?.id}>{assertive}</p>
      {storageUnavailable && assertive === '' ? <p className="text-muted">{NO_STORAGE}</p> : null}
      {!storageUnavailable && status === null && draftSavedAt !== null
        ? <p className="text-muted">{`Draft on this device, not saved yet (${formatTime(draftSavedAt)})`}</p>
        : null}
    </div>
  );
}
