import './ProjectPage.css';
import type { ReactElement, ReactNode } from 'react';
import { STAGES } from '@/types/record';
import { PageHeader } from '@/components/ui/PageHeader';
import { Definition, Term } from '@/components/ui/Definition';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { NextStep, StageLine } from '@/components/project/StageLine';
import { ProjectActions } from '@/components/project/ProjectActions';
import { firstUses } from '@/components/project/firstUse';
import type { ProjectOverviewData } from '@/lib/data/projects';
import type { ProjectRoutes } from '@/lib/project/routes';
import type { ContinueTarget } from '@/lib/home/types';
import { PROJECT_COPY } from '@/lib/project/copy';
import { SHELL_COPY } from '@/lib/shell/copy';
import { TERM_SEAL, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';

const P = PROJECT_COPY;

/**
 * S-10, the project page, as the Route sketch draws it (`directions/surfaces/project.png`; owner ruling R5; spec 9.2): the
 * header (breadcrumb "Projects › name", the name, the descriptive line and "You can work on the stages in any order."),
 * then the three stages side by side, each a vertical line of stops (StageLine), the share line, and the quiet "This
 * project" row at the foot with Archive last. The page's one primary action sits on the line of the stage the person last
 * saved in (plan 1C C11). A synchronous view of loaded data (the page file loads it), so it renders the same on the server
 * and in a test; ArchiveProjectControl is its only client island of its own.
 */
export function ProjectPage({ data, routes, continueTo, children }: {
  data: ProjectOverviewData;
  routes: ProjectRoutes;
  /** From `loadContinueTarget`; null (a Reviewer, a Viewer, an archived project) renders no primary action. */
  continueTo: ContinueTarget | null;
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
      <div className="project-lines-frame">
        {/* The next step once, above the stacked lines (owner's ruling on C3); hidden once the lines sit side by side, where the
            target line's head stop carries it. Its own slot, so nothing on the foot row's path changes with it. */}
        {continueTo !== null ? (
          <NextStep target={continueTo} base={base} route={routes[continueTo.stage]} counts={data.counts[continueTo.stage]} where="stacked" />
        ) : null}
        <nav className="stage-list__jump" aria-label={P.overview.jumpTo}>
          {STAGES.map((s) => <a key={s} href={`#${s}`}>{P.stageNames[s]}</a>)}
        </nav>
        <div className="project-lines">
          {STAGES.map((s) => (
            <StageLine
              key={s} stage={s} base={base} counts={data.counts[s]} route={routes[s]} followUp={data.followUp[s]} reviews={data.reviews[s]}
              canOpenReview={can.openReview} uses={uses} primary={continueTo !== null && continueTo.stage === s ? continueTo : null}
            />
          ))}
        </div>
      </div>
      <p className="project-page__share">
        {share}
        {shareSeal ? <Definition of={TERM_SEAL} /> : null}
        {shareReview ? <Definition of={TERM_STAGE_REVIEW} /> : null}
      </p>
      <ProjectActions base={base} can={can} orgSlug={orgSlug} projectId={project.id} projectName={project.name} archived={project.archived} />
      {children}
    </div>
  );
}
