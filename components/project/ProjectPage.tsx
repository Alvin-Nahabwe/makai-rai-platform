import './ProjectPage.css';
import type { ReactElement, ReactNode } from 'react';
import { STAGES } from '@/types/record';
import { PageHeader } from '@/components/ui/PageHeader';
import { Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageLine } from '@/components/project/StageLine';
import { ProjectActions } from '@/components/project/ProjectActions';
import { firstUses } from '@/components/project/firstUse';
import type { ProjectOverviewData } from '@/lib/data/projects';
import type { ProjectRoutes } from '@/lib/project/routes';
import { ButtonLink } from '@/components/ui/Button';
import type { ContinueTarget } from '@/lib/home/types';
import { PROJECT_COPY } from '@/lib/project/copy';
import { SHELL_COPY } from '@/lib/shell/copy';
import { TERM_SEAL, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';

const P = PROJECT_COPY;

/**
 * S-10, the project page, as the Route sketch draws it (`directions/surfaces/project.png`; owner ruling R5; spec 9.2): the
 * header (breadcrumb "Projects › name", the name, the descriptive line and "You can work on the stages in any order."),
 * then the three stages side by side, each a vertical line of stops (StageLine), the share line, and the quiet "This
 * project" row at the foot with Archive last. The page's one primary action is "Open the working report", under the
 * what-you-get line (G5, owner-approved 19 Nov 2026, which supersedes ruling C3 of 15 Nov: the primary no longer carries the
 * next question; each stage's own "Next: Question N" link does). A synchronous view of loaded data (the page file loads it), so it renders the same on the server
 * and in a test; ArchiveProjectControl is its only client island of its own.
 */
export function ProjectPage({ data, routes, continueTo, children }: {
  data: ProjectOverviewData;
  routes: ProjectRoutes;
  /**
   * Home's continue target for this person (`loadContinueTarget`; null or absent: none). In the stage it names, that stage's
   * "Next: Question N" link points at the target's question, so the page and Home name the same question (I1); other stages
   * keep their first open question. No primary action reads it (G5).
   */
  continueTo?: ContinueTarget | null;
  children?: ReactNode;
}): ReactElement {
  const { orgSlug, project, can } = data;
  const base = `/orgs/${orgSlug}/projects/${project.id}`;
  const tallies = { 'pre-processing': routes['pre-processing'].tally, 'in-processing': routes['in-processing'].tally, 'post-processing': routes['post-processing'].tally };
  const uses = firstUses({ counts: data.counts, reviews: data.reviews, canOpenReview: can.openReview, tallies });
  const shareSeal = uses.seal === 'share';
  const shareReview = uses.stageReview === 'share';
  let share: ReactNode = P.overview.shareLine;
  if (shareReview) share = <Term of={TERM_STAGE_REVIEW}>{share}</Term>;
  if (shareSeal) share = <Term of={TERM_SEAL}>{share}</Term>;
  return (
    <div className="page-content project-page">
      <PageHeader
        breadcrumb={[{ label: SHELL_COPY.items.projects, href: `/orgs/${orgSlug}/projects` }, { label: project.name }]}
        title={project.name}
        lead={(
          <div className="project-page__sub">
            {project.descriptiveLine !== '' ? <p className="project-page__facts">{project.descriptiveLine}</p> : null}
            <p className="project-page__order"><span className="project-page__glyph" aria-hidden="true" />{P.overview.anyOrder}</p>
          </div>
        )}
      />
      <ArchivedBanner archived={project.archived} />
      {/* G5: what a person gets, then the one primary action, in the body (the header has no actions wrapper). Every role may read the report. */}
      <div className="project-page__gets">
        <p className="project-page__gets-line">{P.overview.whatYouGet}</p>
        <p className="project-page__primary"><ButtonLink variant="primary" href={`${base}/report`}>{P.overview.openReport}</ButtonLink></p>
      </div>
      <div className="project-lines-frame">
        <nav className="stage-list__jump" aria-label={P.overview.jumpTo}>
          {STAGES.map((s) => <a key={s} href={`#${s}`}>{P.stageNames[s]}</a>)}
        </nav>
        <div className="project-lines">
          {STAGES.map((s) => (
            <StageLine
              key={s} stage={s} base={base} counts={data.counts[s]} route={routes[s]} followUp={data.followUp[s]} reviews={data.reviews[s]}
              canOpenReview={can.openReview} uses={uses} applies={data.applies?.[s] ?? true} canRecord={data.canRecord ?? true}
              continueId={continueTo?.stage === s ? continueTo.questionId : null}
            />
          ))}
        </div>
      </div>
      <p className="project-page__share">
        {share}
        {shareSeal ? <TermTip of={TERM_SEAL} label={P.whatMeans(TERM_SEAL.term)} /> : null}
        {shareReview ? <TermTip of={TERM_STAGE_REVIEW} label={P.whatMeans(TERM_STAGE_REVIEW.term)} /> : null}
      </p>
      <ProjectActions base={base} can={can} orgSlug={orgSlug} projectId={project.id} projectName={project.name} archived={project.archived} />
      {children}
    </div>
  );
}
