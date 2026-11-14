/**
 * The words of the unsaved work kept in this browser (copy audit B rows 161 to 164 and 222 to 225; answers Q1 and Q11;
 * plan 1A Task 17 part 17d): the list on My account (components/decision/DraftsOnThisDevice.tsx) and the warning at
 * sign-out (components/decision/SignOutWithDraftsGuard.tsx). Both are client components on signed-in pages only, so
 * these words ship there; they are kept out of lib/shell/copy.ts, which public pages load.
 */
export const DRAFTS_COPY = Object.freeze({
  list: Object.freeze({
    heading: 'Unsaved changes in this browser',
    count: (n: number): string => `Unsaved changes in this browser: ${n}`,
    mitigation: 'Mitigation',
    keptUntil: (date: string): string => ` (kept until ${date})`,
    deleteAll: 'Delete all unsaved changes',
  }),
  signOut: Object.freeze({
    /** M-41 (SRS 7.5.7), without its two bracketed actions, which are the buttons below it (answer Q11). */
    warning: (n: number): string => (n === 1
      ? 'You have 1 unsaved change in this browser. If you sign out, it will be deleted.'
      : `You have ${n} unsaved changes in this browser. If you sign out, they will be deleted.`),
    goToThem: 'Go to them',
    deleteAndSignOut: 'Delete them and sign out',
    cancel: 'Cancel',
  }),
});
