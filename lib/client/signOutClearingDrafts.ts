import { signOut } from 'next-auth/react';

/** `DRAFT_PREFIX` of lib/client/drafts.ts, written here so the store stays out of the page (a test pins the two equal). */
export const DRAFT_KEY_PREFIX = 'makrai.draft.v1:';

/**
 * `LAST_PROJECT_PREFIX` of lib/client/lastProject.ts, written here for the same reason (plan 1A Task 12, fix round 1 F1c):
 * this module is on two public pages, and importing the store put it in their first visit. A test pins the two equal.
 */
export const LAST_PROJECT_KEY_PREFIX = 'makrai:last-project:';

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

/** Removes this person's last-project keys (`makrai:last-project:<userId>:…`), as lib/client/lastProject.ts's clearLastProjects does. */
function sweepLastProjects(userId: string): void {
  if (userId === '') return;
  const mine = `${LAST_PROJECT_KEY_PREFIX}${userId}:`;
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(mine)) keys.push(k);
    }
  } catch {
    // Storage refused all along (a privacy mode): this code could have written nothing there. Refused only now: a key may
    // stay, and the next person's first project page removes it (rememberLastProject). The two cases cannot be told
    // apart here, and a warning would fire at every sign-out of a browser that refuses storage, so this one is silent.
    return;
  }
  for (const k of keys) {
    try {
      localStorage.removeItem(k);
    } catch {
      // Storage that listed the key but refuses to remove it: the key stays on this device. Said once per key, in fixed
      // words, as clearLastProjects says it, because a leftover key is what S4 exists to prevent.
      console.warn('A last-project key could not be removed at sign-out.');
    }
  }
}

/**
 * A person-started sign-out that first removes this account's drafts from this device (NFR-PRIV-06), as the sidebar's
 * sign-out does. The draft store is imported inside the call, never at module load: imported statically it put about
 * 10 KB of source into the first visit of S-04 and S-05, over the owner's NFR-PERF-02 limit for those pages. It also removes
 * this account's last-project keys (plan 1A Task 12, L2-66), outside the drafts' try, so that does not depend on the
 * store's chunk loading.
 */
export async function signOutClearingDrafts(userId: string, callbackUrl: string): Promise<void> {
  sweepLastProjects(userId);
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
