import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireAuth } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import StartAssessmentButton from '@/components/assessment/StartAssessmentButton';

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

function statusLabel(status: string): string {
  return status === 'completed' ? 'Completed' : 'In Progress';
}

function statusBadgeClass(status: string): string {
  return status === 'completed' ? 'badge badge--completed' : 'badge badge--in-progress';
}

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ProjectDetailPage({ params }: PageProps) {
  const session = await requireAuth();
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      metadata: true,
      assessments: {
        include: {
          user: { select: { name: true, email: true } },
          remediationItems: true,
        },
        orderBy: { startedAt: 'desc' },
      },
      createdBy: { select: { name: true } },
    },
  });

  // Enforce object-level authorization: only the project creator or an admin
  // may view it. Redirect (rather than 403) to avoid leaking existence.
  if (!project || (project.createdById !== session.user.id && session.user.role !== 'admin')) {
    redirect('/projects');
  }

  const completedAssessments = project.assessments.filter(
    (a) => a.status === 'completed',
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <Link href="/projects" className="back-link">
            ← Back to Projects
          </Link>
          <h1 style={{ marginTop: 4 }}>{project.name}</h1>
          {project.description && (
            <p className="text-muted">{project.description}</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          {completedAssessments.length >= 2 && (
            <Link
              href={`/projects/${project.id}/compare`}
              className="btn btn--secondary"
            >
              Compare Assessments
            </Link>
          )}
          <StartAssessmentButton projectId={project.id} />
        </div>
      </div>

      {/* Metadata Card */}
      <section
        className="card"
        style={{ padding: 24, marginBottom: 32 }}
      >
        <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
          Project Details
        </h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: '16px 32px',
          }}
        >
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              AI System Type
            </span>
            <span>{formatAiType(project.metadata?.aiSystemType)}</span>
          </div>
          {project.metadata?.institution && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Institution
              </span>
              <span>{project.metadata.institution}</span>
            </div>
          )}
          {project.metadata?.department && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Department
              </span>
              <span>{project.metadata.department}</span>
            </div>
          )}
          {project.metadata?.country && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Country
              </span>
              <span>{project.metadata.country}</span>
            </div>
          )}
          {project.metadata?.deploymentSector && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Deployment Sector
              </span>
              <span>{project.metadata.deploymentSector}</span>
            </div>
          )}
          {project.metadata?.targetPopulation && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Target Population
              </span>
              <span>{project.metadata.targetPopulation}</span>
            </div>
          )}
          {project.metadata?.developmentStage && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Development Stage
              </span>
              <span>
                {project.metadata.developmentStage
                  .replace(/_/g, ' ')
                  .replace(/\b\w/g, (c) => c.toUpperCase())}
              </span>
            </div>
          )}
          {project.metadata?.teamSize && (
            <div>
              <span
                className="text-muted"
                style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
              >
                Team Size
              </span>
              <span>{project.metadata.teamSize}</span>
            </div>
          )}
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              Created By
            </span>
            <span>{project.createdBy.name}</span>
          </div>
          <div>
            <span
              className="text-muted"
              style={{ fontSize: 'var(--font-size-xs)', display: 'block' }}
            >
              Last Updated
            </span>
            <span>{new Date(project.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
      </section>

      {/* Assessments List */}
      <section>
        <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
          Assessments ({project.assessments.length})
        </h2>

        {project.assessments.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon">📋</div>
            <h3>No assessments yet</h3>
            <p className="text-muted">
              Start your first assessment to evaluate this AI system for
              responsible AI compliance.
            </p>
            <StartAssessmentButton projectId={project.id} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {project.assessments.map((assessment) => {
              const gapCount = assessment.remediationItems.filter(
                (r) => r.tier === 'gap',
              ).length;
              const attentionCount = assessment.remediationItems.filter(
                (r) => r.tier === 'attention',
              ).length;

              return (
                <Link
                  key={assessment.id}
                  href={`/assessment/${assessment.id}`}
                  className="card"
                  style={{
                    padding: 20,
                    textDecoration: 'none',
                    color: 'inherit',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 16,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 180 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 4,
                      }}
                    >
                      <strong>Assessment v{assessment.version}</strong>
                      <span className={statusBadgeClass(assessment.status)}>
                        {statusLabel(assessment.status)}
                      </span>
                      <span className={`badge badge--${assessment.mode}`}>
                        {assessment.mode === 'full' ? 'Full' : 'Quick'}
                      </span>
                    </div>
                    <span
                      className="text-muted"
                      style={{ fontSize: 'var(--font-size-xs)' }}
                    >
                      by {assessment.user.name} ·{' '}
                      {new Date(assessment.startedAt).toLocaleDateString()}
                      {assessment.completedAt &&
                        ` · Completed ${new Date(assessment.completedAt).toLocaleDateString()}`}
                    </span>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 20,
                    }}
                  >
                    {assessment.overallScore !== null &&
                      assessment.overallScore !== undefined && (
                        <div style={{ textAlign: 'center' }}>
                          <div
                            style={{
                              fontSize: 'var(--font-size-xl)',
                              fontWeight: 700,
                              color: scoreColor(assessment.overallScore),
                            }}
                          >
                            {assessment.overallScore}%
                          </div>
                          <span
                            className="text-muted"
                            style={{ fontSize: 'var(--font-size-xs)' }}
                          >
                            Score
                          </span>
                        </div>
                      )}
                    {assessment.remediationItems.length > 0 && (
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: 'var(--font-size-sm)' }}>
                          {gapCount > 0 && (
                            <span className="badge badge--critical" style={{ marginRight: 4 }}>
                              {gapCount} {gapCount === 1 ? 'gap' : 'gaps'}
                            </span>
                          )}
                          {attentionCount > 0 && (
                            <span className="badge badge--moderate">
                              {attentionCount} attention
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
