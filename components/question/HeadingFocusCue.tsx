'use client';

import { useEffect } from 'react';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';

/**
 * Whether the person's last input was the keyboard. Module state, so it outlives a client navigation from one question
 * to the next (the Next link pressed with Enter, then the new question's heading takes focus). It starts false, so the
 * script focus on a full page load draws no ring. The coordinator's message of 09:45 EAT: "Keep a visible focus ring for
 * keyboard users (only the script focus on load loses it)".
 */
let keyboardLast = false;

/**
 * The focus cue of the question's heading (Shell gap 3, wide gap 18; coordinator's ruling 4). FocusOnArrival
 * (components/decision/FocusOnArrival.tsx, not changed) focuses the heading by script on every arrival, and Chrome
 * matches `:focus-visible` on a script focus when nothing had focus before, so a person who clicked a link saw a 3px
 * orange rectangle round the question. This island marks the heading `data-keyboard-focus` when it takes focus after
 * keyboard use, and unmarks it otherwise; workspace.css draws the ring only on the marked heading. It also sends the
 * skip link to the heading: Tab, Enter on "Skip to content" lands on the question, not on the main landmark around it.
 * Only the skip link's own activation does this: a press anywhere else in the page (which focuses the main landmark, a
 * tabindex="-1" element, on the way to a control) is left alone.
 * Rendered before FocusOnArrival, so its listeners are in place when that one's effect focuses the heading.
 */
export function HeadingFocusCue({ headingId }: { headingId: string }): null {
  useEffect(() => {
    const heading = document.getElementById(headingId);
    if (heading === null) {
      // The page renders the heading beside this island; without it neither the cue nor the skip link's target works.
      if (process.env.NODE_ENV !== 'production') console.error(`HeadingFocusCue: no element #${headingId}`);
      return undefined;
    }
    const onKey = (e: KeyboardEvent) => { if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardLast = true; };
    const onPointer = () => { keyboardLast = false; };
    const onFocus = () => { heading.toggleAttribute('data-keyboard-focus', keyboardLast); };
    const onBlur = () => { heading.removeAttribute('data-keyboard-focus'); };
    // The skip link (components/layout/SkipLink.tsx) points at the main landmark; on this page its target is the question.
    const onClick = (e: MouseEvent) => {
      const link = e.target instanceof Element ? e.target.closest('a') : null;
      if (link === null || link.getAttribute('href') !== `#${MAIN_CONTENT_ID}`) return;
      e.preventDefault();
      heading.focus();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('click', onClick);
    heading.addEventListener('focus', onFocus);
    heading.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('click', onClick);
      heading.removeEventListener('focus', onFocus);
      heading.removeEventListener('blur', onBlur);
    };
  }, [headingId]);
  return null;
}
