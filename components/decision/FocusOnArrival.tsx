'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * UX-42: on arriving at a question, by link or by Previous and Next, focus moves to its heading, so a keyboard
 * or screen-reader user starts at the new question and not at the link they pressed. The page is the same route
 * for every question, so the address, not a mount, is what changes.
 *
 * On a fresh load of the question (not a reload, not back or forward, no #fragment), the page starts at its top, so the
 * focus does not scroll: a person who scrolled before this effect ran is not pulled back (the D23 race). Every other
 * arrival scrolls as focus does by default, so the heading is on screen when it takes focus: Next, Previous or a link
 * (the page frame lives in the root layout and keeps its scroll), and a reload or back/forward, where the browser has
 * restored an old scroll position (the owner's choice, 22 Nov 2026: "Scroll heading into view").
 * e2e/focus-on-arrival.spec.ts pins both. The latch is the module's, not the component's, so it holds whether or not a
 * new question remounts this component, and it stays false through React Strict Mode's second run of the effect.
 */
let scrollFromNowOn = false;

/** The document was freshly loaded at this address: no reload, no back/forward, no #fragment, no client navigation since. */
function freshLoadHere(): boolean {
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry !== undefined && entry.type === 'navigate' && entry.name === location.href && location.hash === '';
}

export function FocusOnArrival({ targetId }: { targetId: string }): null {
  const pathname = usePathname();
  useEffect(() => {
    if (!freshLoadHere()) scrollFromNowOn = true;
    document.getElementById(targetId)?.focus(scrollFromNowOn ? undefined : { preventScroll: true });
  }, [targetId, pathname]);
  return null;
}
