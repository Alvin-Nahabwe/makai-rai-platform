import { AuthCard } from '@/components/auth/AuthCard';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';
import { ResetPasswordClient } from './ResetPasswordClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.resetPassword), referrer: 'no-referrer' as const };

/** The link was asked for on S-02; the new password is set here; then the person signs in with it (ruling L5-6). */
const ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.askForLink, state: 'done' },
  { label: GATE_COPY.stops.setNewPassword, state: 'current' },
  { label: GATE_COPY.stops.signIn, state: 'upcoming' },
];

/**
 * S-03 Set a new password (FR-ACC-06), opened from E-03's link, in the public gate frame (plan 1B Task 2). The token is in
 * the address's fragment, which the browser never sends; ResetPasswordClient.tsx reads it, clears it from the address,
 * and sends it in the request body. The heading is the page's, so it is in the server's HTML before the token is read.
 */
export default function ResetPasswordPage() {
  return (
    <GateFrame variant="public" route={ROUTE}>
      <AuthCard title={AUTH_COPY.titles.resetPassword}>
        <ResetPasswordClient />
      </AuthCard>
    </GateFrame>
  );
}
