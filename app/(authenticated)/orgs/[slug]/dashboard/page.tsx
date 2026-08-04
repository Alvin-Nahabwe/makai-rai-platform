import { requireAuth } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import Link from 'next/link';
import ProjectCard from '@/components/dashboard/ProjectCard';

export default async function DashboardPage() {
  const session = await requireAuth();
  const userId = session.user.id;
  const userName = session.user?.name || 'there';

  // Fetch user's projects with metadata and assessments
  const projects = await prisma.project.findMany({
    where: { createdById: userId },
    include: {
      metadata: {
        select: {
          aiSystemType: true,
          aiSystemTypeOther: true,
        },
      },
      assessments: {
        select: {
          id: true,
          status: true,
          overallScore: true,
          completedAt: true,
        },
        orderBy: { startedAt: 'desc' },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  // Recent completed assessments (latest 5 across all projects)
  const recentAssessments = await prisma.assessment.findMany({
    where: {
      userId,
      status: 'completed',
      overallScore: { not: null },
    },
    include: {
      project: { select: { id: true, name: true } },
    },
    orderBy: { completedAt: 'desc' },
    take: 5,
  });

  const hasProjects = projects.length > 0;

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
        <Link href="/projects/new" className="btn btn--primary btn--arrow">
          Start New Assessment
        </Link>
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
                    href={`/projects/${assessment.project.id}`}
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
          <Link href="/projects/new" className="btn btn--primary btn--large btn--arrow">
            Create Your First Project
          </Link>
        </div>
      )}
    </div>
  );
}
