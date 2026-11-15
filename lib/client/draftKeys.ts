/**
 * `DRAFT_PREFIX` of lib/client/drafts.ts, written here so the store stays out of the pages that only need to know whether
 * an account has drafts on this device (a test pins the two equal, through lib/client/signOutClearingDrafts.ts). This module
 * imports nothing: the gate frame's Sign out reads it on S-05 and S-29, whose first visits are held to their budgets.
 */
export const DRAFT_KEY_PREFIX = 'makrai.draft.v1:';

/**
 * How many draft keys of this account this device holds (`makrai.draft.v1:<userId>:…`), by their keys alone: what M-41
 * warns about before a sign-out removes them (SignOutWithDraftsGuard, NFR-PRIV-06). The store's own `count` also leaves out
 * drafts past their seven days; those are removed by the same sign-out, so counting them here only says so. Storage that
 * cannot be read counts as none, as signOutClearingDrafts' sweep treats it: this code could have kept nothing there either.
 */
export function countAccountDrafts(userId: string): number {
  if (userId === '') return 0;
  const mine = `${DRAFT_KEY_PREFIX}${userId}:`;
  try {
    let n = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      if (localStorage.key(i)?.startsWith(mine)) n += 1;
    }
    return n;
  } catch {
    // No storage, or storage that refuses access (a privacy mode): there are no drafts this code can reach.
    return 0;
  }
}
