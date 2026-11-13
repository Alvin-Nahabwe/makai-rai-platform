'use client';

import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import { LocalTime } from '@/components/ui/LocalTime';
import { formatDeclaredDate } from '@/lib/format/dates';
import { UI_COPY } from '@/lib/ui/copy';
import type { DeclaredDate, UtcInstant } from '@/types/record';
import './SavedMark.css';

export type SavedMarkProps = {
  saved: { version: number; savedAt: UtcInstant; decidedOn: DeclaredDate | null } | null;
  historyHref?: string;
  /** Default true. False drops the live-region attributes, for a form whose own status line already announces the save. */
  live?: boolean;
};

/**
 * The saved mark (spec 7.3): after a save, the saved shape, "Saved as version n", the decided and saved dates labelled
 * apart, and the line saying the decision is on the platform with the earlier version in the history. It is always
 * mounted and empty while nothing is saved, so a polite live region exists before its words arrive and announces them.
 */
export function SavedMark({ saved, historyHref, live = true }: SavedMarkProps): ReactElement {
  const region = live ? ({ role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } as const) : {};
  const copy = UI_COPY.saved;
  return (
    <div className="ui-saved" {...region}>
      {saved === null ? null : (
        <>
          <span className="ui-saved__shape"><Icon name="circle-check" size={24} /></span>
          <p className="ui-saved__title">{copy.title(saved.version)}</p>
          <p className="ui-saved__when">
            {saved.decidedOn === null ? null : `${copy.decidedOn} ${formatDeclaredDate(saved.decidedOn)} · `}
            {`${copy.savedAt} `}<LocalTime at={saved.savedAt} />
          </p>
          <p className="ui-saved__line">
            {copy.onPlatform}
            {saved.version > 1 ? (
              <span className="ui-saved__history">
                {` ${copy.keptBefore(saved.version - 1)}`}{historyHref ? <a href={historyHref}>{copy.keptLink}</a> : copy.keptLink}.
              </span>
            ) : null}
          </p>
        </>
      )}
    </div>
  );
}
