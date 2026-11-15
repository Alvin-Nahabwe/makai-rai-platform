import type { ReactElement, ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import './Callout.css';

export type CalloutProps = {
  kind: 'note' | 'caution';
  title?: string;
  children: ReactNode;
};

/**
 * A note or a caution inside the content (plan 1A Task 6). Not a live region: it is part of the page, read in order. A
 * caution carries the triangle-alert icon and a 4 px heading-coloured border on its start side; the words carry the
 * meaning, so forced colours, which drop the tint, keep the border and the icon.
 */
export function Callout({ kind, title, children }: CalloutProps): ReactElement {
  return (
    <div className={`ui-callout ui-callout--${kind}`}>
      {kind === 'caution' ? <span className="ui-callout__icon"><Icon name="triangle-alert" /></span> : null}
      <div className="ui-callout__body">
        {title ? <p className="ui-callout__title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
