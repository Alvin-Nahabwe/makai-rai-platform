import { headers } from 'next/headers';
import { identityPassesGates, tryResolveIdentity } from '@/lib/auth/identity';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { loadShellData } from '@/lib/shell/data';
import AppShell from '@/components/layout/AppShell';
import IdleWarning from '@/components/layout/IdleWarning';
import PublicHeader from '@/components/layout/PublicHeader';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';

/**
 * Help's frame (plan 1A Task 12, ruling L2-68; security obligation S5). Help is public. A person whose session resolves AND
 * who passes the sign-in gates (identityPassesGates: no password change due, no text to accept) gets the signed-in shell,
 * with the idle warning first, outside it, as on every signed-in page (UX-43). Everyone else gets the public header: a
 * signed-out visitor, and a signed-in person who still owes a step, who must not see a rail they cannot use (review L4;
 * spec 8, screen 13). For that person the header's "Sign in" goes to `/`, which runs requireIdentity() and so sends them
 * to the step they owe (ruling L2-70); the value is this fixed string, never input (S7). The shell data and the deadlines
 * are read only after the gates pass, so a gated or signed-out request reads no membership and sends nothing about the
 * person to the browser. No catch: a database error for a signed-in visitor is the error page, as on every signed-in page,
 * never the public header. Unreadable deadlines give no warning and the signed-in layout's one fixed log line: past the
 * gates the visitor is signed in and inside the shell, which is that layout's case, not `/`'s (fix round 1, F5). So Help
 * is the second source of `idle_deadline_unreadable`, beside app/(authenticated)/layout.tsx.
 */
export default async function HelpLayout({ children }: { children: React.ReactNode }) {
  const identity = await tryResolveIdentity();
  const gated = identity !== null && !(await identityPassesGates(identity));
  if (identity === null || gated) {
    return (
      <>
        <PublicHeader signInHref={gated ? '/' : undefined} />
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="public-layout">
          {children}
        </main>
      </>
    );
  }
  const deadlines = await readSessionDeadlines(await headers());
  if (!deadlines) console.error('idle_deadline_unreadable');
  const shell = await loadShellData(identity);
  return (
    <>
      {deadlines ? <IdleWarning idleSeconds={idleLimitSeconds()} {...deadlines} /> : null}
      <AppShell shell={shell}>{children}</AppShell>
    </>
  );
}
