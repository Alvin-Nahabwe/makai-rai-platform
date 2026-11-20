import type { ReactElement } from 'react';
import type { HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { ButtonLink } from '@/components/ui/Button';
import { ListLink } from '@/components/ui/ListLink';
import { Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { PROJECT_COPY } from '@/lib/project/copy';
import { TERM_RISK_AREA, TERM_WORKING_REPORT } from '@/lib/vocabulary/terms';

/**
 * First visit, or no active project yet (spec 9.1; review M13): one sentence on what the platform is for, then one
 * action: "Create a project" for a role that can create one, or the sentence that says who can. An organisation whose
 * projects are all archived is told where they are (B#31), with the way to them.
 */
export function FirstTimeHome({ data }: { data: Extract<HomeData, { variant: 'first-time' }> }): ReactElement {
  const { base } = data;
  return (
    <div className="home-first">
      <p className="home-first__lead">{HOME_COPY.firstTimeLead}</p>
      {/* G5: "working report" and "risk area" are first used here, so each is marked and defined beside it, as on the project page (final review M3). */}
      <p className="home-first__gets">
        <Term of={TERM_WORKING_REPORT}><Term of={TERM_RISK_AREA}>{HOME_COPY.whatYouGet}</Term></Term>
        <TermTip of={TERM_WORKING_REPORT} label={PROJECT_COPY.whatMeans(TERM_WORKING_REPORT.term)} />
        <TermTip of={TERM_RISK_AREA} label={PROJECT_COPY.whatMeans(TERM_RISK_AREA.term)} />
      </p>
      {base.archivedCount > 0 ? (
        <p>{HOME_COPY.noActiveProjects} <ListLink href={`/orgs/${base.orgSlug}/projects`}>{HOME_COPY.allProjects}</ListLink></p>
      ) : null}
      {data.canCreate
        ? <div className="home-first__action"><ButtonLink variant="primary" href={`/orgs/${base.orgSlug}/projects/new`}>{HOME_COPY.firstTimeCreate}</ButtonLink></div>
        : <p>{HOME_COPY.firstTimeAsk}</p>}
    </div>
  );
}
