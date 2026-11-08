import Link from 'next/link';
import { ForgotPasswordClient } from './ForgotPasswordClient';

export const metadata = { title: 'Forgot password - MAK-AI RAI Platform' };

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
          alt="MAK-AI"
          className="auth-logo"
          width={200}
          height={60}
          fetchPriority="high"
        />
        <h1>Forgot password</h1>
        <ForgotPasswordClient />
        <p className="auth-footer">
          <Link href="/login" style={{ display: 'inline-block', minHeight: '24px' }}>Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
