import Link from 'next/link';
import Image from 'next/image';
import { ForgotPasswordClient } from './ForgotPasswordClient';

export const metadata = { title: 'Forgot password - MAK-AI RAI Platform' };

/** S-02 Forgot password (FR-ACC-06): ask for a reset link by email; the answer never says whether an account exists. */
export default function ForgotPasswordPage() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <Image src="/logo-makai.png" alt="MAK-AI" className="auth-logo" width={200} height={60} priority />
        <h1>Forgot password</h1>
        <ForgotPasswordClient />
        <p className="auth-footer">
          <Link href="/login" style={{ display: 'inline-block', minHeight: '24px' }}>Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
