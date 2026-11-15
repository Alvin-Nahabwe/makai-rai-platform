import { Suspense } from 'react';
import { AuthCard } from '@/components/auth/AuthCard';
import { GateFrame } from '@/components/layout/GateFrame';
import { AUTH_COPY } from '@/lib/auth/copy';
import { pageTitle } from '@/lib/ui/title';
import { LoginForm, LoginRoute } from './LoginClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.signIn) };

/**
 * S-01 Sign in (FR-ACC-05), in the public gate frame (plan 1B Task 2, ruling L5-6). The form is LoginClient.tsx's;
 * `useSearchParams` there needs the Suspense boundary, whose fallback already carries the heading. The logo is the frame
 * column's, not the card's (ruling L5-8).
 */
export default function LoginPage() {
  return (
    // The route is Sign in (ruling L5-6; too many sign-ins is a state of this page), then D16's question once the sign-in
    // has worked (ruling L5-27): LoginRoute follows the form's step.
    <GateFrame variant="public" routeSlot={<LoginRoute />}>
      <Suspense fallback={<AuthCard title={AUTH_COPY.titles.signIn}><p>{AUTH_COPY.loading}</p></AuthCard>}>
        <LoginForm />
      </Suspense>
    </GateFrame>
  );
}
