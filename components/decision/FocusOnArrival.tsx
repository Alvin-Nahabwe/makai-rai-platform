'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * UX-42: on arriving at a question, by link or by Previous and Next, focus moves to its heading, so a keyboard
 * or screen-reader user starts at the new question and not at the link they pressed. The page is the same route
 * for every question, so the address, not a mount, is what changes.
 *
 * When the question is the page the document loaded, and this is its first arrival, the focus does not scroll: the page
 * is already at its top, and a person who scrolled before this effect ran is not pulled back (the D23 race). Every other
 * arrival (Next, Previous, or a link from another page) scrolls as focus does by default: the page frame lives in the
 * root layout and keeps its scroll, so that is what brings the new heading into view (e2e/focus-on-arrival.spec.ts). The
 * flag is the module's, not the component's, so it holds whether or not a new question remounts this component.
 */
let arrivedBefore = false;

/** This address is the one the document loaded (no client navigation brought the person here). */
function loadedHere(): boolean {
  const entry = performance.getEntriesByType('navigation')[0];
  return entry !== undefined && entry.name === location.href;
}

export function FocusOnArrival({ targetId }: { targetId: string }): null {
  const pathname = usePathname();
  useEffect(() => {
    const still = !arrivedBefore && loadedHere();
    arrivedBefore = true;
    document.getElementById(targetId)?.focus(still ? { preventScroll: true } : undefined);
  }, [targetId, pathname]);
  return null;
}
