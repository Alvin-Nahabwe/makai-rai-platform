import type { ReactElement, ReactNode } from 'react';
import { STAGES } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { ButtonLink } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageColumn, STAGE_NAME } from '@/components/project/StageColumn';
import { ArchiveProjectControl } from '@/components/project/ArchiveProjectControl';
import { StageFollowUp } from '@/components/followup/StageFollowUp';
import { StageReviewsSummary } from '@/components/review/StageReviewsSummary';
import type { ProjectOverviewData } from '@/lib/data/projects';
import { PROJECT_COPY } from '@/lib/project/copy';

export type { ProjectOverviewData } from '@/lib/data/projects';

const C = PROJECT_COPY.overview;

/**
 * S-10, the stage view (FR-PRJ-02, FR-PRJ-03; SRS W-1): the kit's page header (breadcrumb, the project's name, one
 * descriptive line, the actions the role may take), then the three stages side by side with each stage's follow-up and
 * stage reviews. A synchronous view of loaded data (the page file loads it), so it renders the same on the server and in
 * a test.
 */
export function ProjectOverview({ data, children }: { data: ProjectOverviewData; children?: ReactNode }): ReactElement {
  const { orgSlug, project, can } = data;
  const base = `/orgs/${orgSlug}/projects/${project.id}`;
  return (
    <div className="page-content">
      <PageHeader
        breadcrumb={[{ label: data.orgName, href: `/orgs/${orgSlug}/dashboard` }, { label: project.name }]}
        title={project.name}
        lead={(
          <>
            {project.descriptiveLine !== '' ? <p>{project.descriptiveLine}</p> : null}
            <p className="text-muted">{C.anyOrder}</p>
          </>
        )}
        actions={(
          <>
            {can.update ? <ButtonLink variant="secondary" href={`${base}/edit`}>{C.editProject}</ButtonLink> : null}
            {can.export ? <ButtonLink variant="secondary" href={`${base}/export`}>{C.downloadRecords}</ButtonLink> : null}
            {can.archiveControl ? (
              <ArchiveProjectControl orgSlug={orgSlug} projectId={project.id} projectName={project.name} archived={project.archived} />
            ) : null}
          </>
        )}
      />
      <ArchivedBanner archived={project.archived} />
      <div className="stage-list">
        <nav className="stage-list__jump" aria-label={C.jumpTo}>
          {STAGES.map((s) => <a key={s} href={`#${s}`}>{STAGE_NAME[s]}</a>)}
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
      <p className="text-muted">{C.shareLine}</p>
      <p><ListLink href={`${base}/findings`}>{C.findings}</ListLink></p>
      {children}
    </div>
  );
}
