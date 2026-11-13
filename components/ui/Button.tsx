'use client';

import Link from 'next/link';
import type { MouseEvent, MouseEventHandler, ReactElement, ReactNode, Ref } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/types';
import './Button.css';

type Variant = 'primary' | 'secondary' | 'quiet' | 'destructive';

export type ButtonProps = {
  variant: Variant;
  /** `button` unless the caller submits a form with it. */
  type?: 'button' | 'submit';
  /**
   * Working: `aria-busy`, the label stays, a spinner shows, and the click's default action (a submit too) is prevented
   * and `onClick` is not called, while the button keeps its focus. The click still bubbles: a parent's listener sees
   * it with `defaultPrevented` true (no stopPropagation, which would break delegated and outside-click listeners).
   */
  busy?: boolean;
  disabled?: boolean;
  icon?: IconName;
  iconPosition?: 'start' | 'end';
  size?: 'default' | 'compact';
  onClick?: MouseEventHandler<HTMLButtonElement>;
  form?: string;
  name?: string;
  value?: string;
  'aria-describedby'?: string;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
};

export type ButtonLinkProps = {
  variant: Variant;
  /** An application path, passed to next/link as given: callers pass their own addresses, never a reader's input. */
  href: string;
  icon?: IconName;
  iconPosition?: 'start' | 'end';
  children: ReactNode;
};

function classesOf(variant: Variant, size: 'default' | 'compact'): string {
  return size === 'compact' ? `ui-button ui-button--${variant} ui-button--compact` : `ui-button ui-button--${variant}`;
}

/** The label with its icon on the chosen side. With no icon, the label alone: the button's direct text, no wrapper. */
function content(children: ReactNode, icon: IconName | undefined, iconPosition: 'start' | 'end'): ReactNode {
  if (icon === undefined) return children;
  const mark = <span className="ui-button__icon"><Icon name={icon} size={20} /></span>;
  return iconPosition === 'start' ? <>{mark}{children}</> : <>{children}{mark}</>;
}

/**
 * A button of the kit (plan 1A Task 4, spec 7.5): primary (the action orange, one per view), secondary, quiet, and
 * destructive (decision B6: the surface, ink and the control border, never orange and never red; the caller keeps it
 * away from the primary button). An error is the caller's StatusRegion's to show, never the button's.
 *
 * Busy is not disabled: a disabled button loses focus, and the person who pressed it would be left nowhere. A busy
 * button keeps focus, says `aria-busy="true"`, and its clicks do nothing (a submit is prevented too).
 */
export function Button({
  variant, type = 'button', busy = false, disabled = false, icon, iconPosition = 'start', size = 'default', onClick, form, name, value,
  'aria-describedby': ariaDescribedBy, children, ref,
}: ButtonProps): ReactElement {
  const handleClick = busy ? (event: MouseEvent<HTMLButtonElement>) => event.preventDefault() : onClick;
  return (
    <button
      ref={ref} className={classesOf(variant, size)} type={type} disabled={disabled} onClick={handleClick} form={form} name={name}
      value={value} aria-busy={busy ? true : undefined} aria-describedby={ariaDescribedBy}
    >
      {busy ? <span className="ui-button__spinner" aria-hidden="true" /> : null}
      {content(children, icon, iconPosition)}
    </button>
  );
}

/**
 * A link drawn as a button (next/link), for an action that goes to another address. It never prefetches, and there is
 * no prop to turn that on: Button.tsx is imported by most pages, and SRS 7.6.4 (UX-37) forbids a prefetching link in
 * any file a long-list page imports (__tests__/lint/no-prefetch-long-lists.test.ts accepts only a literal false).
 */
export function ButtonLink({ variant, href, icon, iconPosition = 'start', children }: ButtonLinkProps): ReactElement {
  return (
    <Link className={classesOf(variant, 'default')} href={href} prefetch={false}>
      {content(children, icon, iconPosition)}
    </Link>
  );
}
