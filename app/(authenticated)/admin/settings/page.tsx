import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { identityDb } from '@/lib/data/identity';

export const metadata = {
  title: 'Platform Settings — Admin',
};

/**
 * Assessment-derived stats (total assessments, average score, completion
 * rate) are REMOVED here, not merely trimmed to "counts only" as the brief
 * literally asked — see docs/DEFERRED_REGISTER.md for why: `Assessment` is
 * tenant data, and under ADR-0001 there is no sanctioned path to a
 * platform-wide tenant aggregate. `identityDb` structurally cannot reach it
 * (assertNoTenantRelation rejects any `assessments`/`projects` relation by
 * construction), and `withOrg` requires a single org's GUC, so it can only
 * ever total ONE organization, never the platform. Querying `appClient`
 * directly with no GUC set does not recover a platform total either — the
 * fail-closed RLS policy returns zero rows, not "every org's rows" (ADR-0001:
 * "forgetting to use it fails CLOSED"). `totalUsers` survives because `User`
 * is genuinely non-tenant data, reachable through `identityDb` as designed.
 */
export default async function AdminSettingsPage() {
  const identity = await requireIdentity();
  if (identity.platformRole !== 'admin') redirect('/');

  const totalUsers = await identityDb.user.count();

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
