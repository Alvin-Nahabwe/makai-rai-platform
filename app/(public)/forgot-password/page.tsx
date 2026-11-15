import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';
import { ForgotPasswordClient } from './ForgotPasswordClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.forgotPassword) };

/** Ask for the link here, set the new password from it, then sign in with it (ruling L5-6). */
const ROUTE: readonly GateStop[] = [
  { label: AUTH_COPY.recoveryStops.askForLink, state: 'current' },
  { label: AUTH_COPY.recoveryStops.setNewPassword, state: 'upcoming' },
  { label: GATE_COPY.stops.signIn, state: 'upcoming' },
];

/**
 * S-02 Forgot password (FR-ACC-06), in the public gate frame (plan 1B Task 2): ask for a reset link by email; the answer
 * never says whether an account exists. The card's heading, lead, form and way back are ForgotPasswordClient.tsx's.
 */
export default function ForgotPasswordPage() {
  return (
    <GateFrame variant="public" route={ROUTE}>
      <ForgotPasswordClient />
    </GateFrame>
  );
}
