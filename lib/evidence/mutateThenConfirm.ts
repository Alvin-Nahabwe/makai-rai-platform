/**
 * Plan 1c Task 10, fix round 2.
 *
 * Extracted from `AssessmentPageClient.tsx`'s evidence mutation handlers so
 * the sequencing logic that round 2's bug lived in has somewhere it can
 * actually be unit-tested. `AssessmentPageClient.tsx` is a `'use client'`,
 * hook-bearing component; this repo has no jsdom/`@testing-library/react`
 * (D-169), so a hook-bearing component cannot be rendered or exercised by
 * `vitest` at all — only pure, hookless functions can. This function is
 * exactly that: no React, no hooks, no I/O of its own (it only calls the
 * two functions it is given), safe to import and call from any environment.
 *
 * THE BUG THIS EXISTS TO PREVENT RECURRING: round 1 made mutation success
 * trigger a re-fetch of the authoritative evidence list, but the re-fetch's
 * OWN failure was swallowed internally (logged, a global flag set) with no
 * way for the caller to learn the confirmation step — as opposed to the
 * mutation itself — was what failed. `AssessmentPageClient.tsx`'s handlers
 * then had no way to distinguish "the upload/delete failed" from "the
 * upload/delete succeeded but its result could not be confirmed", and threw
 * that distinction away. This function makes the distinction the return
 * type: `mutate-failed` (the write itself did not happen — safe to tell the
 * user their action failed) vs. `confirm-failed` (the write DID happen —
 * telling the user their action failed would be a different, worse lie)
 * vs. `ok` (both succeeded).
 */

export type MutateThenConfirmResult<E> =
  | { kind: 'mutate-failed'; error: E }
  | { kind: 'confirm-failed' }
  | { kind: 'ok' };

/**
 * Runs `mutate`, then — only if it succeeded — runs `confirm`. `confirm` is
 * never called when `mutate` fails (a failed write has nothing to confirm);
 * this is asserted by the non-vacuity test in
 * `__tests__/unit/mutate-then-confirm.test.ts` via a call-count spy, not
 * merely implied by the code's shape.
 *
 * Neither callback's own exceptions are caught here — they propagate to the
 * caller, which already wraps its call to this function in a `try`/`catch`
 * for the "something unexpected happened" case (matching the caller's
 * existing convention for every other fetch in that file). This function's
 * whole job is distinguishing the two EXPECTED failure shapes
 * (`mutate`/`confirm` each returning a rejection value rather than
 * throwing), not handling unexpected ones.
 */
export async function mutateThenConfirm<E>(
  mutate: () => Promise<{ ok: true } | { ok: false; error: E }>,
  confirm: () => Promise<boolean>,
): Promise<MutateThenConfirmResult<E>> {
  const mutation = await mutate();
  if (!mutation.ok) return { kind: 'mutate-failed', error: mutation.error };
  const confirmed = await confirm();
  return confirmed ? { kind: 'ok' } : { kind: 'confirm-failed' };
}
