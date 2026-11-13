import type { ReactElement, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/types';
import './Banner.css';

type BannerKind = 'offline' | 'archived' | 'session' | 'info';

export type BannerProps = {
  kind: BannerKind;
  title?: string;
  children: ReactNode;
  /** Any node: a next/link Link, an <a> or a ButtonLink ("Sign in again"), rendered in __action as given. */
  action?: ReactNode;
};

const ICON_OF: Readonly<Record<BannerKind, IconName>> = { offline: 'wifi-off', archived: 'archive', session: 'clock', info: 'info' };

/**
 * A notice about the whole page or the session (plan 1A Task 6): no connection, an archived project, the session, or
 * information. The icon and the words carry the kind; the tint is decoration, so forced colours lose nothing. It is
 * ordinary flow content, nothing fixed or sticky, and it is not a live region: a caller that must announce it puts it
 * inside its own always-mounted region (OfflineBanner).
 */
export function Banner({ kind, title, children, action }: BannerProps): ReactElement {
  return (
    <div className={`ui-banner ui-banner--${kind}`}>
      <span className="ui-banner__icon"><Icon name={ICON_OF[kind]} /></span>
      <div className="ui-banner__body">
        {title === undefined ? null : <p className="ui-banner__title">{title}</p>}
        {children}
      </div>
      {action === undefined ? null : <div className="ui-banner__action">{action}</div>}
    </div>
  );
}
