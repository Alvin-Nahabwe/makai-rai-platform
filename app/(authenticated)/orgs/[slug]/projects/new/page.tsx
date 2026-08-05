import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { ForbiddenError } from '@/lib/data/tenant';
import NewProjectForm from './NewProjectForm';

/**
 * D-127: this page is a mutating control in its own right — the create
 * form and its submit button — reachable by DIRECT navigation regardless
 * of whether the link that points here is hidden. Hiding the link (done
 * on the dashboard and projects-list pages in this same fix) is not
 * sufficient by itself (design spec
 * docs/superpowers/specs/2026-08-03-phase1b-wire-the-spine-design.md:311,
 * and the Task 12 fix-round brief's own constraint 3), so the route is
 * gated here too, the same way every other `/orgs/[slug]/**` page gates
 * on the action it actually performs.
 *
 * `ForbiddenError` -> `notFound()`, not a distinct "forbidden" page: this
 * caller is already a proven member of the org (the `/orgs/[slug]` layout
 * establishes that via `org:read`, which every role holds) — what's being
 * withheld here is not "the org exists but you're not in it" (that's the
 * layout's NotFoundError case) but "you may not create a project here".
 * Mapping both to the same 404 keeps one fail-closed shape rather than
 * inventing a second one for a single route.
 */
export default async function NewProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const identity = await requireIdentity();

  try {
    await requireOrgContextFor(identity.userId, slug, 'project:create');
  } catch (e) {
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

  return <NewProjectForm />;
}
