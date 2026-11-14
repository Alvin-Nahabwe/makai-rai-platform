import './ProjectCard.css';
import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { STAGE_NAME, plural } from '@/components/project/StageColumn';
import { HOME_COPY } from '@/lib/home/copy';

type StageCountsLine = Record<Stage, { openFindings: number; overdueMitigations: number }>;
export interface ProjectCardProps {
  orgSlug: string;
  project: { id: string; name: string; descriptiveLine: string };
  counts: StageCountsLine;
}

const C = HOME_COPY.card;

/** One active project on S-08 (FR-PRJ-04): its name, the descriptive line and, per stage, the open findings (a link to them when any, R5) and overdue mitigations. No score (FR-RM-01). */
export function ProjectCard({ orgSlug, project, counts }: ProjectCardProps): ReactElement {
  return (
    <article className="card project-card">
      <h3 className="project-card__name"><ListLink href={`/orgs/${orgSlug}/projects/${project.id}`}>{project.name}</ListLink></h3>
      {project.descriptiveLine !== '' ? <p className="project-card__desc">{project.descriptiveLine}</p> : null}
      <ul>
        {STAGES.map((s) => (
          <li key={s}>
            {C.lineStart(STAGE_NAME[s])}
            {/* R5 (S10): the count links to that stage's findings when there are any, as the project page's count does. */}
            {counts[s].openFindings > 0
              ? <ListLink href={`/orgs/${orgSlug}/projects/${project.id}/findings?stage=${s}`}>{plural(counts[s].openFindings, C.openFinding, C.openFindings)}</ListLink>
              : plural(counts[s].openFindings, C.openFinding, C.openFindings)}
            {C.lineEnd(plural(counts[s].overdueMitigations, C.overdueMitigation, C.overdueMitigations))}
          </li>
        ))}
      </ul>
    </article>
  );
}

export default ProjectCard;
