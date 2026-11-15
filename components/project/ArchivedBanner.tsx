import type { ReactElement } from 'react';
import { Banner } from '@/components/ui/Banner';
import { OrgProjectsLink } from '@/components/project/OrgProjectsLink';
import { PROJECT_COPY } from '@/lib/project/copy';

/**
 * The banner every page of an archived project shows (UX-31, FR-PRJ-03): nothing in the project can be changed, and
 * who can undo that. Nothing for a live project. The kit's Banner is not a live region, so the wrapper keeps
 * `role="status"`, which readers and tests rely on. The words "All projects page" link to the organisation's projects, for
 * every viewer (S5-1); the sentence is PROJECT_COPY.archivedBanner, split in archivedBannerParts.
 */
const B = PROJECT_COPY.archivedBannerParts;

export function ArchivedBanner({ archived }: { archived: boolean }): ReactElement | null {
  if (!archived) return null;
  return (
    <div role="status">
      <Banner kind="archived">{B.before}<OrgProjectsLink>{B.link}</OrgProjectsLink>{B.after}</Banner>
    </div>
  );
}
