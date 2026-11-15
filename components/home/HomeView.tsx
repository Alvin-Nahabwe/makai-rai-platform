import './home.css';
import { Fragment, type ReactElement } from 'react';
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
import { firstUsesOf, recorderColumns, type FirstUses, type RecorderSection } from '@/components/home/firstUse';
import { SLOT, withSlot } from '@/components/home/parts';

type Recorder = Extract<HomeData, { variant: 'recorder' }>;

/**
 * The person who records (spec 9.1; sketch home.png), in two columns from 1024 px, laid out by `recorderColumns`: with a
 * next step, the sketch's composition (left: next step, "Assigned to you", "Since…"; right: an Owner's or Admin's lists,
 * then the project's stages); without one, the stages and the lead lists take the left, main column (fix round 2, #8).
 * The document order is the reading order at every width; on a narrow screen the second column follows the first.
 */
function RecorderHome({ data, uses }: { data: Recorder; uses: FirstUses }): ReactElement {
  const { base } = data;
  const section = (s: RecorderSection): ReactElement | null => {
    switch (s) {
      case 'next': return data.next === null ? null : <NextStepCard key={s} orgSlug={base.orgSlug} next={data.next} />;
      case 'assigned': return <AssignedToYou key={s} base={base} items={data.assigned} uses={uses} />;
      case 'since': return data.since === null ? null : (
        <ChangesSince
          key={s} base={base} heading={withSlot(HOME_COPY.sinceHeading(SLOT), <LocalTime at={data.since.from} dateOnly />)}
          groups={data.since.groups} more={data.since.more} none={HOME_COPY.sinceNone} uses={uses} terms="terms:since"
        />
      );
      case 'lead': return data.lead === null ? null : <TeamLeadAdditions key={s} base={base} lead={data.lead} uses={uses} />;
      case 'stages': return (
        <Fragment key={s}>
          {data.focus === null ? null : (
            <StagesOverview
              orgSlug={base.orgSlug} projectId={data.focus.projectId} projectName={data.focus.projectName} stages={data.focus.stages}
              next={data.next} recording heading="h2" uses={uses}
            />
          )}
          <AllProjects orgSlug={base.orgSlug} others={data.otherProjects} />
        </Fragment>
      );
      default: {
        const unknown: never = s;
        throw new Error(`RecorderHome: no section ${String(unknown)}`);
      }
    }
  };
  const [first, second] = recorderColumns(data);
  return (
    <div className="home-columns">
      <div className="home-column">{first.map(section)}</div>
      <div className="home-column">{second.map(section)}</div>
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
  // Where each defined term is first used, in reading order (spec 6): the components draw the definitions there.
  const uses = firstUsesOf(data);
  return (
    <div className="page-content home">
      <header className="home-hello">
        {base.welcome
          ? <WelcomeLine orgName={base.orgName} role={base.role} />
          : <h1 className="home-hello__title">{withSlot((data.variant === 'first-time' ? HOME_COPY.welcomeFirst : HOME_COPY.welcomeBack)(SLOT), <bdi>{base.userName}</bdi>)}</h1>}
        {!base.welcome && lead !== null ? <p className="home-hello__lead">{lead}</p> : null}
        <HomeUnsavedLine userId={base.userId} orgId={base.orgId} />
      </header>
      {data.variant === 'recorder' ? <RecorderHome data={data} uses={uses} />
        : data.variant === 'reviewer' ? <ReviewerHome data={data} uses={uses} />
          : data.variant === 'viewer' ? <ViewerHome data={data} uses={uses} />
            : <FirstTimeHome data={data} />}
    </div>
  );
}
