/**
 * The last project a person opened in an organisation (plan 1A Task 12, rulings P2/L2-64): the store of the last-project
 * keys. lib/client/signOutClearingDrafts.ts removes them too, without importing this file, to stay off the public pages'
 * first visit (fix round 1, F1c). This module imports nothing, which keeps it small wherever it is loaded.
 *
 * The key carries the person's own id and the organisation's slug (S4), so a second person on the same browser never reads
 * the first person's value; each person-started sign-out (the rail's, with or without drafts, and the four others of ruling
 * L2-66) removes this person's keys. The sign-out after a password change and the idle sign-out run no such code, so their
 * keys stay until another person opens a project on this browser: rememberLastProject removes every key that is not the
 * writer's (ruling L2-75). Until then such a key (a user id, an organisation slug, a project id; no name) is on the device.
 * The value is only a convenience for the rail's Findings link: the Projects page accepts it only when it is the id of one
 * of the organisation's own projects (S1), so a value that is missing, stale or unreadable costs one extra choice, never
 * access. That is why every failure here yields "nothing remembered" rather than an error.
 */

export const LAST_PROJECT_PREFIX = 'makrai:last-project:';
export const LAST_PROJECT_KEY = (userId: string, orgSlug: string): string => `${LAST_PROJECT_PREFIX}${userId}:${orgSlug}`;
/** Announced on `window` after a write, so a rail that is already on screen reads the new value (P2). */
export const LAST_PROJECT_EVENT = 'makrai:last-project';

/** The stored project id, or null when none is stored or storage cannot be read (absent, or refused by a privacy mode). */
export function readLastProject(userId: string, orgSlug: string): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY(userId, orgSlug));
  } catch {
    // No storage, or storage that refuses access: the rail then offers the plain "choose a project" address.
    return null;
  }
}

/**
 * Stores the project id and announces the write, after removing every last-project key that is not this person's (ruling
 * L2-75: the keys an idle or password-change sign-out left behind). Storage that refuses the write leaves nothing stored
 * and announces nothing.
 */
export function rememberLastProject(userId: string, orgSlug: string, projectId: string): void {
  removeOtherPeoplesKeys(userId);
  try {
    localStorage.setItem(LAST_PROJECT_KEY(userId, orgSlug), projectId);
  } catch {
    // Storage full, refused or absent: the Findings link stays the plain address, which still reaches every project.
    return;
  }
  window.dispatchEvent(new Event(LAST_PROJECT_EVENT));
}

/**
 * Removes every key of this person (`makrai:last-project:<userId>:…`) and no other person's; '' removes nothing. Called at
 * each person-started sign-out (ruling L2-66), drafts or none. Each removal is tried on its own, so one refused removal
 * does not keep the others.
 */
export function clearLastProjects(userId: string): void {
  if (userId === '') return;
  const mine = `${LAST_PROJECT_PREFIX}${userId}:`;
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
      // Storage that listed the key but refuses to remove it: the key stays on this device. Said once per key, as the
      // drafts' sign-out says its fallback, because a leftover key is what S4 exists to prevent.
      console.warn('A last-project key could not be removed at sign-out.');
    }
  }
}

/**
 * Removes every `makrai:last-project:` key that does not start `makrai:last-project:<userId>:`. Each step is tried on its
 * own and fails silently: it runs on every project page, and a key left by a refused removal is tried again on the next.
 */
function removeOtherPeoplesKeys(userId: string): void {
  if (userId === '') return;
  const mine = `${LAST_PROJECT_PREFIX}${userId}:`;
  const others: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k !== null && k.startsWith(LAST_PROJECT_PREFIX) && !k.startsWith(mine)) others.push(k);
    }
  } catch {
    // No storage, or storage that refuses to list: nothing is removed now. The write below is tried on its own, and the
    // next project page tries the removal again.
    return;
  }
  for (const k of others) {
    try {
      localStorage.removeItem(k);
    } catch {
      // Refused: tried again on the next project page.
    }
  }
}

/** Calls onChange after each write in this tab; returns the unsubscribe function (useSyncExternalStore's contract). */
export function subscribeLastProject(onChange: () => void): () => void {
  window.addEventListener(LAST_PROJECT_EVENT, onChange);
  return () => window.removeEventListener(LAST_PROJECT_EVENT, onChange);
}
