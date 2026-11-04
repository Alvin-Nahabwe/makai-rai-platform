import type { Metadata } from 'next';
import { ChangePasswordForm } from './ChangePasswordForm';

export const metadata: Metadata = { title: 'Change your password - MAK-AI RAI Platform' };

/**
 * S-29 Forced password change, and S-21's **Change password** (FR-ACC-08). Gate 2 sends a flagged account here and
 * nowhere else; ./layout.tsx runs the gates on a client-side navigation too.
 */
export default function ChangePasswordPage() {
  return (
    <div className="page-content">
      <div className="auth-card" style={{ maxWidth: 460, margin: '3rem auto' }}>
        <h1>Change your password</h1>
        <p className="text-muted" style={{ marginBottom: 'var(--space-4)' }}>
          Changing it ends every session of your account, including this one, and you sign in again with the new password.
        </p>
        <ChangePasswordForm />
      </div>
    </div>
  );
}
