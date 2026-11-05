import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError } from '@/lib/data/tenant';
import NewProjectForm from './NewProjectForm';

/**
 * S-09 in create mode. D-127: this page is a mutating control in its own right, reachable by direct navigation whether
 * or not the link that points here is hidden, so the route is gated on `project:create` here too. `ForbiddenError`
 * becomes `notFound()`: the caller is already a proven member (the layout checked `org:read`), and one fail-closed shape
 * serves every refusal.
 */
export default async function NewProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const identity = await requireIdentity();

  try {
    await requireOrgContextFor(identity.userId, slug, 'project:create');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

  return <NewProjectForm mode="create" />;
}
