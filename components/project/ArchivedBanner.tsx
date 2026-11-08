import type { ReactElement } from 'react';

/**
 * The banner every page of an archived project shows (UX-31, FR-PRJ-03): nothing in the project can be
 * changed, and who can undo that. Nothing for a live project.
 */
export function ArchivedBanner({ archived }: { archived: boolean }): ReactElement | null {
  if (!archived) return null;
  return (
    <div role="status" className="card">
      This project is archived. Nothing in it can be changed. Owners and admins can unarchive it from All projects.
    </div>
  );
}
