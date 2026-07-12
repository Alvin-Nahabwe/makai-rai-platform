import Link from 'next/link';
import { requireAuth } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';

function scoreColor(score: number | null): string {
  if (score === null) return '';
  if (score >= 80) return 'var(--color-risk-low)';
  if (score >= 60) return 'var(--color-risk-moderate)';
  if (score >= 40) return 'var(--color-risk-high)';
  return 'var(--color-risk-critical)';
}

function formatAiType(type: string | null | undefined): string {
  if (!type) return 'Not specified';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function ProjectsPage() {
  const session = await requireAuth();
  const userId = session.user.id;
  const role = session.user.role;

  const projects = await prisma.project.findMany({
    where: role === 'admin' ? {} : { createdById: userId },
    include: {
      metadata: true,
      assessments: {
        select: { id: true, status: true, overallScore: true, completedAt: true },
        orderBy: { startedAt: 'desc' },
      },
      createdBy: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="text-muted">
            Manage your AI system assessments
          </p>
        </div>
        <Link href="/projects/new" className="btn btn--primary btn--arrow">
          New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__icon">📁</div>
          <h2>No projects yet</h2>
          <p className="text-muted">
            Create your first project to begin assessing your AI system for responsible AI compliance.
          </p>
          <Link href="/projects/new" className="btn btn--primary btn--large btn--arrow">
            Create Your First Project
          </Link>
        </div>
      ) : (
        <div className="projects-grid">
          {projects.map((project) => {
            const latestAssessment = project.assessments[0] ?? null;
            const completedCount = project.assessments.filter(
              (a) => a.status === 'completed',
            ).length;

            return (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                className="project-card card"
              >
                <div className="project-card__header">
                  <h2 className="project-card__name">{project.name}</h2>
                  <span className="badge badge--coming-soon">
                    {formatAiType(project.metadata?.aiSystemType)}
                  </span>
                </div>

                {project.description && (
                  <p className="project-card__desc">{project.description}</p>
                )}

                <div className="project-card__stats">
                  <div className="project-card__stat">
                    <span className="project-card__stat-value">
                      {project.assessments.length}
                    </span>
                    <span className="project-card__stat-label">
                      {project.assessments.length === 1 ? 'Assessment' : 'Assessments'}
                    </span>
                  </div>
                  <div className="project-card__stat">
                    <span className="project-card__stat-value">{completedCount}</span>
                    <span className="project-card__stat-label">Completed</span>
                  </div>
                  {latestAssessment?.overallScore !== null &&
                    latestAssessment?.overallScore !== undefined && (
                      <div className="project-card__stat">
                        <span
                          className="project-card__stat-value"
                          style={{ color: scoreColor(latestAssessment.overallScore) }}
                        >
                          {latestAssessment.overallScore}%
                        </span>
                        <span className="project-card__stat-label">Latest Score</span>
                      </div>
                    )}
                </div>

                <div className="project-card__footer">
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                    by {project.createdBy.name}
                  </span>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                    Updated {new Date(project.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
