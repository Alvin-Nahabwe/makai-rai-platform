'use client';

import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from 'react';

/** A sentence about one project, waiting until the rendered list shows that project as no longer archived. */
export type PendingLine = { projectId: string; sentence: string };

/** What the Projects list offers its Unarchive controls. */
export type ProjectsListAnnounce = {
  /** Say `sentence` once the list, refreshed, no longer renders `projectId` among its archived rows. */
  sayWhenActive: (projectId: string, sentence: string) => void;
  /** Empty the line (a new Unarchive has started). */
  clear: () => void;
};

/**
 * The value outside a Projects list: null, so a caller can tell there is no line to say anything in. UnarchiveProjectButton
 * is only placed inside the list, and logs when it finds none; a unit test that renders it alone gets null.
 */
const AnnounceContext = createContext<ProjectsListAnnounce | null>(null);

/**
 * The line to show (re-review N1): a pending sentence is said only once the list rendered from the server no longer has its
 * project among the archived rows, so the line never says "active again" over a row that still reads Archived. Before the
 * refresh lands the project is still in `archivedIds` (its Unarchive was on an archived row); after it, it is not, whether
 * the refreshed page shows it among the active rows or past the shown page.
 */
export function announcedLine(pending: PendingLine | null, archivedIds: readonly string[]): string {
  return pending !== null && !archivedIds.includes(pending.projectId) ? pending.sentence : '';
}

/**
 * The Projects list's one polite status line (design review 16; spec 8 "every 'after' state says what happened"). It is in
 * the page from the first render, empty, so a screen reader announces the sentence when it appears. It lives in this
 * client component, above the table, so it keeps its pending sentence across the `router.refresh()` that removes the
 * Unarchive control which asked for it; the refresh hands it the new `archivedIds`, and the sentence shows then.
 */
export function ProjectsListAnnouncer({ archivedIds, children }: { archivedIds: readonly string[]; children: ReactNode }): ReactElement {
  const [pending, setPending] = useState<PendingLine | null>(null);
  const value = useMemo<ProjectsListAnnounce>(() => ({
    sayWhenActive: (projectId, sentence) => setPending({ projectId, sentence }),
    clear: () => setPending(null),
  }), []);
  return (
    <AnnounceContext value={value}>
      <p role="status" className="projects-list__status">{announcedLine(pending, archivedIds)}</p>
      {children}
    </AnnounceContext>
  );
}

/** The list's announce functions, or null outside a Projects list. */
export function useProjectsListAnnounce(): ProjectsListAnnounce | null {
  return useContext(AnnounceContext);
}
