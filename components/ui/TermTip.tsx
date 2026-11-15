'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { Definition } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import './TermTip.css';

export type TermTipProps = {
  /** The vocabulary entry whose definition the tip shows, verbatim (lib/vocabulary/terms.ts; `Definition` refuses an undefined one). */
  of: DefinedEntry;
  /** The button's accessible name, from the caller's copy module, e.g. "What is a finding?". The icon alone is not a name. */
  label: string;
  /** Unique on the page when the same term has two tips; defaults to the entry's id. The definition's element id is `${id}-def`. */
  id?: string;
};

/** The part of a popover element the tip drives (a structural type, so a test can hand in a stand-in). */
export type TipPopover = { showPopover(): void; hidePopover(): void; matches(selector: string): boolean };

/**
 * Opens `tip` while `button` has focus and closes it when focus leaves: keyboard focus shows the definition without a
 * press. A tap or click also opens it, through the button's `popovertarget` (action "show", so a click after the focus
 * does not close it again). Escape and a press elsewhere close it (the popover's own light dismiss). Returns the cleanup.
 */
export function openOnFocus(button: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>, tip: TipPopover): () => void {
  const show = () => { if (!tip.matches(':popover-open')) tip.showPopover(); };
  const hide = () => { if (tip.matches(':popover-open')) tip.hidePopover(); };
  button.addEventListener('focus', show);
  button.addEventListener('blur', hide);
  return () => {
    button.removeEventListener('focus', show);
    button.removeEventListener('blur', hide);
  };
}

/**
 * A term's definition one step away (spec 6, the owner's ruling of 15 November 2026, 11:00): a small (i) button, a 24px
 * target, right after the term, that opens the vocabulary's own sentence for it in a popover on keyboard focus and on a
 * tap or click. The button is named by `label` and described by the definition, so a screen reader hears both; the
 * definition is the `Definition` component, so it is the data/vocabulary.json sentence word for word.
 *
 * The popover is placed under its button where the browser supports anchor positioning (`anchor-scope` keeps each tip's
 * anchor its own) and centred by the browser elsewhere. Without script a press still opens it (`popovertarget`); focus
 * opening needs the script. Styles: components/ui/TermTip.css (colour roles and spaces only, both themes).
 */
export function TermTip({ of, label, id }: TermTipProps): ReactElement {
  const tipId = id ?? `term-tip-${of.id}`;
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (button.current === null || tip.current === null) return undefined;
    return openOnFocus(button.current, tip.current);
  }, []);
  return (
    <span className="ui-term-tip">
      <button ref={button} type="button" className="ui-term-tip__button" popoverTarget={tipId} popoverTargetAction="show"
        aria-label={label} aria-describedby={`${tipId}-def`}>
        <Icon name="info" size={16} />
      </button>
      <span ref={tip} id={tipId} popover="auto" className="ui-term-tip__body">
        <Definition of={of} id={`${tipId}-def`} />
      </span>
    </span>
  );
}
