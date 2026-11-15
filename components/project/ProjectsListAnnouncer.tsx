'use client';

import { createContext, useContext, useState, type ReactElement, type ReactNode } from 'react';

/**
 * The value outside a Projects list: null, so a caller can tell there is no line to say anything in. UnarchiveProjectButton
 * is only placed inside the list; a unit test that renders it alone gets null and says nothing.
 */
const AnnounceContext = createContext<((line: string) => void) | null>(null);

/**
 * The Projects list's one polite status line (design review 16; spec 8 "every 'after' state says what happened"). It is in
 * the page from the first render, empty, so a screen reader announces the sentence written into it. It lives in this
 * client component, above the table, so it keeps its sentence across the `router.refresh()` that removes the Unarchive
 * control which wrote it: the refresh re-renders the server parts, and this component keeps its state.
 */
export function ProjectsListAnnouncer({ children }: { children: ReactNode }): ReactElement {
  const [line, setLine] = useState('');
  return (
    <AnnounceContext value={setLine}>
      <p role="status" className="projects-list__status">{line}</p>
      {children}
    </AnnounceContext>
  );
}

/** The list's announce function, or null outside a Projects list. */
export function useProjectsListAnnounce(): ((line: string) => void) | null {
  return useContext(AnnounceContext);
}
