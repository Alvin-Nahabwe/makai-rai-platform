import type { ReactElement, ReactNode } from 'react';
import { STAGES } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageColumn } from '@/components/project/StageColumn';
import { ArchiveProjectControl } from '@/components/project/ArchiveProjectControl';
import { StageFollowUp } from '@/components/followup/StageFollowUp';
import { StageReviewsSummary } from '@/components/review/StageReviewsSummary';
import type { ProjectOverviewData } from '@/lib/data/projects';

export type { ProjectOverviewData } from '@/lib/data/projects';

const SHORT = { 'pre-processing': 'Pre', 'in-processing': 'In', 'post-processing': 'Post' } as const;

/**
 * S-10, the stage view (FR-PRJ-02, FR-PRJ-03; SRS W-1): the project's name and one descriptive line, the actions the
 * role may take, then the three stages side by side with each stage's follow-up and stage reviews. A synchronous view
 * of loaded data (the page file loads it), so it renders the same on the server and in a test.
 */
export function ProjectOverview({ data, children }: { data: ProjectOverviewData; children?: ReactNode }): ReactElement {
  const { orgSlug, project, can } = data;
  const base = `/orgs/${orgSlug}/projects/${project.id}`;
  return (
    <div className="page-content">
      <nav aria-label="Breadcrumb">
        <ListLink href={`/orgs/${orgSlug}/dashboard`}>{data.orgName}</ListLink> &gt; <span aria-current="page">{project.name}</span>
      </nav>
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          {project.descriptiveLine !== '' ? <p>{project.descriptiveLine}</p> : null}
          <p className="text-muted">Stages can be recorded in any order.</p>
        </div>
        <div className="form-actions">
          {can.update ? <ListLink href={`${base}/edit`} className="btn btn--secondary">Edit project</ListLink> : null}
          {can.export ? <ListLink href={`${base}/export`} className="btn btn--secondary">Export project</ListLink> : null}
          {can.archiveControl ? (
            <ArchiveProjectControl orgSlug={orgSlug} projectId={project.id} projectName={project.name} archived={project.archived} />
          ) : null}
        </div>
      </div>
      <ArchivedBanner archived={project.archived} />
      <div className="stage-list">
        <nav className="stage-list__jump" aria-label="Jump to a stage">
          {STAGES.map((s) => <a key={s} href={`#${s}`}>{SHORT[s]}</a>)}
        </nav>
        <div className="stage-list__columns">
          {STAGES.map((s) => (
            <StageColumn key={s} orgSlug={orgSlug} projectId={project.id} stage={s} counts={data.counts[s]}>
              <StageFollowUp orgSlug={orgSlug} projectId={project.id} stage={s} items={data.followUp[s].items} cannotAct={data.followUp[s].cannotAct} />
              <StageReviewsSummary orgSlug={orgSlug} projectId={project.id} stage={s} reviews={data.reviews[s]} canOpen={can.openReview} />
            </StageColumn>
          ))}
        </div>
      </div>
      <p className="text-muted">To share your record outside the team, seal a stage review and create a document from it.</p>
      <p><ListLink href={`${base}/findings`}>Findings for this project</ListLink></p>
      {children}
    </div>
  );
}
