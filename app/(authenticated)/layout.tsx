import { requireIdentity } from '@/lib/auth/identity';
import Sidebar from '@/components/layout/Sidebar';

/**
 * Wraps every authenticated route — org-scoped, admin, explore, and
 * change-password. `requireIdentity()` is identity only ("who is this?"),
 * never authorization: org membership is proven independently, per org,
 * by the `/orgs/[slug]` layout's `requireOrgContextFor` call, not here.
 */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  return (
    <div className="app-layout">
      <Sidebar userName={identity.name || ''} userRole={identity.platformRole} />
      <main className="app-main">{children}</main>
    </div>
  );
}
