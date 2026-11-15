import type { ReactElement } from 'react';
import type { HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { ButtonLink } from '@/components/ui/Button';
import { ListLink } from '@/components/ui/ListLink';

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
      {base.archivedCount > 0 ? (
        <p>{HOME_COPY.noActiveProjects} <ListLink href={`/orgs/${base.orgSlug}/projects`}>{HOME_COPY.allProjects}</ListLink></p>
      ) : null}
      {data.canCreate
        ? <div className="home-first__action"><ButtonLink variant="primary" href={`/orgs/${base.orgSlug}/projects/new`}>{HOME_COPY.firstTimeCreate}</ButtonLink></div>
        : <p>{HOME_COPY.firstTimeAsk}</p>}
    </div>
  );
}
