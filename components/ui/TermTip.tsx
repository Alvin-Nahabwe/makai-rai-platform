'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import { Definition } from '@/components/ui/Definition';
import { Icon } from '@/components/ui/Icon';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { termTipIds } from '@/components/ui/termTipIds';
import './TermTip.css';

export type TermTipProps = {
  /** The vocabulary entry whose definition the tip shows, verbatim (lib/vocabulary/terms.ts; `Definition` refuses an undefined one). */
  of: DefinedEntry;
  /** The button's accessible name, from the caller's copy module, e.g. "What is a finding?". The icon alone is not a name. */
  label: string;
  /** Unique on the page when the same term has two tips; defaults to `term-tip-<entry id>`. `termTipIds` (components/ui/termTipIds.ts) gives both ids. */
  id?: string;
};

/** The part of a popover element the tip drives (a structural type, so a test can hand in a stand-in). */
export type TipPopover = { hidePopover(): void; matches(selector: string): boolean };

/**
 * Closes `tip` when focus leaves `button` (the toggletip pattern: coordinator's ruling, fix round 2), except when the
 * person pressed inside the open tip, so its sentence can be selected and copied. Focus alone never opens the tip: a
 * click, a tap, or Enter or Space on the button opens it and a second press closes it (the button's `popovertarget`,
 * toggling); Escape and a press elsewhere close it (the popover's own light dismiss). Returns the cleanup.
 */
export function closeOnBlur(
  button: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  tip: TipPopover & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
): () => void {
  let pressedInside = false;
  const press = () => { pressedInside = true; };
  // The flag lives only for the press: a browser that does not focus a button on a click (Safari, Firefox on macOS)
  // sends no blur, and a second press after the first blur would otherwise leave it set for a later focus-leave.
  const release = () => { pressedInside = false; };
  const hide = () => {
    if (pressedInside) return;
    if (tip.matches(':popover-open')) tip.hidePopover();
  };
  // A press inside the tip blurs the button before the click lands; the pointerdown on the tip comes first, its pointerup
  // (or pointercancel) after the blur.
  tip.addEventListener('pointerdown', press);
  tip.addEventListener('pointerup', release);
  tip.addEventListener('pointercancel', release);
  button.addEventListener('blur', hide);
  return () => {
    tip.removeEventListener('pointerdown', press);
    tip.removeEventListener('pointerup', release);
    tip.removeEventListener('pointercancel', release);
    button.removeEventListener('blur', hide);
  };
}

/**
 * A term's definition one step away (spec 6, the owner's ruling of 15 November 2026, 11:00): a small (i) button, a 24px
 * target, right after the term. It is a toggletip (coordinator's ruling, fix round 2): a click, a tap, or Enter or Space
 * on the focused button opens the vocabulary's own sentence for it in a popover, and a second press, Escape, a press
 * elsewhere or focus leaving closes it. Focus alone does not open it, so a Tab passing through opens nothing. The button
 * is named by `label` and described by the definition, so a screen reader hears both on focus; the definition is the
 * `Definition` component, so it is the data/vocabulary.json sentence word for word.
 *
 * The popover is placed under its button where the browser supports anchor positioning and `anchor-scope` (which keeps
 * each tip's anchor its own), and centred by the browser elsewhere. Without script every press still works
 * (`popovertarget`); only closing on blur needs the script. Styles: components/ui/TermTip.css (colour roles and spaces
 * only, both themes; hidden in print).
 */
export function TermTip({ of, label, id }: TermTipProps): ReactElement {
  const { tip: tipId, definition: definitionId } = termTipIds(of, id);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (button.current === null || tip.current === null) return undefined;
    return closeOnBlur(button.current, tip.current);
  }, []);
  return (
    <span className="ui-term-tip">
      <button ref={button} type="button" className="ui-term-tip__button" popoverTarget={tipId} popoverTargetAction="toggle"
        aria-label={label} aria-describedby={definitionId}>
        <Icon name="info" size={16} />
      </button>
      <span ref={tip} id={tipId} popover="auto" className="ui-term-tip__body">
        <Definition of={of} id={definitionId} />
      </span>
    </span>
  );
}
