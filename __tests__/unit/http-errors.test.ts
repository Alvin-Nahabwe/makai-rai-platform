import { describe, it, expect } from 'vitest';
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

const ADAPTER = (cause: object, code = 'P2010') => Object.assign(
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '7.10.1', meta: { driverAdapterError: { cause } } }), {});

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
      expect(await r.json()).toEqual({ error: expect.any(String), code, ...extra });
    }
    // extra can never overwrite the two fixed keys
    const hostile = new AppError(409, 'real_code', 'real message', { error: 'x', code: 'x' } as never);
    expect(await toResponse(hostile).json()).toMatchObject({ error: 'real message', code: 'real_code' });
  });

  it('NFR-MNT-01: an AppError status outside 400 to 599 is refused where it is thrown, not when toResponse answers', () => {
    for (const status of [0, 200, 204, 302, 399, 600, 404.5, Number.NaN]) {
      expect(() => new AppError(status, 'x'), String(status)).toThrow(RangeError);
    }
    for (const status of [400, 404, 429, 500, 503, 599]) expect(new AppError(status, 'x').status).toBe(status);
  });

  it('NFR-MNT-01: toResponse keeps the existing four mappings and adds codes', async () => {
    expect(await toResponse(new NotFoundError()).json()).toEqual({ error: 'Not found', code: 'not_found' });
    expect(await toResponse(new UnauthenticatedError('x')).json()).toEqual({ error: 'Unauthorized', code: 'unauthenticated' });
    expect(await toResponse(new ForbiddenError('evidence:create', 'viewer')).json()).toEqual({ error: 'Forbidden', code: 'forbidden' });
    const must = toResponse(new PasswordChangeRequiredError());
    expect([must.status, await must.json()]).toEqual([403, { error: 'Password change required', code: 'must_change_password' }]);
    expect([toResponse(new NotFoundError()).status, toResponse(new UnauthenticatedError('x')).status,
      toResponse(new ForbiddenError('evidence:create', 'viewer')).status]).toEqual([404, 401, 403]);
  });

  it('NFR-AVL-04: an unreachable database answers 503 database_unavailable with no adapter text', async () => {
    const e = ADAPTER({ kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 1 }, 'P1001');
    const r = toResponse(e);
    expect(r.status).toBe(503);
    const body = JSON.stringify(await r.json());
    expect(JSON.parse(body)).toEqual({ error: 'Service unavailable', code: 'database_unavailable' });
    expect(body).not.toMatch(/127\.0\.0\.1|port/);
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

  it('NFR-MNT-01: toResponse rethrows anything else', () => expect(() => toResponse(new Error('boom'))).toThrow('boom'));

  it('NFR-MNT-01: toResponse rethrows a Prisma error that is neither unavailable nor mapped', () => {
    const e = ADAPTER({ kind: 'UniqueConstraintViolation', originalCode: '23505' });
    expect(() => toResponse(e)).toThrow(e);
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
    expect([r.status, await r.json()]).toEqual([403, { error: 'Cross-origin request rejected', code: 'cross_origin' }]);
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
