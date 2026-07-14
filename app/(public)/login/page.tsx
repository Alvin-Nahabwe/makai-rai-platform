// app/(public)/login/page.tsx
'use client';

import { useState, Suspense } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const registered = searchParams.get('registered');
  const passwordChanged = searchParams.get('passwordChanged');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await signIn('credentials', { email, password, redirect: false });
    setLoading(false);
    if (result?.error) { setError('Invalid email or password'); }
    else { router.push('/dashboard'); }
  }

  return (
    <div className="auth-card">
      <Image src="/logo-makai.png" alt="MAK-AI" className="auth-logo" width={200} height={60} priority />
      <h1>Sign In</h1>
      {registered && <div className="auth-success" role="status">Account created. Please sign in.</div>}
      {passwordChanged && <div className="auth-success" role="status">Password changed. Please sign in with your new password.</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      <form onSubmit={handleSubmit}>
        <label htmlFor="email">Email</label>
        <input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit" className="btn-primary" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
      <p className="auth-footer">
        <Link href="/forgot-password">Forgot password?</Link>{' · '}<Link href="/register">Create account</Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-container">
      <Suspense fallback={<div className="auth-card"><p>Loading...</p></div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
