import { signOut } from 'next-auth/react';

/**
 * A person-started sign-out that first removes this account's drafts from this device (NFR-PRIV-06), as the sidebar's
 * sign-out does. The draft store is imported inside the call, never at module load: imported statically it put about
 * 10 KB of source into the first visit of S-04 and S-05, over the owner's NFR-PERF-02 limit for those pages.
 */
export async function signOutClearingDrafts(userId: string, callbackUrl: string): Promise<void> {
  try {
    (await import('@/lib/client/drafts')).openDraftStore()?.purgeAccount(userId);
  } catch {
    // The drafts stay on this device until the next sign-in of another account, which purges them through
    // purgeOtherAccounts; the sign-out must not depend on a chunk load.
  }
  await signOut({ callbackUrl });
}
