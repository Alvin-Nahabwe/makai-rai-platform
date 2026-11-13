import { headers } from 'next/headers';
import { requireIdentity } from '@/lib/auth/identity';
import { readSessionDeadlines } from '@/lib/auth/idleDeadline';
import { idleLimitSeconds } from '@/lib/auth/idle';
import { loadShellData } from '@/lib/shell/data';
import AppShell from '@/components/layout/AppShell';
import IdleWarning from '@/components/layout/IdleWarning';
import { NewerLegalTextNotice } from '@/components/legal/NewerLegalTextNotice';

/**
 * Wraps every authenticated route — org-scoped, admin, explore, and
 * change-password. `requireIdentity()` is identity only ("who is this?"),
 * never authorization: org membership is proven independently, per org,
 * by the `/orgs/[slug]` layout's `requireOrgContextFor` call, not here.
 *
 * The idle warning (UX-43) follows the session cookie's own expiry, so the layout reads the
 * cookie's two deadlines on the server (lib/auth/idleDeadline.ts) and hands them over as seconds
 * left. When the cookie cannot be read the page renders without a warning and logs one fixed line,
 * which carries nothing from the token; a signed-in page that fails that read is a fault to
 * notice, unlike on the not-found page, where a signed-out visitor is normal. The warning comes
 * first in the markup so its signed-out notice sits at the top of the page.
 *
 * The shell's rail shows the person's role in the organisation whose page is open (UX-02). `loadShellData`
 * asks `orgRoleLabel` once per organisation the person is in, and once with no organisation for the platform
 * label; the rail picks one by the address. Only each organisation's slug and name, and never the account's
 * platform role field, are passed on (lib/shell/data.ts). The warning stays outside AppShell, before it.
 */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  const identity = await requireIdentity();
  const deadlines = await readSessionDeadlines(await headers());
  if (!deadlines) console.error('idle_deadline_unreadable');
  const shell = await loadShellData(identity);
  return (
    <>
      {deadlines ? <IdleWarning idleSeconds={idleLimitSeconds()} {...deadlines} /> : null}
      <AppShell shell={shell}>
        <NewerLegalTextNotice userId={identity.userId} />
        {children}
      </AppShell>
    </>
  );
}
