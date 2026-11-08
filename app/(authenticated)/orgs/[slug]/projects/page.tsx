import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { listProjectRows } from '@/lib/data/projects';
import { can } from '@/lib/authz/policy';
import { pageOf, LIST_PAGE_SIZE } from '@/lib/ui/showMore';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { AllProjectsView } from '@/components/project/AllProjectsView';

/**
 * S-32, all projects, active and archived: a long list (UX-37, UX-40), so each list shows 50 and a "Show more" link asks
 * for more with `?shown=`. Every member reads; unarchive is for owners and admins.
 */
export default async function ProjectsPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ shown?: string | string[] }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  const { active, archived } = await listProjectRows(ctx);
  const shown = typeof query.shown === 'string' ? query.shown : null;
  const a = pageOf(active, shown, LIST_PAGE_SIZE);
  const b = pageOf(archived, shown, LIST_PAGE_SIZE);
  const more = a.hasMore ? a : b.hasMore ? b : null;
  return (
    <AllProjectsView
      data={{ orgSlug: slug, canCreate: can(ctx.role, 'project:create'), canUnarchive: can(ctx.role, 'project:archive'), active: a.items, archived: b.items }}
    >
      {more !== null ? <ShowMoreLink href={`?shown=${more.nextShown}`} label="Show more" /> : null}
    </AllProjectsView>
  );
}
