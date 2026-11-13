import { AUTH_COPY } from '@/lib/auth/copy';
import { pageTitle } from '@/lib/ui/title';
import { ResetPasswordClient } from './ResetPasswordClient';

export const metadata = { title: pageTitle(AUTH_COPY.titles.resetPassword), referrer: 'no-referrer' as const };

/**
 * S-03 Set a new password (FR-ACC-06), opened from E-03's link. The token is in the address's fragment, which the browser
 * never sends; ResetPasswordClient.tsx reads it, clears it from the address, and sends it in the request body.
 */
export default function ResetPasswordPage() {
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
        <h1>Set a new password</h1>
        <ResetPasswordClient />
      </div>
    </div>
  );
}
