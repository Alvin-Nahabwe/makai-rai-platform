import type { ReactElement, ReactNode } from 'react';

export type SignOutWithDraftsGuardProps = { userId: string; children: ReactNode };

/**
 * The guard around the sidebar's Sign out button (M-41, UX-26): when this device holds drafts of the person's answers it says so
 * before signing out. A slot of the shell (contract "Screens and slots"): UI renders it, DEC-b fills it. Until then it renders its
 * children as they are.
 */
// SLOT_STUB: DEC-b
export function SignOutWithDraftsGuard({ children }: SignOutWithDraftsGuardProps): ReactElement {
  return <>{children}</>;
}
