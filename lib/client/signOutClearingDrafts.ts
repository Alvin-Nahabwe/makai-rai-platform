import { signOut } from 'next-auth/react';
import { clearLastProjects } from '@/lib/client/lastProject';

/** `DRAFT_PREFIX` of lib/client/drafts.ts, written here so the store stays out of the page (a test pins the two equal). */
export const DRAFT_KEY_PREFIX = 'makrai.draft.v1:';

/**
 * Removes this account's draft keys from localStorage directly: the store's own `purgeAccount` without the store.
 * Used only when the store's chunk cannot load. Storage that cannot be read or written leaves the keys where they are.
 */
function sweepAccountDrafts(userId: string): void {
  if (userId === '') return;
  const mine = `${DRAFT_KEY_PREFIX}${userId}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(mine)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // No storage, or storage that refuses access (a privacy mode): there are no drafts this code can reach either.
  }
}

/**
 * A person-started sign-out that first removes this account's drafts from this device (NFR-PRIV-06), as the sidebar's
 * sign-out does. The draft store is imported inside the call, never at module load: imported statically it put about
 * 10 KB of source into the first visit of S-04 and S-05, over the owner's NFR-PERF-02 limit for those pages. It also removes
 * this account's last-project keys (plan 1A Task 12, L2-66), outside the drafts' try, so that does not depend on the
 * store's chunk loading; lib/client/lastProject.ts imports nothing, so it adds nothing of weight here.
 */
export async function signOutClearingDrafts(userId: string, callbackUrl: string): Promise<void> {
  clearLastProjects(userId);
  try {
    (await import('@/lib/client/drafts')).openDraftStore()?.purgeAccount(userId);
  } catch {
    // The sign-out must not depend on a chunk load. No later sign-in is sure to remove these drafts (the same account
    // keeps its own; the invitation page's sign-in purges nothing), so they are removed here without the store.
    console.warn('Draft store unavailable at sign-out; drafts were removed directly.');
    sweepAccountDrafts(userId);
  }
  await signOut({ callbackUrl });
}
