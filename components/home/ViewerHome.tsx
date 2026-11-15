import type { ReactElement } from 'react';
import type { HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { AssignedToYou } from '@/components/home/AssignedToYou';
import { ChangesSince } from '@/components/home/ChangesSince';
import { StagesOverview } from '@/components/home/StagesOverview';
import { AllProjects } from '@/components/home/ReviewerHome';
import type { FirstUses } from '@/components/home/firstUse';

/**
 * A Viewer's Home (spec 9.1): the mitigations assigned to them when there are any (their own work; lane lead, fix
 * round 1), what the team recorded in the last 14 days, and what is still open in each active project, as the same stage
 * plates a person who records sees, without the "Next:" line or the "you are here" stop. No next step and no recording
 * link (T9.5); a stage's name and a project's name still lead to their pages, which a Viewer reads.
 */
export function ViewerHome({ data, uses }: { data: Extract<HomeData, { variant: 'viewer' }>; uses: FirstUses }): ReactElement {
  const { base } = data;
  return (
    <div className="home-columns">
      <div className="home-column">
        {data.assigned.length === 0 ? null : <AssignedToYou base={base} items={data.assigned} uses={uses} />}
        <ChangesSince base={base} heading={HOME_COPY.viewerRecent} groups={data.recent.groups} more={data.recent.more} none={HOME_COPY.viewerRecentNone} uses={uses} terms="terms:recent" />
      </div>
      <div className="home-column">
        <section className="home-section">
          <h2>{HOME_COPY.viewerOpen}</h2>
          {data.open.map((p) => (
            <StagesOverview
              key={p.projectId} orgSlug={base.orgSlug} projectId={p.projectId} projectName={p.projectName} stages={p.stages}
              next={null} recording={false} heading="h3" uses={uses}
            />
          ))}
        </section>
        <AllProjects orgSlug={base.orgSlug} others={null} />
      </div>
    </div>
  );
}
