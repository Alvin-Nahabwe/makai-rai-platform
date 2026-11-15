import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  AppError, ValidationFailed, ConflictError, RateLimitedError, ErasedError, NotImplementedError,
  AcceptancesRequiredError,
} from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { assertSameOrigin } from '@/lib/http/sameOrigin';
import { isUniqueViolation, uniqueViolationIndex, isDatabaseUnavailable } from '@/lib/data/pgErrors';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { API_COPY } from '@/lib/http/api/copy';
import { HTTP_COPY } from '@/lib/http/copy';

/**
 * A look-alike of `DriverAdapterError` from `@prisma/driver-adapter-utils`, which package.json does not list (it comes in
 * through @prisma/client), so this file does not import it. The real class is
 * `class extends Error { name = 'DriverAdapterError'; cause; constructor(payload) { super(payload.message ?? payload.kind); this.cause = payload; } }`
 * (node_modules/@prisma/driver-adapter-utils/dist/index.js:43-50); pgErrors.ts matches it by that name and by `cause.kind`.
 */
class DriverAdapterError extends Error {
  name = 'DriverAdapterError';
  cause: unknown;
  constructor(payload: { kind: string; message?: string; [k: string]: unknown }) {
    super(typeof payload.message === 'string' ? payload.message : payload.kind);
    this.cause = payload;
  }
}

const ADAPTER = (cause: object, code = 'P2010', message = 'x') => Object.assign(
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: '7.10.1', meta: { driverAdapterError: { cause } } }), {});

/** A request as the handler sees it: the `Host` header and, for a browser write, `Origin`. */
function req(h: { origin?: string; host?: string }): Request {
  const headers: Record<string, string> = {};
  if (h.origin !== undefined) headers.origin = h.origin;
  if (h.host !== undefined) headers.host = h.host;
  return new Request('https://makrai.org/api/v1/orgs/acme/members', { method: 'POST', headers });
}

describe('lib/http/errors, toResponse, assertSameOrigin, pgErrors', () => {
  it('FR-DEC-05 NFR-MNT-01: toResponse maps AppError to status, code and extra', async () => {
    const r = toResponse(new ConflictError('base_version_moved', { versionNumber: 2 }));
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: expect.any(String), code: 'base_version_moved', current: { versionNumber: 2 } });
    expect((await toResponse(new ValidationFailed([{ field: 'reason', message: 'Write a reason.' }])).json()).fields).toHaveLength(1);
    expect(toResponse(new NotImplementedError('DEC-a')).status).toBe(501);
    expect(toResponse(new AcceptancesRequiredError(['privacy'])).status).toBe(403);
  });

  it('NFR-MNT-01: every AppError subclass carries the status, code and extra the contract fixes', async () => {
    const cases: Array<[AppError, number, string, Record<string, unknown>]> = [
      [new ValidationFailed([{ field: 'a', message: 'b' }]), 422, 'validation', { fields: [{ field: 'a', message: 'b' }] }],
      [new ConflictError('project_archived'), 409, 'project_archived', {}],
      [new RateLimitedError(120), 429, 'rate_limited', { retryAfterSeconds: 120 }],
      [new RateLimitedError(30, 'export_busy'), 429, 'export_busy', { retryAfterSeconds: 30 }],
      [new ErasedError('2026-11-02'), 410, 'erased', { erasedOn: '2026-11-02' }],
      [new NotImplementedError('CNT'), 501, 'not_implemented', { unit: 'CNT' }],
      [new AcceptancesRequiredError(['terms', 'privacy']), 403, 'acceptances_required', { missing: ['terms', 'privacy'] }],
      [new AppError(500, 'unknown_content_version'), 500, 'unknown_content_version', {}],
    ];
    for (const [e, status, code, extra] of cases) {
      expect(e).toBeInstanceOf(AppError);
      expect(e).toBeInstanceOf(Error);
      const r = toResponse(e);
      expect({ code, status: r.status }).toEqual({ code, status });
      // An answer of 500 or more carries a support reference (NFR-OBS-05); the others carry none.
      expect(await r.json()).toEqual({ error: expect.any(String), code, ...extra, ...(status >= 500 ? { reference: expect.stringMatching(/^[0-9a-f]{8}$/) } : {}) });
    }
    // extra can never overwrite the two fixed keys
    const hostile = new AppError(409, 'real_code', 'real message', { error: 'x', code: 'x' } as never);
    expect(await toResponse(hostile).json()).toMatchObject({ error: 'real message', code: 'real_code' });
  });

  it('NFR-OBS-05 (types): a thrower cannot set the support reference through extra', () => {
    // `reference` is the support reference toResponse adds to a 500 or 503 body; a thrower's value must not type-check.
    // @ts-expect-error extra omits 'reference'
    const refused = new AppError(500, 'x', 'm', { reference: 'x' });
    expect(refused.status).toBe(500);
    expectTypeOf<NonNullable<AppError['extra']>>().not.toHaveProperty('reference');
    expectTypeOf<NonNullable<AppError['extra']>>().not.toHaveProperty('error');
    expectTypeOf<NonNullable<AppError['extra']>>().not.toHaveProperty('code');
    expectTypeOf<NonNullable<AppError['extra']>>().toHaveProperty('unit');
    expectTypeOf<NonNullable<AppError['extra']>>().toHaveProperty('retryAfterSeconds');
  });

  it('NFR-SEC-20 NFR-MNT-01: RateLimitedError refuses a retry time that is not positive and finite, and rounds a fraction up', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0, -0.5])
      expect(() => new RateLimitedError(bad), String(bad)).toThrow(RangeError);
    expect(() => new RateLimitedError(Number.NaN, 'export_busy')).toThrow(RangeError);
    // a fraction would put 1.2 in `retryAfterSeconds` and a Retry-After header that is not whole seconds
    expect(new RateLimitedError(1.2).extra).toEqual({ retryAfterSeconds: 2 });
    expect(new RateLimitedError(0.001).extra).toEqual({ retryAfterSeconds: 1 });
    expect(new RateLimitedError(30, 'export_busy').extra).toEqual({ retryAfterSeconds: 30 });
    expect(new RateLimitedError(120).extra).toEqual({ retryAfterSeconds: 120 });
    const r = toResponse(new RateLimitedError(1.2));
    expect([r.status, await r.json()]).toEqual([429, { error: HTTP_COPY.rateLimited(2), code: 'rate_limited', retryAfterSeconds: 2 }]);
  });

  it('E-API-9, E-API-11, E-API-13, E-API-14: the answers say what a person can do, and the wait and the date are the body\'s own', async () => {
    expect(new RateLimitedError(30).message).toBe('Too many attempts. Wait 1 minute, then try again.');
    expect(new RateLimitedError(60).message).toBe('Too many attempts. Wait 1 minute, then try again.');
    expect(new RateLimitedError(61).message).toBe('Too many attempts. Wait 2 minutes, then try again.');
    expect(new RateLimitedError(30, 'export_busy').message).toBe(HTTP_COPY.rateLimited(30));
    expect(new ErasedError('2026-11-02').message).toBe('This record was erased on 2 Nov 2026.');
    expect(new AcceptancesRequiredError(['terms']).message).toBe('Accept the updated terms before you continue.');
    const cross = toResponse(await Promise.resolve().then(() => { try { assertSameOrigin(req({ origin: 'https://evil.example', host: 'makrai.org' })); } catch (e) { return e; } }));
    expect(await cross.json()).toEqual({ error: HTTP_COPY.outOfDate, code: 'cross_origin' });
    expect(HTTP_COPY.outOfDate).toBe('This page is out of date. Reload it and try again.');
  });

  it('NFR-MNT-01: an AppError status outside 400 to 599 is refused where it is thrown, not when toResponse answers', () => {
    for (const status of [0, 200, 204, 302, 399, 600, 404.5, Number.NaN]) {
      expect(() => new AppError(status, 'x'), String(status)).toThrow(RangeError);
    }
    for (const status of [400, 404, 429, 500, 503, 599]) expect(new AppError(status, 'x').status).toBe(status);
  });

  it('NFR-MNT-01: toResponse keeps the existing four mappings and adds codes', async () => {
    expect(await toResponse(new NotFoundError()).json()).toEqual({ error: API_COPY.notFound, code: 'not_found' });
    expect(await toResponse(new UnauthenticatedError('x')).json()).toEqual({ error: API_COPY.unauthenticated, code: 'unauthenticated' });
    expect(await toResponse(new ForbiddenError('evidence:create', 'viewer')).json()).toEqual({ error: API_COPY.forbidden, code: 'forbidden' });
    const must = toResponse(new PasswordChangeRequiredError());
    expect([must.status, await must.json()]).toEqual([403, { error: API_COPY.mustChangePassword, code: 'must_change_password' }]);
    expect([toResponse(new NotFoundError()).status, toResponse(new UnauthenticatedError('x')).status,
      toResponse(new ForbiddenError('evidence:create', 'viewer')).status]).toEqual([404, 401, 403]);
  });

  it('NFR-AVL-04: an unreachable database answers 503 database_unavailable with no adapter text', async () => {
    // The message Prisma writes for a refused connection names the host and port (contract E-16), so the
    // check below fails if the body ever carries the error's own text.
    const message = "Can't reach database server at `127.0.0.1:1`";
    const e = ADAPTER({ kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 }, 'P1001', message);
    expect(e.message).toContain('127.0.0.1:1');
    const r = toResponse(e);
    expect(r.status).toBe(503);
    const body = JSON.stringify(await r.json());
    expect(JSON.parse(body)).toEqual({ error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(body).not.toMatch(/127\.0\.0\.1|port|reach/i);
  });

  it('NFR-AVL-04: every code and adapter kind of the contract reads as unavailable, a unique violation does not', () => {
    for (const code of ['P1001', 'P1002', 'P1008', 'P1017']) expect(isDatabaseUnavailable(ADAPTER({}, code)), code).toBe(true);
    for (const kind of ['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'])
      expect(isDatabaseUnavailable(ADAPTER({ kind })), kind).toBe(true);
    expect(isDatabaseUnavailable(ADAPTER({ kind: 'UniqueConstraintViolation', originalCode: '23505' }))).toBe(false);
    expect(isDatabaseUnavailable(ADAPTER({}, 'P2002'))).toBe(false);
    // only a PrismaClientKnownRequestError counts: a look-alike object does not
    expect(isDatabaseUnavailable({ code: 'P1001', meta: { driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } } } })).toBe(false);
    for (const v of [null, undefined, 'P1001', 42, new Error('boom')]) expect(isDatabaseUnavailable(v)).toBe(false);
  });

  /**
   * What CI printed for a refused connection (run 41117906312, `prisma.user.findUnique()` in lib/auth/identity): a
   * PrismaClientKnownRequestError whose own `code` is the Node socket code, `meta` holds only the model name, and there
   * is no `meta.driverAdapterError`, so neither a P-code nor an adapter kind matched and the route answered 500.
   */
  const refusedKnownRequest = (code = 'ECONNREFUSED') => new Prisma.PrismaClientKnownRequestError(
    '\nInvalid `prisma.user.findUnique()` invocation:\n\n\n', { code, clientVersion: '7.10.1', meta: { modelName: 'User' } });

  it('NFR-AVL-04: a PrismaClientKnownRequestError whose own code is a network code, as CI printed it, reads as unavailable and answers 503', async () => {
    const shape = refusedKnownRequest();
    expect([shape.code, shape.meta, 'driverAdapterError' in (shape.meta ?? {})]).toEqual(['ECONNREFUSED', { modelName: 'User' }, false]);
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      const e = refusedKnownRequest(code);
      expect(isDatabaseUnavailable(e), code).toBe(true);
      const r = toResponse(e);
      const body = JSON.stringify(await r.json());
      expect([r.status, JSON.parse(body)], code).toEqual([503, { error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
      expect(body, code).not.toMatch(/User|findUnique|invocation/);
    }
  });

  it('NFR-AVL-04: a PrismaClientKnownRequestError with any other code is still not an outage', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const code of ['P2002', 'P2025', 'P2010', 'P2028', 'EACCES', 'ENOENT', 'ECONNREFUSED ', 'econnrefused']) {
        const e = refusedKnownRequest(code);
        expect(isDatabaseUnavailable(e), code).toBe(false);
        const r = toResponse(e);
        expect([r.status, (await r.json()).code], code).toEqual([500, 'internal_error']);
      }
    } finally {
      quiet.mockRestore();
    }
  });

  /**
   * What Node builds when a connection to a host that resolves to two addresses is refused: a raw
   * AggregateError named AggregateError with an own `code`, an empty message and no syscall or errno,
   * whose `errors` hold one ECONNREFUSED error per address (probed with net.connect and a two-address
   * `lookup` on Node 22.22.3).
   */
  const nodeError = (code: string, address: string) => Object.assign(
    new Error(`connect ${code} ${address}:1`), { code, errno: -111, syscall: 'connect', address, port: 1 });
  const refusedAggregate = (code = 'ECONNREFUSED') => Object.assign(
    new AggregateError([nodeError(code, '127.0.0.1'), nodeError(code, '::1')], ''), { code });

  it('NFR-AVL-04: a DriverAdapterError of each unreachable kind answers 503 database_unavailable with no adapter text', async () => {
    for (const kind of ['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'] as const) {
      const e = new DriverAdapterError({ kind, host: '127.0.0.1', port: 1 });
      expect(isDatabaseUnavailable(e), kind).toBe(true);
      const r = toResponse(e);
      expect([r.status, await r.json()], kind).toEqual([503, { error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    }
    // another kind of DriverAdapterError is not an outage
    expect(isDatabaseUnavailable(new DriverAdapterError({ kind: 'UniqueConstraintViolation', constraint: { index: 'x' } }))).toBe(false);
    expect(isDatabaseUnavailable(new DriverAdapterError({ kind: 'AuthenticationFailed' }))).toBe(false);
  });

  it('NFR-AVL-04: a raw AggregateError as Node builds it for a refused connection answers 503 database_unavailable', async () => {
    const e = refusedAggregate();
    expect([e.name, e.code, e.message, 'syscall' in e, 'errno' in e]).toEqual(['AggregateError', 'ECONNREFUSED', '', false, false]);
    const r = toResponse(e);
    const body = JSON.stringify(await r.json());
    expect([r.status, JSON.parse(body)]).toEqual([503, { error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    expect(body).not.toMatch(/127\.0\.0\.1|::1|connect/);
  });

  it('NFR-AVL-04: any error whose own code, or whose errors[] codes all, are network codes reads as unavailable', async () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code })), `own ${code}`).toBe(true);
      expect(isDatabaseUnavailable(refusedAggregate(code)), `aggregate ${code}`).toBe(true);
      // no own code on the aggregate: the codes of errors[] decide
      expect(isDatabaseUnavailable(new AggregateError([nodeError(code, 'a'), nodeError('ETIMEDOUT', 'b')], '')), `errors[] ${code}`).toBe(true);
      const r = toResponse(Object.assign(new Error('x'), { code }));
      expect([r.status, await r.json()], code).toEqual([503, { error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    }
  });

  it('NFR-AVL-04: a mixed, empty or other-coded error is not an outage, and a look-alike object is not an error', async () => {
    // one error of errors[] is not a network code: not "all among"
    expect(isDatabaseUnavailable(new AggregateError([nodeError('ECONNREFUSED', 'a'), nodeError('EACCES', 'b')], ''))).toBe(false);
    // an empty errors[] must not pass as "all of nothing"
    expect(isDatabaseUnavailable(new AggregateError([], ''))).toBe(false);
    for (const code of ['EACCES', 'ENOENT', 'EPIPE', 'P2002', 'ECONNREFUSED ']) expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code })), code).toBe(false);
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: 111 }))).toBe(false);
    expect(isDatabaseUnavailable({ code: 'ECONNREFUSED' })).toBe(false);
    expect(isDatabaseUnavailable({ errors: [{ code: 'ECONNREFUSED' }], code: 'ECONNREFUSED' })).toBe(false);
    expect(isDatabaseUnavailable(new AggregateError([{ code: 'ECONNREFUSED' }, 'ECONNREFUSED'], ''))).toBe(false);
    // It is not mapped, so it is a bug: a 500 with a reference, not a rethrow (C4 round 1 item 14).
    const mixed = toResponse(new AggregateError([nodeError('ECONNREFUSED', 'a'), nodeError('EACCES', 'b')], ''));
    expect([mixed.status, (await mixed.json()).code]).toEqual([500, 'internal_error']);
  });

  it('NFR-MNT-01: toResponse answers 500 internal_error for anything else, with a reference, instead of rethrowing', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = toResponse(new Error('boom'));
      expect(r.status).toBe(500);
      expect(await r.json()).toMatchObject({ code: 'internal_error', reference: expect.stringMatching(/^[0-9a-f]{8}$/) });
    } finally {
      quiet.mockRestore();
    }
  });

  it('NFR-MNT-01: toResponse answers 500 internal_error for a Prisma error that is neither unavailable nor mapped', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = toResponse(ADAPTER({ kind: 'UniqueConstraintViolation', originalCode: '23505' }));
      expect([r.status, (await r.json()).code]).toEqual([500, 'internal_error']);
    } finally {
      quiet.mockRestore();
    }
  });

  it('NFR-SEC-08: assertSameOrigin refuses another site, null and garbage, and allows the same host or no Origin', () => {
    for (const origin of ['https://evil.example', 'null', 'not a url'])
      expect(() => assertSameOrigin(req({ origin, host: 'makrai.org' }))).toThrow(expect.objectContaining({ status: 403, code: 'cross_origin' }));
    expect(() => assertSameOrigin(req({ origin: 'https://makrai.org', host: 'makrai.org' }))).not.toThrow();
    expect(() => assertSameOrigin(req({ host: 'makrai.org' }))).not.toThrow();
  });

  it('NFR-SEC-08: assertSameOrigin throws the AppError that toResponse turns into a 403 cross_origin body', async () => {
    let caught: unknown;
    try { assertSameOrigin(req({ origin: 'null', host: 'makrai.org' })); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AppError);
    const r = toResponse(caught);
    expect([r.status, await r.json()]).toEqual([403, { error: HTTP_COPY.outOfDate, code: 'cross_origin' }]);
  });

  it('NFR-SEC-08: assertSameOrigin compares host and port, and refuses an Origin when the request has no Host', () => {
    expect(() => assertSameOrigin(req({ origin: 'https://makrai.org:8443', host: 'makrai.org' }))).toThrow(expect.objectContaining({ code: 'cross_origin' }));
    expect(() => assertSameOrigin(req({ origin: 'http://localhost:3101', host: 'localhost:3101' }))).not.toThrow();
    expect(() => assertSameOrigin(req({ origin: 'https://makrai.org' }))).toThrow(expect.objectContaining({ code: 'cross_origin' }));
    expect(() => assertSameOrigin(req({ origin: '', host: 'makrai.org' }))).toThrow(expect.objectContaining({ code: 'cross_origin' }));
  });

  it('NFR-INT-02 (5.3 item 4): isUniqueViolation reads the adapter cause, not meta.target', () => {
    expect(isUniqueViolation(ADAPTER({ originalCode: '23505', constraint: { index: 'x_key' } }))).toBe(true);
    expect(uniqueViolationIndex(ADAPTER({ originalCode: '23505', constraint: { index: 'x_key' } }, 'P2002'))).toBe('x_key');
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['x'] } })).toBe(false);
  });

  it('NFR-INT-02 (5.3 item 4): another SQLSTATE or a missing cause is not a unique violation and has no index', () => {
    const fk = ADAPTER({ originalCode: '23503', constraint: { index: 'fk_idx' } });
    expect([isUniqueViolation(fk), uniqueViolationIndex(fk)]).toEqual([false, null]);
    const noIndex = ADAPTER({ originalCode: '23505' });
    expect([isUniqueViolation(noIndex), uniqueViolationIndex(noIndex)]).toEqual([true, null]);
    for (const v of [null, undefined, 'x', 7, {}, { meta: null }, { meta: { driverAdapterError: null } }, new Error('x')]) {
      expect([isUniqueViolation(v), uniqueViolationIndex(v)]).toEqual([false, null]);
    }
  });
});
