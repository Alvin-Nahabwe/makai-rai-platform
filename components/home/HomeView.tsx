import './home.css';
import type { ReactElement } from 'react';
import type { HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { LocalTime } from '@/components/ui/LocalTime';
import { WelcomeLine } from '@/components/home/WelcomeLine';
import { HomeUnsavedLine } from '@/components/home/HomeUnsavedLine';
import { NextStepCard } from '@/components/home/NextStepCard';
import { AssignedToYou } from '@/components/home/AssignedToYou';
import { ChangesSince } from '@/components/home/ChangesSince';
import { StagesOverview } from '@/components/home/StagesOverview';
import { TeamLeadAdditions } from '@/components/home/TeamLeadAdditions';
import { AllProjects, ReviewerHome } from '@/components/home/ReviewerHome';
import { ViewerHome } from '@/components/home/ViewerHome';
import { FirstTimeHome } from '@/components/home/FirstTimeHome';
import { SLOT, withSlot } from '@/components/home/parts';

type Recorder = Extract<HomeData, { variant: 'recorder' }>;

/**
 * The person who records (spec 9.1; sketch home.png), in the sketch's two columns from 1024 px: on the left the next
 * step, "Assigned to you" and "Since your last saved change"; on the right, an Owner's or Admin's lists above the
 * project's three stages, then the other projects. The document order is the reading order at every width, so on a narrow
 * screen the right column follows the left.
 */
function RecorderHome({ data }: { data: Recorder }): ReactElement {
  const { base } = data;
  return (
    <div className="home-columns">
      <div className="home-column">
        {data.next === null ? null : <NextStepCard orgSlug={base.orgSlug} next={data.next} />}
        <AssignedToYou base={base} items={data.assigned} />
        {data.since === null ? null : (
          <ChangesSince
            base={base} heading={withSlot(HOME_COPY.sinceHeading(SLOT), <LocalTime at={data.since.from} dateOnly />)}
            groups={data.since.groups} more={data.since.more} none={HOME_COPY.sinceNone}
          />
        )}
      </div>
      <div className="home-column">
        {data.lead === null ? null : <TeamLeadAdditions base={base} lead={data.lead} />}
        {data.focus === null ? null : (
          <StagesOverview
            orgSlug={base.orgSlug} projectId={data.focus.projectId} projectName={data.focus.projectName} stages={data.focus.stages}
            next={data.next} recording heading="h2"
          />
        )}
        <AllProjects orgSlug={base.orgSlug} others={data.otherProjects} />
      </div>
    </div>
  );
}

/** The sketch's lead under the welcome, only when the page holds all three things it names. */
function leadOf(data: HomeData): string | null {
  return data.variant === 'recorder' && data.next !== null && data.since !== null && data.focus !== null ? HOME_COPY.recorderLead : null;
}

/**
 * Home (spec 9.1, plan 1B Task 10): per organisation and per role, chosen on the server (`loadHome`, T9.5). Every variant
 * opens with the welcome as the page's one h1 ("Welcome back, <name>.", or after joining the welcome line with the role's
 * sentence), then this browser's unsaved-changes line, then the variant's own content. A server component; the unsaved
 * line is the one client island.
 */
export function HomeView({ data }: { data: HomeData }): ReactElement {
  const { base } = data;
  const lead = leadOf(data);
  return (
    <div className="home">
      <header className="home-hello">
        {base.welcome
          ? <WelcomeLine orgName={base.orgName} role={base.role} />
          : <h1 className="home-hello__title">{withSlot(HOME_COPY.welcomeBack(SLOT), <bdi>{base.userName}</bdi>)}</h1>}
        {!base.welcome && lead !== null ? <p className="home-hello__lead">{lead}</p> : null}
        <HomeUnsavedLine userId={base.userId} orgId={base.orgId} />
      </header>
      {data.variant === 'recorder' ? <RecorderHome data={data} />
        : data.variant === 'reviewer' ? <ReviewerHome data={data} />
          : data.variant === 'viewer' ? <ViewerHome data={data} />
            : <FirstTimeHome data={data} />}
    </div>
  );
}
