// app/(public)/login/page.tsx
import { Suspense } from 'react';
import { AUTH_COPY } from '@/lib/auth/copy';
import { pageTitle } from '@/lib/ui/title';
import { LoginForm } from './LoginClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.signIn) };

/** S-01 Sign in (FR-ACC-05). The form is LoginClient.tsx's; `useSearchParams` there needs the Suspense boundary. */
export default function LoginPage() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        {/* eslint-disable-next-line @next/next/no-img-element -- the file is already sized for the 48 px-high logo
            (app/globals.css), so next/image's client runtime stays off this public page (NFR-PERF-02;
            __tests__/unit/auth-logo.test.ts). */}
        <img
          src="/logo-makai-252.png"
          srcSet="/logo-makai-252.png 1x, /logo-makai-504.png 2x"
          alt={AUTH_COPY.logoAlt}
          className="auth-logo"
          width={200}
          height={60}
          fetchPriority="high"
        />
        <Suspense fallback={<p>{AUTH_COPY.loading}</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
