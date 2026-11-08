'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * UX-42: on arriving at a question, by link or by Previous and Next, focus moves to its heading, so a keyboard
 * or screen-reader user starts at the new question and not at the link they pressed. The page is the same route
 * for every question, so the address, not a mount, is what changes.
 */
export function FocusOnArrival({ targetId }: { targetId: string }): null {
  const pathname = usePathname();
  useEffect(() => {
    document.getElementById(targetId)?.focus();
  }, [targetId, pathname]);
  return null;
}
