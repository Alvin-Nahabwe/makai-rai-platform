import { requireIdentity } from '@/lib/auth/identity';

/**
 * The gates for /orgs/new, a 'use client' page, on a client-side navigation (C4 CR-1; UX-01): the
 * shared (authenticated) layout does not re-render then, this segment's layout does. ORG deletes
 * the page and this layout with it.
 */
export default async function NewOrgLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return children;
}
