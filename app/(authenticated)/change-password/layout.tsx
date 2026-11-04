import { requireIdentity } from '@/lib/auth/identity';

/**
 * Runs the gates on a client-side navigation to S-29 (UX-01, threat A7 of __tests__/lint/authenticated-page-gate.test.ts):
 * Next does not re-render the group's root layout when S-21's **Change password** link opens this page. Gate 2 lets a
 * flagged account through here, the one page it may reach (`requireIdentity` compares the proxy-set path).
 */
export default async function ChangePasswordLayout({ children }: { children: React.ReactNode }) {
  await requireIdentity();
  return children;
}
