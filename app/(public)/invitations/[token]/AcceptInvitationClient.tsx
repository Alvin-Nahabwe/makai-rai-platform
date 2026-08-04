'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import type { OrgRole } from '@prisma/client';

interface Props {
  token: string;
  invitedEmail: string;
  orgName: string;
  role: OrgRole;
  /** The currently-authenticated visitor's email, fresh from the database
   * (see the server page's module doc) — `null` when nobody is signed in. */
  viewerEmail: string | null;
}

/**
 * Three branches, chosen by `viewerEmail` vs `invitedEmail`, none of which
 * ever authenticate anyone as a side effect of THIS component (Task 8
 * brief / D-098 decision 9):
 *
 *  1. Signed in as the invited email -> a single "Accept" action that POSTs
 *     to the accept endpoint using the EXISTING session.
 *  2. Signed in as a DIFFERENT email -> refuse client-side (matches what
 *     the server would refuse anyway) and offer to sign out.
 *  3. Signed out -> log in (existing account) or register (new account,
 *     email fixed from the invitation, not an input on the form) — either
 *     path lands back on THIS page via `callbackUrl`/redirect, and
 *     acceptance itself only ever happens from branch 1, after a real
 *     login has occurred.
 */
export default function AcceptInvitationClient({ token, invitedEmail, orgName, role, viewerEmail }: Props) {
  const returnTo = `/invitations/${token}`;

  if (viewerEmail !== null && viewerEmail.toLowerCase() === invitedEmail.toLowerCase()) {
    return <AcceptAction token={token} />;
  }

  if (viewerEmail !== null) {
    return (
      <div>
        <p className="auth-error" role="alert">
          You&apos;re signed in as <strong>{viewerEmail}</strong>, but this invitation is for{' '}
          <strong>{invitedEmail}</strong>.
        </p>
        <p className="text-muted">Sign out and sign in with that account to accept it.</p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => signOut({ callbackUrl: `/login?callbackUrl=${encodeURIComponent(returnTo)}` })}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <AnonymousChoice
      token={token} invitedEmail={invitedEmail} orgName={orgName} role={role} returnTo={returnTo}
    />
  );
}

function AcceptAction({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleAccept() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/invitations/${token}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not accept this invitation.');
        return;
      }
      // `/` is the org dispatcher (app/page.tsx) — it resolves the right
      // org from membership, same as every other post-auth landing in this
      // app; there is no `slug` in `acceptInvitation`'s return to build a
      // direct `/orgs/{slug}/dashboard` link from (Task 8 constraint 3: no
      // email sending / link-building beyond the one-time accept link).
      router.push('/');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <button type="button" className="btn-primary" onClick={handleAccept} disabled={loading}>
        {loading ? 'Joining…' : 'Accept invitation'}
      </button>
    </div>
  );
}

function AnonymousChoice({
  token, invitedEmail, orgName, role, returnTo,
}: { token: string; invitedEmail: string; orgName: string; role: OrgRole; returnTo: string }) {
  const [mode, setMode] = useState<'choice' | 'register'>('choice');

  if (mode === 'choice') {
    return (
      <div className="auth-footer" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <a className="btn-primary" href={`/login?callbackUrl=${encodeURIComponent(returnTo)}`}>
          I already have an account — log in
        </a>
        <button type="button" className="btn-primary" onClick={() => setMode('register')}>
          Create an account as {invitedEmail}
        </button>
      </div>
    );
  }

  return (
    <RegisterForInvitationForm
      token={token} invitedEmail={invitedEmail} orgName={orgName} role={role} returnTo={returnTo}
    />
  );
}

function RegisterForInvitationForm({
  token, invitedEmail, orgName, role, returnTo,
}: { token: string; invitedEmail: string; orgName: string; role: OrgRole; returnTo: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '', password: '', confirmPassword: '', termsAccepted: false, researchConsent: false,
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirmPassword) { setError('Passwords do not match'); return; }

    setLoading(true);
    try {
      const res = await fetch(`/api/v1/invitations/${token}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No `email` field — the account's email is fixed server-side from
        // the invitation (Task 8 brief property 5); this form has nothing
        // to send for it, deliberately.
        body: JSON.stringify({
          name: form.name, password: form.password,
          termsAccepted: form.termsAccepted, researchConsent: form.researchConsent,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error); return; }
      router.push(`/login?registered=true&callbackUrl=${encodeURIComponent(returnTo)}`);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <p className="text-muted">
        Creating an account for <strong>{invitedEmail}</strong> to join <strong>{orgName}</strong> as{' '}
        <strong>{role}</strong>.
      </p>
      {error && <div className="auth-error" role="alert">{error}</div>}
      <label htmlFor="inv-name">Full Name</label>
      <input id="inv-name" type="text" required autoComplete="name" value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label htmlFor="inv-password">Password</label>
      <input id="inv-password" type="password" required autoComplete="new-password" minLength={8}
        value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      <label htmlFor="inv-confirmPassword">Confirm Password</label>
      <input id="inv-confirmPassword" type="password" required autoComplete="new-password"
        value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} />
      <div className="consent-group">
        <label className="checkbox-label">
          <input type="checkbox" required checked={form.termsAccepted}
            onChange={(e) => setForm({ ...form, termsAccepted: e.target.checked })} />
          I agree to the <a href="/terms" target="_blank">Terms of Service</a> and{' '}
          <a href="/privacy" target="_blank">Privacy Policy</a> (required)
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.researchConsent}
            onChange={(e) => setForm({ ...form, researchConsent: e.target.checked })} />
          I consent to my anonymized assessment data being used for research on responsible AI
          practices in Africa (optional)
        </label>
      </div>
      <button type="submit" className="btn-primary" disabled={loading}>
        {loading ? 'Creating Account…' : 'Create Account'}
      </button>
    </form>
  );
}
