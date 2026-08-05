import Link from 'next/link';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg } from '@/lib/data/tenant';
import { can } from '@/lib/authz/policy';
import ProjectCard from '@/components/dashboard/ProjectCard';

/**
 * Team-wide, not "my projects": every project and every recent completed
 * assessment IN THE ORG, not filtered to the caller. This mirrors the GET
 * /projects route pattern (no `createdById`/`userId` filter) — ADR-0001's
 * rationale for deleting lib/authz.ts applies identically here: "a
 * colleague in the same org legitimately reads a project they did not
 * create". RLS (via withOrg's GUC) is the only filter; there is no
 * `where: { orgId }` and no `where: { createdById: identity.userId }`.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const userName = identity.name || 'there';

  const [projects, recentAssessments] = await withOrg(ctx, async (tx) => {
    const p = await tx.project.findMany({
      include: {
        metadata: { select: { aiSystemType: true, aiSystemTypeOther: true } },
        assessments: {
          select: { id: true, status: true, overallScore: true, completedAt: true },
          orderBy: { startedAt: 'desc' },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const a = await tx.assessment.findMany({
      where: { status: 'completed', overallScore: { not: null } },
      include: { project: { select: { id: true, name: true } } },
      orderBy: { completedAt: 'desc' },
      take: 5,
    });
    return [p, a] as const;
  });

  const hasProjects = projects.length > 0;
  // D-127: this link is a project:create control (it points at
  // /projects/new, itself gated). Hidden here for a role that may not
  // create a project — not just cosmetic, since the destination route is
  // ALSO gated (defense at both the link and the route it points to).
  const canCreateProject = can(ctx.role, 'project:create');

  return (
    <div className="page-content">
      {/* Welcome header */}
      <div className="page-header">
        <div>
          <h1>Welcome back, {userName}</h1>
          <p className="text-muted">
            {hasProjects
              ? `You have ${projects.length} project${projects.length === 1 ? '' : 's'}. Here's your overview.`
              : 'Get started by creating your first project.'}
          </p>
        </div>
        {canCreateProject && (
          <Link href={`/orgs/${slug}/projects/new`} className="btn btn--primary btn--arrow">
            Start New Assessment
          </Link>
        )}
      </div>

      {hasProjects ? (
        <>
          {/* Projects grid */}
          <section className="dashboard-section">
            <h2>Your Projects</h2>
            <div className="projects-grid">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  orgSlug={slug}
                  project={{
                    id: project.id,
                    name: project.name,
                    description: project.description,
                    metadata: project.metadata,
                    assessments: project.assessments.map((a) => ({
                      id: a.id,
                      status: a.status,
                      overallScore: a.overallScore,
                      completedAt: a.completedAt,
                    })),
                  }}
                />
              ))}
            </div>
          </section>

          {/* Recent activity */}
          {recentAssessments.length > 0 && (
            <section className="dashboard-section">
              <h2>Recent Activity</h2>
              <div className="activity-list">
                {recentAssessments.map((assessment) => (
                  <Link
                    key={assessment.id}
                    href={`/orgs/${slug}/projects/${assessment.project.id}`}
                    className="activity-item card"
                  >
                    <div className="activity-item__info">
                      <span className="activity-item__project">
                        {assessment.project.name}
                      </span>
                      <span className="activity-item__date">
                        {assessment.completedAt
                          ? new Date(assessment.completedAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          : '—'}
                      </span>
                    </div>
                    <div className="activity-item__score">
                      <span className="activity-item__score-value">
                        {assessment.overallScore}
                      </span>
                      <span className="activity-item__score-label">Score</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        /* Empty state */
        <div className="empty-state">
          <div className="empty-state__icon">📋</div>
          <h3>No projects yet</h3>
          <p className="text-muted">
            Create your first project to begin assessing your AI system&apos;s
            responsible AI practices across the ML lifecycle.
          </p>
          {canCreateProject && (
            <Link href={`/orgs/${slug}/projects/new`} className="btn btn--primary btn--large btn--arrow">
              Create Your First Project
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
