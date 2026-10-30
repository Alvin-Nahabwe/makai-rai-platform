'use client';

import Link from 'next/link';

interface Assessment {
  id: string;
  status: string;
}

interface ProjectMetadata {
  aiSystemType: string | null;
  aiSystemTypeOther: string | null;
}

interface ProjectCardProps {
  project: {
    id: string;
    name: string;
    description?: string | null;
    metadata: ProjectMetadata | null;
    assessments: Assessment[];
  };
  orgSlug: string;
}

function getSystemTypeLabel(metadata: ProjectMetadata | null): string | null {
  if (!metadata?.aiSystemType) return null;
  if (metadata.aiSystemType === 'other') return metadata.aiSystemTypeOther || 'Other';
  return metadata.aiSystemType
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function ProjectCard({ project, orgSlug }: ProjectCardProps) {
  const completedAssessments = project.assessments.filter(
    (a) => a.status === 'completed'
  );

  const systemType = getSystemTypeLabel(project.metadata);

  return (
    <Link href={`/orgs/${orgSlug}/projects/${project.id}`} className="card project-card">
      <div className="project-card__header">
        <div>
          <h3 className="project-card__name">{project.name}</h3>
          {project.description && (
            <p className="project-card__desc">{project.description}</p>
          )}
        </div>
      </div>

      <div className="project-card__meta">
        {systemType && <span className="badge badge--system-type">{systemType}</span>}
      </div>

      <div className="project-card__stats">
        <div className="project-card__stat">
          <span className="project-card__stat-value">{project.assessments.length}</span>
          <span className="project-card__stat-label">
            {project.assessments.length === 1 ? 'Assessment' : 'Assessments'}
          </span>
        </div>
        <div className="project-card__stat">
          <span className="project-card__stat-value">{completedAssessments.length}</span>
          <span className="project-card__stat-label">Completed</span>
        </div>
      </div>

      <div className="project-card__footer">
        <span className="project-card__link-text">View Project →</span>
      </div>
    </Link>
  );
}
