import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth-guard';
import { prisma } from '@/lib/db';
import RadarChart from '@/components/dashboard/RadarChart';
import TrendChart from '@/components/dashboard/TrendChart';
import GapHeatmap from '@/components/dashboard/GapHeatmap';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function CompareAssessmentsPage({ params }: PageProps) {
  const session = await requireAuth();
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      assessments: {
        where: { status: 'completed' },
        orderBy: { completedAt: 'asc' },
        select: {
          id: true,
          version: true,
          overallScore: true,
          completedAt: true,
          reportData: true,
        },
      },
    },
  });

  // Object-level authorization: only the creator or an admin may compare.
  if (!project || (project.createdById !== session.user.id && session.user.role !== 'admin')) {
    notFound();
  }

  const completed = project.assessments;

  // Serialize dates for client components
  const serialized = completed.map((a) => ({
    ...a,
    completedAt: a.completedAt ? a.completedAt.toISOString() : null,
    reportData: a.reportData as Record<string, unknown> | null,
  }));

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <Link
            href={`/projects/${project.id}`}
            style={{
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-text-muted)',
              textDecoration: 'none',
            }}
          >
            ← Back to {project.name}
          </Link>
          <h1 style={{ marginTop: 4 }}>
            Comparative Analysis
          </h1>
          <p className="text-muted">
            Comparing {completed.length} completed{' '}
            {completed.length === 1 ? 'assessment' : 'assessments'} for{' '}
            <strong>{project.name}</strong>
          </p>
        </div>
      </div>

      {completed.length < 1 ? (
        <div className="empty-state">
          <div className="empty-state__icon">📊</div>
          <h3>No completed assessments yet</h3>
          <p className="text-muted">
            Complete at least one assessment to view comparative charts.
          </p>
          <Link
            href={`/projects/${project.id}`}
            className="btn btn--primary btn--arrow"
          >
            Go to Project
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
          {/* Score Trend */}
          <section className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
              Score Trend
            </h2>
            <p
              className="text-muted"
              style={{ fontSize: 13, marginBottom: 16 }}
            >
              Overall assessment score progression over time.
            </p>
            <TrendChart assessments={serialized} />
          </section>

          {/* Principle Radar */}
          <section className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
              Principle Scores
            </h2>
            <p
              className="text-muted"
              style={{ fontSize: 13, marginBottom: 16 }}
            >
              Radar comparison of RAI principle scores across assessments.
            </p>
            <RadarChart assessments={serialized} />
          </section>

          {/* Gap Heatmap */}
          <section className="card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 18, marginBottom: 16, fontWeight: 600 }}>
              Area Gap Heatmap
            </h2>
            <p
              className="text-muted"
              style={{ fontSize: 13, marginBottom: 16 }}
            >
              Color-coded matrix of area scores across assessment versions.
            </p>
            <GapHeatmap assessments={serialized} />
          </section>
        </div>
      )}
    </div>
  );
}
