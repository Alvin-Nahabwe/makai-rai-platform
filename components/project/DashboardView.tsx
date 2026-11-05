import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { WelcomeNotice } from '@/components/account/WelcomeNotice';
import { ProjectCard } from '@/components/dashboard/ProjectCard';
import { MyMitigationsList } from '@/components/project/MyMitigationsList';
import type { DashboardData } from '@/lib/data/projects';

export type { DashboardData } from '@/lib/data/projects';

/**
 * S-08, the dashboard (FR-PRJ-04, FR-FUP-02, UX-06; SRS 7.4.2 row S-08): the welcome notice when the query asks for it,
 * the active projects with their per-stage counts, a link to the archived ones, and the person's own open mitigations.
 */
export function DashboardView({ data }: { data: DashboardData }): ReactElement {
  const newProject = `/orgs/${data.orgSlug}/projects/new`;
  return (
    <div className="page-content">
      {data.welcome ? <WelcomeNotice orgName={data.orgName} role={data.role} /> : null}
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p className="text-muted">Overdue is counted in East Africa Time (UTC+3).</p>
        </div>
        {data.canCreate ? <ListLink href={newProject} className="btn btn--primary">New project</ListLink> : null}
      </div>

      <section className="dashboard-section" aria-labelledby="active-projects">
        <h2 id="active-projects">Active projects</h2>
        {data.projects.length === 0 ? (
          data.archivedCount > 0
            ? (data.canCreate ? <p>No active projects. <ListLink href={newProject}>New project</ListLink></p> : <p>No active projects.</p>)
            : data.canCreate
              ? <p>No projects yet. <ListLink href={newProject}>New project</ListLink></p>
              : <p>No projects yet. Owners, admins and assessors can create one.</p>
        ) : (
          <div className="projects-grid">
            {data.projects.map((p) => <ProjectCard key={p.project.id} orgSlug={data.orgSlug} project={p.project} counts={p.counts} />)}
          </div>
        )}
        <p><ListLink href={`/orgs/${data.orgSlug}/projects`}>Archived projects</ListLink></p>
      </section>

      <section className="dashboard-section" aria-labelledby="my-mitigations">
        <h2 id="my-mitigations">My open and overdue mitigations</h2>
        <MyMitigationsList orgSlug={data.orgSlug} items={data.mine} projectNames={data.projectNames} />
      </section>
    </div>
  );
}
