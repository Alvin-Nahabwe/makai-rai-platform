import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Task 9 (path to outputs; Task 6 review M6): `readWorkingReport` reads in one REPEATABLE READ `withOrg` with a 15 s limit, and runs
 * it again once, only on a serialisation failure (SQLSTATE 40001). A read-only snapshot cannot be made to fail that way against the
 * real database, so `withOrg` is replaced here; everything it would call inside the transaction is never reached.
 */

const calls: Array<{ isolationLevel?: string; timeoutMs?: number }> = [];
let failures: unknown[] = [];

vi.mock('@/lib/data/tenant', async (orig) => {
  const real = await orig<typeof import('@/lib/data/tenant')>();
  return {
    ...real,
    assertCan: vi.fn(),
    withOrg: vi.fn(async (_ctx: unknown, _cb: unknown, options: { isolationLevel?: string; timeoutMs?: number }) => {
      calls.push(options);
      const next = failures.shift();
      if (next !== undefined) throw next;
      return { record: 'r', summary: 's', content: 'c' };
    }),
  };
});

const { readWorkingReport, WORKING_REPORT_TIMEOUT_MS } = await import('@/lib/data/workingReport');
const serialisation = () => Object.assign(new Error('could not serialize access'), { meta: { driverAdapterError: { cause: { originalCode: '40001' } } } });
const ctx = { orgId: 'org' } as never;
const actor = { userId: 'u', role: 'viewer' } as const;

beforeEach(() => {
  calls.length = 0;
  failures = [];
});

describe('readWorkingReport: one snapshot, one retry', () => {
  it('reads at REPEATABLE READ with a 15 s limit', async () => {
    await expect(readWorkingReport(ctx, actor, 'p')).resolves.toEqual({ record: 'r', summary: 's', content: 'c' });
    expect(WORKING_REPORT_TIMEOUT_MS).toBe(15_000);
    expect(calls).toEqual([{ isolationLevel: 'RepeatableRead', timeoutMs: 15_000 }]);
  });

  it('a serialisation failure is retried once, in a new transaction', async () => {
    failures = [serialisation()];
    await expect(readWorkingReport(ctx, actor, 'p')).resolves.toEqual({ record: 'r', summary: 's', content: 'c' });
    expect(calls).toHaveLength(2);
  });

  it('a second serialisation failure is thrown, not retried again', async () => {
    failures = [serialisation(), serialisation()];
    await expect(readWorkingReport(ctx, actor, 'p')).rejects.toThrow('could not serialize access');
    expect(calls).toHaveLength(2);
  });

  it('any other failure is thrown at once', async () => {
    failures = [new Error('boom')];
    await expect(readWorkingReport(ctx, actor, 'p')).rejects.toThrow('boom');
    expect(calls).toHaveLength(1);
  });
});
