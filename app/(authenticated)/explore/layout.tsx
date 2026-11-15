import { requireIdentity } from '@/lib/auth/identity';

/**
 * The gates on a client-side navigation INTO /explore (C4 CR-1; UX-01, SRS 7.1.2). Next does not re-render a layout
 * shared by the page a navigation leaves and the page it opens, so the (authenticated) layout's requireIdentity() does
 * not run when the rail takes an account from another page to Framework or Controls; this segment is not shared with
 * them, so it renders and runs the gates (an account missing an acceptance goes back to S-05, a flagged one to S-29).
 * A navigation BETWEEN Framework and Controls shares this layout too, so each of those pages also calls
 * requireIdentity() itself (security review 0.7.0, L-1; __tests__/lint/layout-gate-siblings.test.ts).
 */
export default async function ExploreLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return children;
}
