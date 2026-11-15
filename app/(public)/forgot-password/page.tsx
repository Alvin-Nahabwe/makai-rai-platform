import Link from 'next/link';
import { AUTH_COPY } from '@/lib/auth/copy';
import { pageTitle } from '@/lib/ui/title';
import { ForgotPasswordClient } from './ForgotPasswordClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.forgotPassword) };

/** S-02 Forgot password (FR-ACC-06): ask for a reset link by email; the answer never says whether an account exists. */
export default function ForgotPasswordPage() {
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
        <h1>{AUTH_COPY.resetHeading}</h1>
        <ForgotPasswordClient />
        <p className="auth-footer">
          <Link href="/login" style={{ display: 'inline-block', minHeight: '24px' }}>{AUTH_COPY.backToSignIn}</Link>
        </p>
      </div>
    </div>
  );
}
