import { requireIdentity } from '@/lib/auth/identity';

/**
 * The gates for the explore pages (Framework, Controls, About) on a client-side navigation (C4
 * CR-1; UX-01, SRS 7.1.2). Next does not re-render a layout shared by the page a navigation leaves
 * and the page it opens, so the (authenticated) layout's requireIdentity() does not run when the
 * sidebar takes an account from S-05 to one of these 'use client' pages. This segment is not shared
 * with /acceptances, so it renders on that navigation, and an account missing an acceptance is
 * sent back to S-05 (a flagged account to S-29).
 */
export default async function ExploreLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return children;
}
