import { AuthCard } from '@/components/auth/AuthCard';
import { GateFrame } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { pageTitle } from '@/lib/ui/title';
import { ResetPasswordClient, ResetRoute, ResetTitle } from './ResetPasswordClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.resetPassword), referrer: 'no-referrer' as const };

/**
 * S-03 Set a new password (FR-ACC-06), opened from E-03's link, in the public gate frame (plan 1B Task 2). The token is in
 * the address's fragment, which the browser never sends; ResetPasswordClient.tsx reads it, clears it from the address,
 * and sends it in the request body. The heading is the page's, so it is in the server's HTML before the token is read
 * (the step's name until the browser knows the link cannot be used).
 */
export default function ResetPasswordPage() {
  return (
    // Ask for a link (done), Set a new password (current), Sign in; with a link that cannot be used, Ask for a link is
    // current again and the heading says so (design review I-6). ResetRoute and ResetTitle follow the client's state.
    <GateFrame variant="public" routeSlot={<ResetRoute />}>
      <AuthCard title={<ResetTitle />}>
        <ResetPasswordClient />
      </AuthCard>
    </GateFrame>
  );
}
