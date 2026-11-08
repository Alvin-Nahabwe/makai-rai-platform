import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { loadDashboard } from '@/lib/data/projects';
import { eatDate } from '@/lib/followup/overdue';
import { DashboardView } from '@/components/project/DashboardView';

/**
 * S-08, team-wide, not "my projects": every active project of the organisation, with RLS (via `withOrg`) the only filter
 * (ADR-0001). "My mitigations" always takes the signed-in person's own id from the session, never a query value
 * (obligation P7). `searchParams` is a Promise in Next 16 (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function DashboardPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ welcome?: string | string[] }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const data = await loadDashboard(ctx, identity, { orgSlug: slug, welcome: query.welcome === '1', today: eatDate(new Date()) });
  return <DashboardView data={data} />;
}
