import type { ReactElement } from 'react';
import type { HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { ChangesSince } from '@/components/home/ChangesSince';
import { StagesOverview } from '@/components/home/StagesOverview';
import { FOLLOW_UP_TERMS, TermList } from '@/components/home/AssignedToYou';
import { AllProjects } from '@/components/home/ReviewerHome';

/**
 * A Viewer's Home (spec 9.1): what the team recorded in the last 14 days, and what is still open in each active project,
 * as the same stage plates a person who records sees, without the "Next:" line or the "you are here" stop. No next step
 * and no recording link (T9.5); a stage's name and a project's name still lead to their pages, which a Viewer reads.
 */
export function ViewerHome({ data }: { data: Extract<HomeData, { variant: 'viewer' }> }): ReactElement {
  const { base } = data;
  return (
    <div className="home-columns">
      <div className="home-column">
        <ChangesSince base={base} heading={HOME_COPY.viewerRecent} groups={data.recent.groups} more={data.recent.more} none={HOME_COPY.viewerRecentNone} />
      </div>
      <div className="home-column">
        <section className="home-section">
          <h2>{HOME_COPY.viewerOpen}</h2>
          <TermList terms={FOLLOW_UP_TERMS} />
          {data.open.map((p) => (
            <StagesOverview key={p.projectId} orgSlug={base.orgSlug} projectId={p.projectId} projectName={p.projectName} stages={p.stages} next={null} recording={false} heading="h3" />
          ))}
        </section>
        <AllProjects orgSlug={base.orgSlug} others={null} />
      </div>
    </div>
  );
}
