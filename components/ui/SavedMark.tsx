import type { ReactElement, ReactNode } from 'react';
import { LocalTime } from '@/components/ui/LocalTime';
import { formatDeclaredDate } from '@/lib/format/dates';
import { UI_COPY } from '@/lib/ui/copy';
import type { DeclaredDate, UtcInstant } from '@/types/record';
import './SavedMark.css';

/**
 * The shape of "Saved" (critique P1 4): a record page with its corner folded and two lines on it, drawn in strokes. It has
 * no disc and no check, so it is not Done's filled green check (R8) and is not read as an answer. It is not a status mark
 * (no `ui-mark__shape`), so the no-score checks leave it to the saved rules; SavedMark.css paints it, in forced colours
 * as the system text colour. Hidden: the words beside it say what it means.
 */
export function SavedShape({ size = 24 }: { size?: 16 | 24 }): ReactElement {
  return (
    <svg className="ui-saved__svg" data-saved-shape width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path className="ui-saved__page" d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" strokeWidth={2} strokeLinejoin="round" />
      <path className="ui-saved__fold" d="M14 3v5h5" fill="none" strokeWidth={2} strokeLinejoin="round" />
      <path className="ui-saved__lines" d="M9.5 13h5M9.5 17h5" fill="none" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

export type SavedMarkProps = {
  saved: { version: number; savedAt: UtcInstant; decidedOn: DeclaredDate | null } | null;
  historyHref?: string;
  /**
   * Default true: the mark is a polite, atomic status region. A live mark must be rendered empty first (`saved={null}`)
   * and filled by a later render: rendered on the server already filled, its time text changes at hydration inside the
   * atomic region and the whole mark is announced on page load. So a caller that server-renders a filled mark, or a
   * form whose own status line already announces the save, passes `live={false}`, which drops the three attributes.
   */
  live?: boolean;
  /**
   * Additive (T3 item 9): the saved time as the caller writes it, in place of LocalTime's (a caller that shows another zone
   * near the mark passes a time that names its zone). Absent, the mark is exactly as before.
   */
  savedTime?: ReactNode;
  /**
   * Additive (lane 2 T5, review A A3c-2): the history link as the caller renders it, in place of the plain anchor built from
   * `historyHref` (the decision card passes one that a held Save turns into text). Absent, the mark is exactly as before.
   */
  historyLink?: ReactNode;
  /** Additive (lane 2 T5, design N4): the saved shape as the caller draws it, in place of the default folded-page shape. */
  shape?: ReactNode;
};

/**
 * The saved mark (spec 7.3): after a save, the saved shape, "Saved as version n", the decided and saved dates labelled
 * apart, and the line saying the decision is on the platform with the earlier version in the history. It is always
 * mounted and empty while nothing is saved, so a polite live region exists before its words arrive and announces them.
 * It is not a client component: it has no state or handler, and LocalTime inside it is its own client boundary.
 */
export function SavedMark({ saved, historyHref, live = true, savedTime, historyLink, shape }: SavedMarkProps): ReactElement {
  const region = live ? ({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } as const) : {};
  const copy = UI_COPY.saved;
  return (
    // data-decision-version (additive, lane 6's copy rule X-1 via the coordinator): the version the mark speaks of, while it shows one.
    <div className="ui-saved" data-decision-version={saved === null ? undefined : saved.version} {...region}>
      {saved === null ? null : (
        <>
          <span className="ui-saved__shape">{shape ?? <SavedShape size={24} />}</span>
          <p className="ui-saved__title">{copy.title(saved.version)}</p>
          <p className="ui-saved__when">
            {saved.decidedOn === null ? null : `${copy.decidedOn} ${formatDeclaredDate(saved.decidedOn)} · `}
            {`${copy.savedAt} `}{savedTime ?? <LocalTime at={saved.savedAt} />}
          </p>
          <p className="ui-saved__line">
            {copy.onPlatform}
            {saved.version > 1 ? (
              <span className="ui-saved__history">
                {` ${copy.keptBefore(saved.version - 1)}`}{historyLink ?? (historyHref ? <a href={historyHref}>{copy.keptLink}</a> : copy.keptLink)}.
              </span>
            ) : null}
          </p>
        </>
      )}
    </div>
  );
}
