import Image from 'next/image';
import { ResetPasswordClient } from './ResetPasswordClient';

export const metadata = { title: 'Set a new password - MAK-AI RAI Platform', referrer: 'no-referrer' as const };

/**
 * S-03 Set a new password (FR-ACC-06), opened from E-03's link. The token is in the address's fragment, which the browser
 * never sends; ResetPasswordClient.tsx reads it, clears it from the address, and sends it in the request body.
 */
export default function ResetPasswordPage() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <Image src="/logo-makai.png" alt="MAK-AI" className="auth-logo" width={200} height={60} priority />
        <h1>Set a new password</h1>
        <ResetPasswordClient />
      </div>
    </div>
  );
}
