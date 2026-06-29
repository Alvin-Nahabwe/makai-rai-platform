import { requireAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';

export const metadata = {
  title: 'Platform Settings — Admin',
};

export default async function AdminSettingsPage() {
  await requireAdmin();

  const [totalUsers, totalAssessments, completedAssessments] = await Promise.all([
    prisma.user.count(),
    prisma.assessment.count(),
    prisma.assessment.findMany({
      where: { status: 'completed', overallScore: { not: null } },
      select: { overallScore: true },
    }),
  ]);

  const completedCount = completedAssessments.length;
  const inProgressCount = totalAssessments - completedCount;
  const averageScore =
    completedCount > 0
      ? Math.round(
          completedAssessments.reduce((sum, a) => sum + (a.overallScore ?? 0), 0) /
            completedCount
        )
      : null;

  const completionRatio =
    totalAssessments > 0
      ? Math.round((completedCount / totalAssessments) * 100)
      : 0;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Platform Settings</h1>
          <p className="text-muted">Platform statistics and configuration</p>
        </div>
      </div>

      {/* Platform statistics */}
      <section className="dashboard-section">
        <h2>Platform Statistics</h2>
        <div className="admin-stats-row">
          <div className="admin-stat-card card">
            <span className="admin-stat-card__value">{totalUsers}</span>
            <span className="admin-stat-card__label">Total Users</span>
          </div>
          <div className="admin-stat-card card">
            <span className="admin-stat-card__value">{totalAssessments}</span>
            <span className="admin-stat-card__label">Total Assessments</span>
          </div>
          <div className="admin-stat-card card">
            <span className="admin-stat-card__value">
              {averageScore !== null ? averageScore : '—'}
            </span>
            <span className="admin-stat-card__label">Average Score</span>
          </div>
          <div className="admin-stat-card card">
            <span className="admin-stat-card__value">{completionRatio}%</span>
            <span className="admin-stat-card__label">Completion Rate</span>
          </div>
        </div>

        {/* Completion breakdown */}
        <div className="admin-completion-breakdown card">
          <h3>Assessment Completion</h3>
          <div className="admin-completion-bar">
            <div
              className="admin-completion-bar__fill"
              style={{ width: `${completionRatio}%` }}
            />
          </div>
          <div className="admin-completion-legend">
            <span className="admin-completion-legend__item">
              <span className="admin-completion-legend__dot admin-completion-legend__dot--completed" />
              Completed: {completedCount}
            </span>
            <span className="admin-completion-legend__item">
              <span className="admin-completion-legend__dot admin-completion-legend__dot--progress" />
              In Progress: {inProgressCount}
            </span>
          </div>
        </div>
      </section>

      {/* Future: Question bank */}
      <section className="dashboard-section">
        <h2>Question Bank</h2>
        <div className="admin-placeholder card">
          <div className="admin-placeholder__icon">🔧</div>
          <h3>Coming Soon</h3>
          <p className="text-muted">
            Question bank editing UI is under development. You will be able to
            manage assessment questions, categories, and scoring rubrics from
            this page.
          </p>
        </div>
      </section>
    </div>
  );
}
