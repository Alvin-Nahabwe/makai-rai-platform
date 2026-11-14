import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AppError, NotImplementedError } from '@/lib/http/errors';
import { logRequestFailure, newSupportReference, stampReference, stampUnavailableOperation, withUnavailableStamp } from '@/lib/http/supportReference';
import { toResponse } from '@/lib/http/toResponse';
import { NotFoundError } from '@/lib/data/tenant';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { API_COPY } from '@/lib/http/api/copy';

/**
 * NFR-OBS-05 (SRS line 3376): every failed request answers with a support reference and writes one log line with
 * the same reference, so a person who reads the reference out can be matched to the server's side of what
 * happened. NFR-PRIV-03: that line holds ids and fixed names only, never the error's text, which for a
 * connection problem names the database host and port (H-S6).
 */

const HOST_MESSAGE = "Can't reach database server at 127.0.0.1:1";
const PRISMA_CODES = ['P1001', 'P1002', 'P1008', 'P1017'] as const;
const ADAPTER_KINDS = ['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'] as const;
const ERRNO_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'] as const;
const REFERENCE = /^[0-9a-f]{8}$/;

/** The shape K0b's unit test builds: a raw query that failed to reach the database through the adapter. */
function unreachableDbError(kind = 'DatabaseNotReachable') {
  return new Prisma.PrismaClientKnownRequestError(HOST_MESSAGE, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { kind } } },
  });
}
const prismaCode = (code: string) => new Prisma.PrismaClientKnownRequestError(HOST_MESSAGE, { code, clientVersion: 'test' });
const socketError = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:5441`), { code });
const nodeError = (code: string) => Object.assign(new Error(`connect ${code} 127.0.0.1:5441`), { code, errno: -111, syscall: 'connect' });

/** Answers `e` through toResponse and returns the body with every line logged meanwhile. */
async function answer(e: unknown) {
  const { result, lines } = await captureLogs(async () => {
    const r = toResponse(e);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  });
  return { ...result, lines };
}
const loggedFor = (lines: string[], reference: unknown) => lines.filter((l) => l.includes(String(reference)));

it('NFR-OBS-05 NFR-PRIV-03: a failed request logs one line with the reference and ids only', async () => {
  const { result, lines } = await captureLogs(async () => toResponse(unreachableDbError()).json());
  expect(result).toMatchObject({ error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(REFERENCE) });
  const hits = lines.filter((l) => l.includes(result.reference));
  expect(hits).toHaveLength(1);
  expect(Object.keys(JSON.parse(hits[0])).sort()).toEqual(['at', 'cause', 'code', 'event', 'reference', 'status']);
  expect(JSON.parse(hits[0]).cause).toBe('DatabaseNotReachable');
  expect(JSON.parse(hits[0])).toMatchObject({ event: 'REQUEST_FAILED', status: 503, code: 'database_unavailable', reference: result.reference });
  expect(new Date(JSON.parse(hits[0]).at).toISOString()).toBe(JSON.parse(hits[0]).at);
  expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
});

it('NFR-OBS-05: a 4xx answer carries no reference and logs nothing', async () => {
  const { status, body, lines } = await answer(new NotFoundError());
  expect(status).toBe(404);
  expect(body).toEqual({ error: API_COPY.notFound, code: 'not_found' });
  expect(lines).toEqual([]);
  const conflict = await answer(new AppError(409, 'project_archived'));
  expect(conflict.body).not.toHaveProperty('reference');
  expect(conflict.lines).toEqual([]);
});

it('NFR-OBS-05: a 500 or more from an AppError carries a reference and logs one line without a cause', async () => {
  for (const e of [new AppError(500, 'internal', 'Boom'), new NotImplementedError('CNT'), new AppError(503, 'rate_limited', 'Slow down')]) {
    const { status, body, lines } = await answer(e);
    expect(status).toBe(e.status);
    expect(body).toMatchObject({ code: e.code, reference: expect.stringMatching(REFERENCE) });
    const hits = loggedFor(lines, body.reference);
    expect(hits, e.code).toHaveLength(1);
    const line = JSON.parse(hits[0]);
    expect(Object.keys(line).sort(), e.code).toEqual(['at', 'code', 'event', 'reference', 'status']); // no cause key
    expect(line).toMatchObject({ event: 'REQUEST_FAILED', status: e.status, code: e.code });
  }
});

describe('the cause of a 503', () => {
  it('NFR-OBS-05 NFR-PRIV-03: only a 503 database_unavailable line carries a cause, and it is a fixed name, never the message', async () => {
    const reference = newSupportReference();
    const line = async (a: { status: number; code: string; cause?: string }) => {
      const { lines } = await captureLogs(async () => logRequestFailure({ reference, ...a }));
      expect(lines).toHaveLength(1);
      return JSON.parse(lines[0]) as Record<string, unknown>;
    };
    expect((await line({ status: 503, code: 'database_unavailable', cause: 'TooManyConnections' })).cause).toBe('TooManyConnections');
    expect(await line({ status: 500, code: 'internal', cause: 'TooManyConnections' })).not.toHaveProperty('cause');
    expect(await line({ status: 503, code: 'other', cause: 'P1001' })).not.toHaveProperty('cause');
    expect(await line({ status: 503, code: 'database_unavailable' })).not.toHaveProperty('cause');
    // Not one of the thirteen names: dropped, so no caller can put text into the line through `cause`.
    expect(await line({ status: 503, code: 'database_unavailable', cause: HOST_MESSAGE })).not.toHaveProperty('cause');
    expect(await line({ status: 503, code: 'database_unavailable', cause: 'ECONNREFUSED 127.0.0.1:5441' })).not.toHaveProperty('cause');

    // The eight names Prisma and the adapter give.
    for (const name of [...PRISMA_CODES, ...ADAPTER_KINDS]) {
      const e = (PRISMA_CODES as readonly string[]).includes(name) ? prismaCode(name) : unreachableDbError(name);
      const { status, body, lines } = await answer(e);
      expect(status, name).toBe(503);
      const hits = loggedFor(lines, body.reference);
      expect(hits, name).toHaveLength(1);
      expect(JSON.parse(hits[0]).cause, name).toBe(name);
      expect(`${JSON.stringify(body)}${lines.join('\n')}`, name).not.toMatch(/127\.0\.0\.1|can't reach|database server/i);
    }

    // The five errno names of a raw Node socket error (R11-21).
    for (const code of ERRNO_CODES) {
      const { status, body, lines } = await answer(socketError(code));
      expect(status, code).toBe(503);
      const hits = loggedFor(lines, body.reference);
      expect(hits, code).toHaveLength(1);
      expect(JSON.parse(hits[0]).cause, code).toBe(code);
      expect(`${JSON.stringify(body)}${lines.join('\n')}`, code).not.toContain('127.0.0.1:5441');
    }
  });

  it('NFR-OBS-05 NFR-AVL-04: a known request error whose own code is a network code (the shape CI printed) answers 503, logs that code as the cause, and the lane stamp runs', async () => {
    const shape = (code: string) => new Prisma.PrismaClientKnownRequestError('\nInvalid `prisma.user.findUnique()` invocation:\n\n\n', {
      code, clientVersion: '7.10.1', meta: { modelName: 'User' },
    });
    for (const code of ERRNO_CODES) {
      const e = shape(code);
      const { status, body, lines } = await answer(e);
      expect(status, code).toBe(503);
      const hits = loggedFor(lines, body.reference);
      expect(hits, code).toHaveLength(1);
      expect(JSON.parse(hits[0]).cause, code).toBe(code);
      expect(`${JSON.stringify(body)}${lines.join('\n')}`, code).not.toMatch(/User|findUnique/);
      // The hook the lane clients run stamps this shape too, so a page that fails on it shows a reference of its own.
      const hooked = shape(code);
      await expect(stampUnavailableOperation({ args: {}, query: async () => Promise.reject(hooked) })).rejects.toBe(hooked);
      expect((hooked as Error & { digest?: string }).digest, code).toMatch(REFERENCE);
    }
    // Another code on the same shape is not stamped.
    const other = shape('P2002');
    await expect(stampUnavailableOperation({ args: {}, query: async () => Promise.reject(other) })).rejects.toBe(other);
    expect('digest' in other).toBe(false);
  });

  it('NFR-OBS-05 NFR-AVL-04: the dual-stack refusal Node raises logs ECONNREFUSED, and the first errors[] entry decides when the error has no code', async () => {
    const e4 = nodeError('ECONNREFUSED');
    const e6 = nodeError('ECONNREFUSED');
    const cases: Array<[string, unknown, string]> = [
      ['own code', Object.assign(new AggregateError([e4, e6], 'connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'ECONNREFUSED'],
      ['no own code', new AggregateError([e4, e6], 'connect ECONNREFUSED'), 'ECONNREFUSED'],
      ['first entry decides', new AggregateError([nodeError('ECONNRESET'), nodeError('ECONNREFUSED')], 'x'), 'ECONNRESET'],
      ['own code before entries', Object.assign(new AggregateError([nodeError('ECONNRESET')], 'x'), { code: 'ETIMEDOUT' }), 'ETIMEDOUT'],
    ];
    for (const [why, e, cause] of cases) {
      expect(isDatabaseUnavailable(e), why).toBe(true);
      const { status, body, lines } = await answer(e);
      expect(status, why).toBe(503);
      const hits = loggedFor(lines, body.reference);
      expect(hits, why).toHaveLength(1);
      expect(JSON.parse(hits[0]).cause, why).toBe(cause);
      expect(`${JSON.stringify(body)}${lines.join('\n')}`, why).not.toMatch(/127\.0\.0\.1|5441/);
    }
  });

  it('NFR-OBS-05: a DriverAdapterError logs the kind it carries, and the code wins over a kind on a Prisma error', async () => {
    class DriverAdapterError extends Error {
      name = 'DriverAdapterError';
      constructor(readonly cause: { kind: string }) {
        super(cause.kind);
      }
    }
    const driver = await answer(new DriverAdapterError({ kind: 'SocketTimeout' }));
    expect(driver.status).toBe(503);
    expect(JSON.parse(loggedFor(driver.lines, driver.body.reference)[0]).cause).toBe('SocketTimeout');
    const both = new Prisma.PrismaClientKnownRequestError(HOST_MESSAGE, {
      code: 'P1001',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { kind: 'ConnectionClosed' } } },
    });
    const wins = await answer(both);
    expect(JSON.parse(loggedFor(wins.lines, wins.body.reference)[0]).cause).toBe('P1001');
  });

  it('NFR-OBS-05: the thirteen names are exactly what isDatabaseUnavailable matches', () => {
    const src = readFileSync('lib/data/pgErrors.ts', 'utf8');
    const listed = (name: string) =>
      [...(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([^\\]]*)\\]`).exec(src)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(listed('UNAVAILABLE_CODES')).toEqual([...PRISMA_CODES].sort());
    expect(listed('UNAVAILABLE_KINDS')).toEqual([...ADAPTER_KINDS].sort());
    expect(listed('NETWORK_CODES')).toEqual([...ERRNO_CODES].sort());
  });
});

it('NFR-OBS-05 (round 9c): the reference is put after the spread of extra, so no caller value replaces the logged one', async () => {
  const { status, body, lines } = await answer(new AppError(500, 'internal', 'Boom', { reference: 'deadbeef' } as never));
  expect(status).toBe(500);
  expect(body.reference).toMatch(REFERENCE);
  expect(body.reference).not.toBe('deadbeef');
  expect(loggedFor(lines, body.reference)).toHaveLength(1);
  expect(lines.join('\n')).not.toContain('deadbeef');
  // The two fixed keys still win over extra, as before.
  expect(await answer(new AppError(500, 'real', 'real message', { error: 'x', code: 'x' } as never))).toMatchObject({ body: { error: 'real message', code: 'real' } });
});

/** The one REQUEST_FAILED line an unmapped error writes, parsed; the reference is in this line and no other. */
function failedLine(lines: string[], reference: unknown): { error: { name: string; code?: string; frames: string[] } } & Record<string, unknown> {
  const hits = loggedFor(lines, reference);
  expect(hits, 'the reference is in exactly one log line').toHaveLength(1);
  return JSON.parse(hits[0]);
}

it('NFR-PRIV-03 NFR-OBS-01 NFR-OBS-05 SPEC-2 CR-2: a planted email in an unmapped error is not in the log, and the class and frames are in the one line', async () => {
  const { body, lines } = await answer(new Error('lookup failed for planted@b.org with reason secret reason text'));
  expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  expect(lines.join('\n')).not.toContain('secret reason');
  expect(lines.some((l) => l.includes('UNMAPPED_ERROR'))).toBe(false);
  const line = failedLine(lines, body.reference);
  expect(line).toMatchObject({ event: 'REQUEST_FAILED', status: 500, code: 'internal_error', reference: body.reference, error: { name: 'Error' } });
  expect(line.error.frames.length).toBeGreaterThan(0);
  expect(line.error.frames.length).toBeLessThanOrEqual(10);
  expect('code' in line.error).toBe(false);
});

it('NFR-PRIV-03 NFR-OBS-01 SPEC-2: a Prisma-shaped unmapped error logs its code and not its address', async () => {
  const { body, lines } = await answer(Object.assign(new Error('Unique constraint failed on x@y.org'), { code: 'P2002' }));
  expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  expect(failedLine(lines, body.reference).error.code).toBe('P2002');
  expect(lines.join('\n')).not.toContain('@y.org');
});

it('NFR-PRIV-03 CR-3 SFH-6: a second message line that starts with "at" is not read as a frame', async () => {
  for (const message of ['lookup failed\n    at secret reason', 'first\nsecond\n    at secret reason of the third line']) {
    const { body, lines } = await answer(new Error(message));
    expect(lines.join('\n'), message).not.toContain('secret reason');
    expect(failedLine(lines, body.reference).error.frames.length, message).toBeGreaterThan(0);
  }
});

it('NFR-OBS-05 CR-4: a thrown object whose properties throw on read still answers 500 with a reference', async () => {
  const hostile = {
    get constructor(): never { throw new Error('constructor getter'); },
    get code(): never { throw new Error('code getter'); },
    get stack(): never { throw new Error('stack getter'); },
  };
  const { status, body, lines } = await answer(hostile);
  expect(status).toBe(500);
  expect(body).toMatchObject({ code: 'internal_error', reference: expect.stringMatching(REFERENCE) });
  expect(failedLine(lines, body.reference).error).toEqual({ name: 'object', frames: [] });
});

it('NFR-OBS-05: a reference is eight lowercase hexadecimal characters, a new one each time', () => {
  const seen = new Set(Array.from({ length: 50 }, () => newSupportReference()));
  expect(seen.size).toBe(50);
  for (const r of seen) expect(r).toMatch(REFERENCE);
});

it('NFR-MNT-01 NFR-OBS-05: any other thrown value answers 500 internal_error with a reference, and the bug stays visible in the log', async () => {
  for (const thrown of [new Error('boom'), prismaCode('P2002'), new AggregateError([nodeError('ECONNREFUSED'), nodeError('EACCES')], ''), 'a string was thrown', null]) {
    const { status, body, lines } = await answer(thrown);
    expect(status, String(thrown)).toBe(500);
    expect(body, String(thrown)).toMatchObject({ code: 'internal_error', message: API_COPY.internalError(String(body.reference)), error: API_COPY.internalError(String(body.reference)), reference: expect.stringMatching(REFERENCE) });
    expect(Object.keys(body).sort(), String(thrown)).toEqual(['code', 'error', 'message', 'reference']);
    // The reference is in exactly one line (NFR-OBS-05): the REQUEST_FAILED line, which also carries the class and frames.
    const hits = loggedFor(lines, body.reference);
    expect(hits, String(thrown)).toHaveLength(1);
    const failed = hits[0];
    expect(JSON.parse(failed)).toMatchObject({ event: 'REQUEST_FAILED', status: 500, code: 'internal_error', reference: body.reference });
    expect(Object.keys(JSON.parse(failed)).sort()).toEqual(['at', 'code', 'error', 'event', 'reference', 'status']); // no cause
  }
  // The bug stays visible in the log by its class name and a frame, not by its message; the body has no message either.
  const { body, lines } = await answer(new Error('the bug: a record had no owner'));
  const unmapped = failedLine(lines, body.reference).error;
  expect(unmapped.name).toBe('Error');
  expect(unmapped.frames.length).toBeGreaterThan(0);
  expect(lines.some((l) => l.includes('the bug: a record had no owner'))).toBe(false);
  expect(JSON.stringify(body)).not.toContain('record had no owner');
  // The error carries the reference it was answered with.
  const e = new Error('carries it');
  const a = await answer(e);
  expect((e as Error & { digest?: string }).digest).toBe(a.body.reference);
});


// ---- one reference per failure (C4 round 1 item 5) ---------------------------------------------------------------

describe('stampReference', () => {
  it('NFR-OBS-05: an object that carries no digest gets a fresh reference as its digest, once; one that carries a digest keeps it', () => {
    const e = new Error('x');
    const ref = stampReference(e);
    expect(ref).toMatch(REFERENCE);
    expect((e as Error & { digest?: string }).digest).toBe(ref);
    expect(stampReference(e)).toBe(ref); // the same error, the same reference
    // Next keeps a digest the error already carries (create-error-handler.js:79-81), so the page shows this one.
    const next = Object.assign(new Error('y'), { digest: '1234567890' });
    expect(stampReference(next)).toBe('1234567890');
    expect((next as Error & { digest?: string }).digest).toBe('1234567890');
    // Two failures, two references.
    expect(stampReference(new Error('z'))).not.toBe(ref);
  });

  it('NFR-OBS-05: anything that is not an object, or cannot take a digest, gets a fresh reference and no exception', () => {
    for (const v of [null, undefined, 'a string', 42, true]) expect(stampReference(v), String(v)).toMatch(REFERENCE);
    const frozen = Object.freeze(new Error('frozen'));
    expect(stampReference(frozen)).toMatch(REFERENCE);
    expect('digest' in frozen).toBe(false);
    // A digest that is not a string does not count as one.
    const odd = Object.assign(new Error('odd'), { digest: 42 });
    expect(stampReference(odd)).toMatch(REFERENCE);
    expect((odd as Error & { digest?: unknown }).digest).toMatch(REFERENCE);
  });
});

describe('the lane clients\' hook', () => {
  it('NFR-OBS-05: stampUnavailableOperation stamps a database-unavailable error and rethrows that same error; any other error and any result pass untouched', async () => {
    const outage = unreachableDbError();
    await expect(stampUnavailableOperation({ args: {}, query: async () => Promise.reject(outage) })).rejects.toBe(outage);
    expect((outage as Error & { digest?: string }).digest).toMatch(REFERENCE);
    const other = new Error('not an outage');
    await expect(stampUnavailableOperation({ args: {}, query: async () => Promise.reject(other) })).rejects.toBe(other);
    expect('digest' in other).toBe(false);
    await expect(stampUnavailableOperation({ args: { a: 1 }, query: async (a) => ({ got: a }) })).resolves.toEqual({ got: { a: 1 } });
  });

  it('NFR-OBS-05: a real Prisma client wrapped by withUnavailableStamp stamps a refused connection on a model query and on a raw query, one reference per failure', async () => {
    const pool = new Pool({ connectionString: 'postgresql://u:p@127.0.0.1:1/x', max: 1 });
    const client = withUnavailableStamp(new PrismaClient({ adapter: new PrismaPg(pool) }));
    try {
      const errors: unknown[] = [];
      for (const call of [() => client.user.findFirst(), () => client.$queryRaw`SELECT 1`, () => client.user.findFirst()])
        await call().then(() => errors.push(null), (e: unknown) => errors.push(e));
      for (const e of errors) {
        expect(isDatabaseUnavailable(e)).toBe(true);
        expect((e as Error & { digest?: string }).digest).toMatch(REFERENCE);
      }
      expect(new Set(errors.map((e) => (e as Error & { digest?: string }).digest)).size).toBe(3);
    } finally {
      await client.$disconnect();
      await pool.end();
    }
  });

  it('NFR-OBS-05: a batch $transaction and an interactive $transaction fail at connect before any operation runs, and each leaves with a reference of its own', async () => {
    // $allOperations never sees $transaction itself, so a failure to connect there needs the wrapper's own stamp.
    const pool = new Pool({ connectionString: 'postgresql://u:p@127.0.0.1:1/x', max: 1 });
    const client = withUnavailableStamp(new PrismaClient({ adapter: new PrismaPg(pool) }));
    try {
      const errors: unknown[] = [];
      for (const call of [
        () => client.user.findFirst(),
        () => client.$transaction([client.user.findFirst(), client.user.findFirst()]),
        () => client.$transaction(async (tx) => tx.user.findFirst()),
        () => client.$transaction(async () => 'unreached', { timeout: 2000 }),
      ])
        await call().then(() => errors.push(null), (e: unknown) => errors.push(e));
      for (const e of errors) {
        expect(isDatabaseUnavailable(e)).toBe(true);
        expect((e as Error & { digest?: string }).digest).toMatch(REFERENCE);
      }
      expect(new Set(errors.map((e) => (e as Error & { digest?: string }).digest)).size).toBe(4);
    } finally {
      await client.$disconnect();
      await pool.end();
    }
  });

  it('NFR-OBS-05: the $transaction stamp touches only an unavailable error, rethrows the same error, and leaves the client\'s other members as they were', async () => {
    const outage = unreachableDbError();
    const other = new Error('the callback threw');
    const calls: unknown[][] = [];
    const extended = {
      $transaction: async (...args: unknown[]) => {
        calls.push(args);
        const first = args[0];
        if (first === 'outage') throw outage;
        if (first === 'other') throw other;
        return 'result';
      },
      $queryRaw: function (this: unknown) { return this === extended ? 'bound to the extended client' : 'lost its client'; },
      user: { findFirst: () => 'model delegate' },
    };
    const wrapped = withUnavailableStamp({ $extends: () => extended } as unknown as PrismaClient);
    await expect(wrapped.$transaction('outage' as never)).rejects.toBe(outage);
    expect((outage as Error & { digest?: string }).digest).toMatch(REFERENCE);
    await expect(wrapped.$transaction('other' as never)).rejects.toBe(other);
    expect('digest' in other).toBe(false);
    await expect(wrapped.$transaction('ok' as never, { timeout: 5 } as never)).resolves.toBe('result');
    expect(calls[2]).toEqual(['ok', { timeout: 5 }]);
    expect((wrapped.$queryRaw as unknown as () => string)()).toBe('bound to the extended client');
    expect((wrapped as unknown as { user: { findFirst: () => string } }).user.findFirst()).toBe('model delegate');
  });

  it('NFR-OBS-05: every lane client is made through withUnavailableStamp, and the one cast lives in that helper, so no caller casts on its own', () => {
    for (const file of ['lib/data/tenant.ts', 'lib/data/identity.ts', 'lib/data/identityClient.ts', 'lib/data/preauth.ts']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toMatch(/withUnavailableStamp\(\s*new PrismaClient\(/);
      expect(src, `${file} casts the client itself`).not.toMatch(/as unknown as PrismaClient/);
    }
    const helper = readFileSync('lib/http/supportReference.ts', 'utf8');
    expect(helper.match(/as unknown as PrismaClient/g)).toHaveLength(1);
    expect(helper).toMatch(/\$extends\(\{ query: \{ \$allOperations: stampUnavailableOperation \} \}\)/);
  });
});

it('NFR-PRIV-03 FIX-8: a message shortened after its stack was read leaves no message line in the log', async () => {
  const { toResponse } = await import('@/lib/http/toResponse');
  const e = new Error('lookup failed\n    at secret reason text');
  void e.stack; // V8 fixes the stack's header at the first read
  e.message = 'lookup failed';
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try {
    expect(toResponse(e).status).toBe(500);
  } finally {
    spy.mockRestore();
  }
  expect(lines.join('\n')).not.toContain('secret reason');
  expect(lines).toHaveLength(1);
});

it('NFR-OBS-05: the body and the REQUEST_FAILED line carry the reference the error carries, so the page and the log agree', async () => {
  // An outage stamped where it left lib/data keeps that reference through toResponse.
  const stamped = unreachableDbError();
  const ref = stampReference(stamped);
  const a = await answer(stamped);
  expect(a.body.reference).toBe(ref);
  expect(loggedFor(a.lines, ref)).toHaveLength(1);
  // A 5xx AppError is stamped too: the error object ends up carrying the reference of the body.
  const boom = new AppError(500, 'internal', 'Boom');
  const b = await answer(boom);
  expect((boom as Error & { digest?: string }).digest).toBe(b.body.reference);
  // The same error answered twice is the same failure: the same reference.
  expect((await answer(boom)).body.reference).toBe(b.body.reference);
  // A digest Next gave is kept (a render error that reached a route), and a different failure gets a different reference.
  const given = Object.assign(new AppError(500, 'internal', 'Boom'), { digest: '1234567890' });
  expect((await answer(given)).body.reference).toBe('1234567890');
  expect((await answer(new AppError(500, 'internal', 'Boom'))).body.reference).not.toBe(b.body.reference);
});
