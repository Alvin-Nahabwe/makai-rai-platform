import { headers } from 'next/headers';
import { tryResolveIdentity } from '@/lib/auth/identity';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';
import { idleLimitSeconds } from '@/lib/auth/idle';
import IdleWarning from '@/components/layout/IdleWarning';

/**
 * The signed-in pages outside the shell (plan 1B Task 1): S-05 acceptances, S-29 change password and S-07 the organisation
 * chooser at `/`. Each renders the gate frame itself (components/layout/GateFrame.tsx) with the route of its own door: a
 * layout is not rendered again on a client navigation between its pages, so it cannot know which page it holds.
 *
 * The gates run in each page (requireIdentity, threat A7, __tests__/lint/authenticated-page-gate.test.ts), never here: the
 * gates redirect from one page of this group to another (`/` to /acceptances or /change-password), and that redirect thrown
 * by the layout the two pages share left the client router refetching /acceptances without end after sign-in, rendering no
 * page (seen on a dev server and a production build, e2e/acceptances.spec.ts). This layout renders nothing of the account's
 * but the idle warning, so it reads the identity softly, as Help's layout does: signed out, it renders the page alone, whose
 * gate sends the visitor to sign in (and logs nothing: signed out is normal here).
 *
 * Signed in, the idle warning (UX-43) is read as the signed-in layout reads it: when the session cookie's deadlines cannot be
 * read the page renders without a warning and logs one fixed line, which carries nothing from the token. No newer-text
 * notice: offers of a newer legal text show on in-shell pages only.
 */
export default async function GateLayout({ children }: { children: React.ReactNode }) {
  const identity = await tryResolveIdentity();
  if (identity === null) return <>{children}</>;
  const deadlines = await readSessionDeadlines(await headers());
  if (!deadlines) console.error('idle_deadline_unreadable');
  return (
    <>
      {deadlines ? <IdleWarning idleSeconds={idleLimitSeconds()} {...deadlines} /> : null}
      {children}
    </>
  );
}
