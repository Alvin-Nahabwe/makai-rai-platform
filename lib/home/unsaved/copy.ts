/**
 * Home's unsaved-changes line (plan 1B Task 10, spec 9.7 line 459), in a module of its own because the line is a client
 * component and lib/home/copy.ts is server only (ruling X-2). HOME_COPY re-exports it, so the words live here alone.
 */
export const HOME_UNSAVED_COPY = Object.freeze({
  unsaved: (n: number): string => (n === 1
    ? 'You have unsaved changes on 1 item in this browser.'
    : `You have unsaved changes on ${n} items in this browser.`),
});
