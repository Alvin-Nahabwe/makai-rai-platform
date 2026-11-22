'use client';

import { useEffect, useRef, type ReactElement } from 'react';
import Link from 'next/link';
import './SavedArrival.css';

/**
 * The "saved" line a clean Save leaves at the top of the next question, or of the stage's end screen (answer cost, design 2 item 3).
 * It takes focus when it arrives, so a screen reader reads it where the person now is, and again when its words or its link change:
 * the next question, and the one after it, are the same route, so this element stays mounted from one arrival to the next. It is
 * `tabindex="-1"`: a place focus is sent to, never one Tab stops at. The ring is the browser's and the global one (app/globals.css),
 * not suppressed here. It holds only strings: SavedArrival (SavedArrival.tsx) writes the words on the server.
 */
export function SavedArrivalLine({ line, backText, href }: { line: string; backText: string; href: string }): ReactElement {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, [line, href]);
  return (
    <p ref={ref} tabIndex={-1} className="saved-arrival" data-saved-arrival>
      {line}{' '}<Link href={href} prefetch={false}>{backText}</Link>
    </p>
  );
}
