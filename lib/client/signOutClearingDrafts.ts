import { signOut } from 'next-auth/react';
import { DRAFT_KEY_PREFIX } from '@/lib/client/draftKeys';

/** `DRAFT_PREFIX` of lib/client/drafts.ts, kept in lib/client/draftKeys.ts so the store stays out of the page (a test pins the two equal). */
export { DRAFT_KEY_PREFIX };

/**
 * `LAST_PROJECT_PREFIX` of lib/client/lastProject.ts, written here for the same reason (plan 1A Task 12, fix round 1 F1c):
 * this module is on two public pages, and importing the store put it in their first visit. A test pins the two equal.
 */
export const LAST_PROJECT_KEY_PREFIX = 'makrai:last-project:';

/**
 * Removes this account's draft keys from localStorage directly: the store's own `purgeAccount` without the store.
 * Used when the store's chunk cannot load, or loads and cannot open (its probe write refused). Storage that cannot be
 * read or written leaves the keys where they are.
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

/** How long the sign-out request may take before the press says the person is still signed in (SRS 7.4.1's 30 s). */
export const SIGN_OUT_TIMEOUT_MS = 30_000;
/** How long the draft store's chunk may take to load before the drafts are swept without it. */
const DRAFT_STORE_LOAD_MS = 10_000;

/** next-auth's answer did not say the session ended (a refused CSRF token, a server fault): the person is still signed in. */
export class SignOutNotEnded extends Error {
  constructor() {
    super('The sign-out did not end the session.');
    this.name = 'SignOutNotEnded';
  }
}

/** No answer to the sign-out within SIGN_OUT_TIMEOUT_MS: treated as not ended (a retry is safe either way). */
export class SignOutTimedOut extends Error {
  constructor() {
    super('The sign-out did not answer in time.');
    this.name = 'SignOutTimedOut';
  }
}

/** `p`, or a rejection with SignOutTimedOut after `ms`; the timer is cleared either way. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SignOutTimedOut()), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The address next-auth's sign-out answered with, when that answer says the session ended: an object whose `url` is an
 * absolute address (Auth.js always answers one) with no `error` parameter and not under /api/auth/ (its own sign-out or
 * error pages). Anything else is null: a MissingCSRF answer is a 200 with `?error=MissingCSRF` (d1-sfh F3), and a
 * configuration fault or a bad request is a body with no url (d2-sfh-1 finding 1). Never the caller's callbackUrl.
 */
function endedUrl(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const url = (data as { url?: unknown }).url;
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute address: not an answer Auth.js gives, so not one that says the session ended.
    return null;
  }
  if (parsed.searchParams.has('error') || parsed.pathname.startsWith('/api/auth/')) return null;
  return url;
}

/**
 * A person-started sign-out that first removes this account's drafts from this device (NFR-PRIV-06), as the sidebar's
 * sign-out does. The draft store is imported inside the call, never at module load: imported statically it put about
 * 10 KB of source into the first visit of S-04 and S-05, over the owner's NFR-PERF-02 limit for those pages. It also removes
 * this account's last-project keys (plan 1A Task 12, L2-66), outside the drafts' try, so that does not depend on the
 * store's chunk loading.
 *
 * The sign-out is asked of next-auth without its redirect, and the browser leaves the page only when the answer says the
 * session ended (lead's ruling L5-11): otherwise this rejects with SignOutNotEnded or SignOutTimedOut (or the request's
 * own error), navigates nowhere, and the caller's press says the person is still signed in. The drafts are already gone
 * by then, as M-41 said they would be.
 */
export async function signOutClearingDrafts(userId: string, callbackUrl: string): Promise<void> {
  sweepLastProjects(userId);
  try {
    const store = (await withTimeout(import('@/lib/client/drafts'), DRAFT_STORE_LOAD_MS)).openDraftStore();
    // Null: the store's probe write was refused (storage full, or writes blocked), which says nothing about whether the
    // account's drafts can be removed. They are swept directly, as when the chunk cannot load (ruling L5-24): M-41 has
    // promised the deletion.
    if (store === null) sweepAccountDrafts(userId);
    else store.purgeAccount(userId);
  } catch {
    // The sign-out must not depend on a chunk load, nor wait on one that hangs (d2-sfh-2 finding 3). No later sign-in is
    // sure to remove these drafts (the same account keeps its own; the invitation page's sign-in purges nothing), so they
    // are removed here without the store.
    console.warn('Draft store unavailable at sign-out; drafts were removed directly.');
    sweepAccountDrafts(userId);
  }
  const url = endedUrl(await withTimeout(signOut({ callbackUrl, redirect: false }), SIGN_OUT_TIMEOUT_MS));
  if (url === null) throw new SignOutNotEnded();
  window.location.href = url;
  // As next-auth's own redirect does (node_modules/next-auth/react.js:201-207): a fragment alone reloads nothing.
  if (url.includes('#')) window.location.reload();
}
