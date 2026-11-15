import type { Metadata } from 'next';
import { requireIdentity } from '@/lib/auth/identity';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';
import { ChangePasswordForm } from './ChangePasswordForm';

export const metadata: Metadata = { title: pageTitle(AUTH_COPY.titles.changePassword) };

/** Forced or not, a change signs the person out on every device (AUTH_COPY.changeLead), so the next step is to sign in again. */
const ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.changePassword, state: 'current' },
  { label: GATE_COPY.stops.signInAgain, state: 'upcoming' },
];

/**
 * S-29 Forced password change, and S-21's **Change password** (FR-ACC-08), in the gate frame (plan 1B Task 1). Gate 2 sends a
 * flagged account here and nowhere else. The gates run here in the page (T1.7) and in ./layout.tsx; the group layout runs
 * none (app/(gate)/layout.tsx). A flagged account cannot open My account, so the frame's M-41 offers no Go to them.
 */
export default async function ChangePasswordPage() {
  const identity = await requireIdentity();
  return (
    <GateFrame variant="signed-in" userName={identity.name ?? ''} userId={identity.userId} accountReachable={!identity.mustChangePassword} route={ROUTE}>
      <h1>{AUTH_COPY.titles.changePassword}</h1>
      <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
        {AUTH_COPY.changeLead}
      </p>
      <ChangePasswordForm />
    </GateFrame>
  );
}
