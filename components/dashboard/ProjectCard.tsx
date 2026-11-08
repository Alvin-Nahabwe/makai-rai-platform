import type { ReactElement } from 'react';
import type { Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { STAGE_NAME, plural } from '@/components/project/StageColumn';

type StageCountsLine = Record<Stage, { openFindings: number; overdueMitigations: number }>;
export interface ProjectCardProps {
  orgSlug: string;
  project: { id: string; name: string; descriptiveLine: string };
  counts: StageCountsLine;
}


/** One active project on S-08 (FR-PRJ-04): its name, the descriptive line and, per stage, the open findings and overdue mitigations. No score (FR-RM-01). */
export function ProjectCard({ orgSlug, project, counts }: ProjectCardProps): ReactElement {
  return (
    <article className="card project-card">
      <h3 className="project-card__name"><ListLink href={`/orgs/${orgSlug}/projects/${project.id}`}>{project.name}</ListLink></h3>
      {project.descriptiveLine !== '' ? <p className="project-card__desc">{project.descriptiveLine}</p> : null}
      <ul>
        {STAGES.map((s) => (
          <li key={s}>{`${STAGE_NAME[s]}: ${plural(counts[s].openFindings, 'open finding', 'open findings')}, ${plural(counts[s].overdueMitigations, 'overdue mitigation', 'overdue mitigations')}`}</li>
        ))}
      </ul>
    </article>
  );
}

export default ProjectCard;
