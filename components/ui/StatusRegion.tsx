import type { ReactElement } from 'react';
import { Icon } from '@/components/ui/Icon';
import './formStyles';

export type StatusRegionProps = {
  /** The sentence to announce; null while there is nothing to say. */
  message: string | null;
  /** Polite (`role="status"`) unless the result stops the person from going on (`role="alert"`). Fixed for the region's life: a role changed in place can lose the message sent with it. */
  politeness?: 'polite' | 'assertive';
  id?: string;
  /** An error is ink, bold, with the triangle-alert icon (decision B5): never red. */
  tone?: 'neutral' | 'error';
};

/**
 * The line that announces the result of an action (plan 1A Task 6, WCAG 4.1.3). It is always in the page and empty until
 * there is a message: a live region inserted already holding its text is often not announced. The message is rendered
 * as given, as text. The same message twice in a row is not announced again unless the caller clears it (null) between.
 */
export function StatusRegion({ message, politeness = 'polite', id, tone = 'neutral' }: StatusRegionProps): ReactElement {
  return (
    <div role={politeness === 'assertive' ? 'alert' : 'status'} id={id} className={tone === 'error' ? 'ui-status ui-status--error' : 'ui-status'}>
      {message !== null && message !== '' && tone === 'error' ? <span className="ui-status__icon"><Icon name="triangle-alert" size={20} /></span> : null}
      {tone === 'error' && message !== null && message !== '' ? <span className="ui-status__text">{message}</span> : message}
    </div>
  );
}
