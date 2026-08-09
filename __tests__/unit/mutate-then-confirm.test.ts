import { describe, it, expect, vi } from 'vitest';
import { mutateThenConfirm } from '@/lib/evidence/mutateThenConfirm';

/**
 * Plan 1c Task 10, fix round 2 (Important, reviewer finding). Non-vacuity
 * evidence for the exact scenario the round-1 fix missed: a mutation that
 * succeeds, followed by a confirmation re-fetch that fails. See
 * `lib/evidence/mutateThenConfirm.ts`'s own module doc for why this logic
 * had to be extracted to be testable at all (`AssessmentPageClient.tsx` is
 * hook-bearing; this repo has no jsdom, D-169).
 */
describe('mutateThenConfirm', () => {
  it('returns mutate-failed, with the error, when the mutation itself fails -- and never calls confirm', async () => {
    const confirm = vi.fn(async () => true);
    const result = await mutateThenConfirm(
      async () => ({ ok: false as const, error: 'Could not attach this file.' }),
      confirm,
    );
    expect(result).toEqual({ kind: 'mutate-failed', error: 'Could not attach this file.' });
    // A failed write has nothing to confirm -- calling confirm() anyway
    // would be wasted work at best, and at worst could locally overwrite
    // state with a re-fetch result that has nothing to do with the mutation
    // that just failed.
    expect(confirm).not.toHaveBeenCalled();
  });

  it('returns ok when both the mutation and the confirmation succeed', async () => {
    const result = await mutateThenConfirm(
      async () => ({ ok: true as const }),
      async () => true,
    );
    expect(result).toEqual({ kind: 'ok' });
  });

  /**
   * THE BUG SCENARIO. Before round 2, this exact combination (mutation
   * succeeded, confirmation failed) was indistinguishable from `ok` at the
   * call site: `AssessmentPageClient.tsx`'s old `fetchEvidence` swallowed
   * its own failure and returned nothing (void), so the caller had no
   * signal at all. This test is the one that would have caught it.
   */
  it('returns confirm-failed -- not ok, not mutate-failed -- when the mutation succeeds but confirmation fails', async () => {
    const result = await mutateThenConfirm(
      async () => ({ ok: true as const }),
      async () => false,
    );
    expect(result).toEqual({ kind: 'confirm-failed' });
  });

  it('calls confirm only after mutate has resolved, not concurrently -- confirming a write that has not yet landed would be meaningless', async () => {
    const order: string[] = [];
    await mutateThenConfirm(
      async () => {
        order.push('mutate-start');
        await Promise.resolve();
        order.push('mutate-end');
        return { ok: true as const };
      },
      async () => {
        order.push('confirm-start');
        return true;
      },
    );
    expect(order).toEqual(['mutate-start', 'mutate-end', 'confirm-start']);
  });
});
