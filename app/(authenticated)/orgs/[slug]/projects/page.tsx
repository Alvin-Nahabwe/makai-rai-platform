import Link from 'next/link';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { lookupUserNames } from '@/lib/data/identity';
import { can } from '@/lib/authz/policy';

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

/** Every project in the org, not just the caller's own — see the dashboard
 * page's comment for the same team-visibility rationale (ADR-0001). */
export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');

  // No `createdBy` relation `include` — `makrai_app` has no grant on
  // `users` (lib/data/identity.ts#lookupUserNames). `createdById` is read
  // as a scalar column and the name attached afterwards.
  const projects = await withOrg(ctx, (tx) =>
    tx.project.findMany({
      include: {
        metadata: true,
        assessments: {
          select: { id: true, status: true, overallScore: true, completedAt: true },
          orderBy: { startedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    }),
  );
  const creatorNames = await lookupUserNames(projects.map((p) => p.createdById));
  // D-127: same project:create control as the dashboard's link — see that
  // page's matching comment. The route it points to (/projects/new) is
  // gated independently, so this is defense at the link too, not instead.
  const canCreateProject = can(ctx.role, 'project:create');

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="text-muted">
            Manage your AI system assessments
          </p>
        </div>
        {canCreateProject && (
          <Link href={`/orgs/${slug}/projects/new`} className="btn btn--primary btn--arrow">
            New Project
          </Link>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state__icon">📁</div>
          <h2>No projects yet</h2>
          <p className="text-muted">
            Create your first project to begin assessing your AI system for responsible AI compliance.
          </p>
          {canCreateProject && (
            <Link href={`/orgs/${slug}/projects/new`} className="btn btn--primary btn--large btn--arrow">
              Create Your First Project
            </Link>
          )}
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
                href={`/orgs/${slug}/projects/${project.id}`}
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
                    by {creatorNames.get(project.createdById)?.name ?? 'Unknown'}
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
