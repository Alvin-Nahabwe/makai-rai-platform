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
          Self-service password reset isn&apos;t available yet. To regain access, contact your
          platform administrator, who can reset your password from the admin panel.
        </p>
        <p className="auth-footer">
          <Link href="/login">← Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
