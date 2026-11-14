import './DashboardView.css';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { WelcomeNotice } from '@/components/account/WelcomeNotice';
import { ProjectCard } from '@/components/dashboard/ProjectCard';
import { MyMitigationsList } from '@/components/project/MyMitigationsList';
import { NextStepCard } from '@/components/home/NextStepCard';
import type { DashboardData } from '@/lib/data/projects';
import { HOME_COPY } from '@/lib/home/copy';
import type { NextStep } from '@/lib/home/types';

export type { DashboardData } from '@/lib/data/projects';

/**
 * S-08, Home (FR-PRJ-04, FR-FUP-02, UX-06; SRS 7.4.2 row S-08): the welcome notice when the query asks for it,
 * the active projects with their per-stage counts, a link to all projects, and the mitigations assigned to the person.
 * With no project at all a creator keeps the second "New project" link in the empty line (audit B#32; register D-396,
 * plan 1B); with archived projects only, the line is plain text and the All projects link after it is the way on.
 * `next`, the person's next step (plan 1B rule C2), shows above the active projects when there is one; a Reviewer's or a
 * Viewer's is always null, so their Home has no next step and no recording link.
 */
export function DashboardView({ data, next }: { data: DashboardData; next?: NextStep | null }): ReactElement {
  const newProject = `/orgs/${data.orgSlug}/projects/new`;
  return (
    <div className="page-content">
      {data.welcome ? <WelcomeNotice orgName={data.orgName} role={data.role} /> : null}
      <PageHeader
        title={HOME_COPY.heading}
        actions={data.canCreate ? <ButtonLink variant="primary" href={newProject}>{HOME_COPY.newProject}</ButtonLink> : null}
      />

      {next ? <NextStepCard orgSlug={data.orgSlug} next={next} /> : null}

      <section className="dashboard-section" aria-labelledby="active-projects">
        <h2 id="active-projects">{HOME_COPY.activeProjects}</h2>
        {data.projects.length === 0 ? (
          data.archivedCount > 0
            ? <p>{HOME_COPY.noActiveProjects}</p>
            : data.canCreate
              ? <p>{HOME_COPY.noProjects} <ListLink href={newProject}>{HOME_COPY.newProject}</ListLink></p>
              : <p>{`${HOME_COPY.noProjects} ${HOME_COPY.whoCanCreate}`}</p>
        ) : (
          <div className="projects-grid">
            {data.projects.map((p) => <ProjectCard key={p.project.id} orgSlug={data.orgSlug} project={p.project} counts={p.counts} />)}
          </div>
        )}
        <p><ListLink href={`/orgs/${data.orgSlug}/projects`}>{HOME_COPY.allProjects}</ListLink></p>
      </section>

      <section className="dashboard-section" aria-labelledby="my-mitigations">
        <h2 id="my-mitigations">{HOME_COPY.myMitigations}</h2>
        <MyMitigationsList orgSlug={data.orgSlug} items={data.mine} projectNames={data.projectNames} />
      </section>
    </div>
  );
}
