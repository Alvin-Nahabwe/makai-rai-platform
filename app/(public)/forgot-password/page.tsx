import Link from 'next/link';
import Image from 'next/image';

export const metadata = { title: 'Reset Password — MAK-AI RAI Toolkit' };

export default function ForgotPasswordPage() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <Image src="/logo-makai.png" alt="MAK-AI" className="auth-logo" width={200} height={60} priority />
        <h1>Reset Password</h1>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Password reset is not available yet. There is currently no way to reset a password
          from inside this application — including for administrators, who can deactivate and
          reactivate accounts but cannot change anyone&apos;s password.
        </p>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          To regain access, contact whoever operates this deployment directly. Self-service
          reset by email is planned.
        </p>
        <p className="auth-footer">
          <Link href="/login">← Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
