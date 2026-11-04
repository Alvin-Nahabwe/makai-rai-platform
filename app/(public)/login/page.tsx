// app/(public)/login/page.tsx
import { Suspense } from 'react';
import Image from 'next/image';
import { LoginForm } from './LoginClient';

/** S-01 Sign in (FR-ACC-05). The form is LoginClient.tsx's; `useSearchParams` there needs the Suspense boundary. */
export default function LoginPage() {
  return (
    <div className="auth-container">
      <div className="auth-card">
        <Image src="/logo-makai.png" alt="MAK-AI" className="auth-logo" width={200} height={60} priority />
        <Suspense fallback={<p>Loading...</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
