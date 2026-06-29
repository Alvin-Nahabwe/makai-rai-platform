import { requireAuth } from '@/lib/auth-guard';

export default async function DashboardPage() {
  const session = await requireAuth();
  return (
    <div className="page-container">
      <h1>Dashboard</h1>
      <p>Welcome, {session.user?.name}. Full dashboard coming in Phase D.</p>
    </div>
  );
}
