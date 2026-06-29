import { requireAdmin } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import AdminAssessmentsTable from './AdminAssessmentsTable';

export const metadata = {
  title: 'Assessments Overview — Admin',
};

export default async function AdminAssessmentsPage() {
  await requireAdmin();

  const assessments = await prisma.assessment.findMany({
    include: {
      project: { select: { name: true } },
      user: { select: { name: true, email: true } },
    },
    orderBy: { startedAt: 'desc' },
  });

  const completedCount = assessments.filter((a) => a.status === 'completed').length;
  const inProgressCount = assessments.filter((a) => a.status === 'in_progress').length;

  // Serialize for the client component
  const serialized = assessments.map((a) => ({
    id: a.id,
    projectName: a.project.name,
    userName: a.user.name,
    userEmail: a.user.email,
    mode: a.mode,
    overallScore: a.overallScore,
    status: a.status,
    startedAt: a.startedAt.toISOString(),
  }));

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Assessments Overview</h1>
          <p className="text-muted">
            {assessments.length} total assessment{assessments.length !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      {/* Summary cards */}
      <div className="admin-stats-row">
        <div className="admin-stat-card card">
          <span className="admin-stat-card__value">{assessments.length}</span>
          <span className="admin-stat-card__label">Total</span>
        </div>
        <div className="admin-stat-card card">
          <span className="admin-stat-card__value admin-stat-card__value--completed">
            {completedCount}
          </span>
          <span className="admin-stat-card__label">Completed</span>
        </div>
        <div className="admin-stat-card card">
          <span className="admin-stat-card__value admin-stat-card__value--progress">
            {inProgressCount}
          </span>
          <span className="admin-stat-card__label">In Progress</span>
        </div>
      </div>

      <AdminAssessmentsTable assessments={serialized} />
    </div>
  );
}
