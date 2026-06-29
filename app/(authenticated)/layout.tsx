import { requireAuth } from '@/lib/auth-guard';
import Sidebar from '@/components/layout/Sidebar';

export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAuth();
  const user = session.user as any;
  return (
    <div className="app-layout">
      <Sidebar userName={user.name || ''} userRole={user.role || 'assessor'} />
      <main className="app-main">{children}</main>
    </div>
  );
}
