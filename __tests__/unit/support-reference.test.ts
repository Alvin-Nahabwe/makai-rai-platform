import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { AppError, NotImplementedError } from '@/lib/http/errors';
import { logRequestFailure, newSupportReference, stampReference } from '@/lib/http/supportReference';
import { toResponse } from '@/lib/http/toResponse';
import { NotFoundError } from '@/lib/data/tenant';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';
import { appClient, withOrg, type OrgContext } from '@/lib/data/tenant';
import { captureLogs, scanLines } from '../helpers/logCapture';

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
  expect(result).toMatchObject({ error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(REFERENCE) });
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
  expect(body).toEqual({ error: 'Not found', code: 'not_found' });
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

it('NFR-OBS-05: a reference is eight lowercase hexadecimal characters, a new one each time', () => {
  const seen = new Set(Array.from({ length: 50 }, () => newSupportReference()));
  expect(seen.size).toBe(50);
  for (const r of seen) expect(r).toMatch(REFERENCE);
});

it('NFR-MNT-01 NFR-OBS-05: any other thrown value answers 500 internal_error with a reference, and the bug stays visible in the log', async () => {
  for (const thrown of [new Error('boom'), prismaCode('P2002'), new AggregateError([nodeError('ECONNREFUSED'), nodeError('EACCES')], ''), 'a string was thrown', null]) {
    const { status, body, lines } = await answer(thrown);
    expect(status, String(thrown)).toBe(500);
    expect(body, String(thrown)).toMatchObject({ code: 'internal_error', message: 'internal_error', error: 'internal_error', reference: expect.stringMatching(REFERENCE) });
    expect(Object.keys(body).sort(), String(thrown)).toEqual(['code', 'error', 'message', 'reference']);
    // The reference is in exactly one line: the REQUEST_FAILED line. The error itself was printed before it was stamped.
    const hits = loggedFor(lines, body.reference);
    expect(hits, String(thrown)).toHaveLength(1);
    expect(JSON.parse(hits[0])).toMatchObject({ event: 'REQUEST_FAILED', status: 500, code: 'internal_error', reference: body.reference });
    expect(Object.keys(JSON.parse(hits[0])).sort()).toEqual(['at', 'code', 'event', 'reference', 'status']); // no cause
    expect(lines.length, String(thrown)).toBeGreaterThan(1); // the error's own print is there as well
  }
  // What Next printed when the error was rethrown is printed now: the message is in the log, and not in the body.
  const { body, lines } = await answer(new Error('the bug: a record had no owner'));
  expect(lines.some((l) => l.includes('the bug: a record had no owner'))).toBe(true);
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

describe('withOrg', () => {
  it('NFR-OBS-05: withOrg stamps a database-unavailable failure to connect with its support reference, and no other error', async () => {
    // A failure to connect happens in $transaction before any operation runs.
    const outage = unreachableDbError();
    const spy = vi.spyOn(appClient, '$transaction').mockRejectedValue(outage);
    try {
      await expect(withOrg({ orgId: 'org_1', role: 'owner' } as OrgContext, async () => 'unreached')).rejects.toBe(outage);
      expect((outage as Error & { digest?: string }).digest).toMatch(REFERENCE);
      const other = new Error('a bug in the callback');
      spy.mockRejectedValue(other);
      await expect(withOrg({ orgId: 'org_1', role: 'owner' } as OrgContext, async () => 'unreached')).rejects.toBe(other);
      expect('digest' in other).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
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
