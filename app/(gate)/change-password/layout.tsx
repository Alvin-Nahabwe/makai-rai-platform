import { requireIdentity } from '@/lib/auth/identity';

/**
 * Runs the gates for S-29 a second time, beside the page's own requireIdentity() (defence in depth; UX-01, threat A7 of
 * __tests__/lint/authenticated-page-gate.test.ts). It was added when S-29 shared the (authenticated) layout with S-21, whose
 * **Change password** link opened it by a client-side navigation that did not re-render that layout. Since plan 1B Task 1,
 * S-29 is in app/(gate), whose layout runs no gate (app/(gate)/layout.tsx), so the page and this file are its gates. Gate 2 lets a
 * flagged account through here, the one page it may reach (`requireIdentity` compares the proxy-set path), and gate 3
 * lets an account still missing an acceptance through too (ACCEPTANCE_EXEMPT_PATHS, lib/auth/identity.ts): route 35 is
 * usable before the acceptances.
 */
export default async function ChangePasswordLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return children;
}
