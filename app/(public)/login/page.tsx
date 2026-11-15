import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/AuthCard';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';
import { LoginForm } from './LoginClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.signIn) };

/** One stop: sign in. Too many sign-ins is a state of this page, on the same route (ruling L5-6). */
const ROUTE: readonly GateStop[] = [{ label: GATE_COPY.stops.signIn, state: 'current' }];

/**
 * S-01 Sign in (FR-ACC-05), in the public gate frame (plan 1B Task 2, ruling L5-6). The form is LoginClient.tsx's;
 * `useSearchParams` there needs the Suspense boundary, whose fallback already carries the heading. The logo is the frame
 * column's, not the card's (ruling L5-8).
 */
export default function LoginPage() {
  return (
    <GateFrame variant="public" route={ROUTE}>
      <Suspense fallback={<AuthCard title={AUTH_COPY.titles.signIn}><p>{AUTH_COPY.loading}</p></AuthCard>}>
        <LoginForm />
      </Suspense>
    </GateFrame>
  );
}
