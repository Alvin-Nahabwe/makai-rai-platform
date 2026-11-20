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
const { workingReportPdf, WorkingReportBusyError } = await import('@/lib/data/workingReportPdf');
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

/**
 * Fix wave item 15 (silent-failure audit M4): a second serialisation failure, or a transaction that could not start or ran out of time
 * (Prisma P2028) under a burst, is contention, not a bug. The download answers it as it answers a full queue: 503 `report_busy`,
 * which the route sends with Retry-After, never the generic 500.
 */
describe('workingReportPdf: contention in the read answers report_busy', () => {
  const LANES = Symbol.for('makrai.workingReportPdf.lanes');
  const store = globalThis as unknown as Record<symbol, unknown>;
  const withStubLanes = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const saved = store[LANES];
    const { createLimiter } = await import('@/lib/concurrency/limiter');
    store[LANES] = { limiter: createLimiter(1), pool: { render: async () => Buffer.from('%PDF-'), close: async () => {} } };
    try { return await fn(); } finally { store[LANES] = saved; }
  };

  it('two serialisation failures in a row: WorkingReportBusyError', async () => {
    failures = [serialisation(), serialisation()];
    await withStubLanes(() => expect(workingReportPdf(ctx, actor, 'p', 'all')).rejects.toBeInstanceOf(WorkingReportBusyError));
  });

  it('a transaction that could not start or expired (P2028): WorkingReportBusyError', async () => {
    failures = [Object.assign(new Error('Transaction API error'), { code: 'P2028' })];
    await withStubLanes(() => expect(workingReportPdf(ctx, actor, 'p', 'all')).rejects.toBeInstanceOf(WorkingReportBusyError));
  });

  it('any other failure is still thrown as itself', async () => {
    const other = new Error('boom');
    failures = [other];
    await withStubLanes(() => expect(workingReportPdf(ctx, actor, 'p', 'all')).rejects.toBe(other));
  });
});

/**
 * Fix round 1 (fix wave review I1): three conditions answer 503 `report_busy`, and the one log line toResponse writes must still say
 * which: `queue` (the limiter shed it), `serialization` (a second 40001) or `tx_timeout` (Prisma P2028). A fixed word only: no message
 * and no stack of the underlying error reaches the line.
 */
describe('report_busy keeps its cause in the log line', () => {
  const LANES = Symbol.for('makrai.workingReportPdf.lanes');
  const store = globalThis as unknown as Record<symbol, unknown>;
  async function loggedFor(fail: unknown[] | 'queue'): Promise<{ line: Record<string, unknown>; raw: string }> {
    const saved = store[LANES];
    const { createLimiter } = await import('@/lib/concurrency/limiter');
    const { toResponse } = await import('@/lib/http/toResponse');
    const limiter = createLimiter(1, { maxWaiting: 0 });
    let release = () => {};
    if (fail === 'queue') void limiter.run(() => new Promise<void>((r) => { release = r; }));
    else failures = fail;
    store[LANES] = { limiter, pool: { render: async () => Buffer.from('%PDF-'), close: async () => {} } };
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      const e = await workingReportPdf(ctx, actor, 'p', 'all').then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(WorkingReportBusyError);
      const res = toResponse(e);
      expect([res.status, (await res.json()).code]).toEqual([503, 'report_busy']);
    } finally {
      spy.mockRestore();
      release();
      store[LANES] = saved;
    }
    const raw = lines.find((l) => l.includes('REQUEST_FAILED'))!;
    return { line: JSON.parse(raw), raw };
  }

  it('queue: the limiter shed the download', async () => {
    const { line } = await loggedFor('queue');
    expect(line).toMatchObject({ status: 503, code: 'report_busy', cause: 'queue' });
  });
  it('serialization: a second serialisation failure, with no message or stack in the line', async () => {
    const { line, raw } = await loggedFor([serialisation(), serialisation()]);
    expect(line).toMatchObject({ status: 503, code: 'report_busy', cause: 'serialization' });
    expect(raw).not.toMatch(/could not serialize|stack|at /);
  });
  it('tx_timeout: a transaction that could not start or expired (P2028), with no message or stack in the line', async () => {
    const { line, raw } = await loggedFor([Object.assign(new Error('Transaction API error: secret'), { code: 'P2028' })]);
    expect(line).toMatchObject({ status: 503, code: 'report_busy', cause: 'tx_timeout' });
    expect(raw).not.toMatch(/Transaction API|secret|stack|at /);
  });
});
