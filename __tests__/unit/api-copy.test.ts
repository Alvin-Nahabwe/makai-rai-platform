import { describe, expect, it, vi } from 'vitest';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import {
  AcceptancesRequiredError, ConflictError, ErasedError, NotImplementedError, RateLimitedError, ValidationFailed,
} from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { ADMIN_ROUTE_COPY, API_COPY } from '@/lib/http/api/copy';
import { idempotentWrite } from '@/lib/data/idempotency';
import { adminCreateOrganisation } from '@/lib/data/definer';

/** The identity lane's client, faked: a definer function refuses as Postgres does, with SQLSTATE P0001 and `makrai:<code>`. */
const definerRefusal = vi.hoisted(() => ({ code: 'not_platform_admin' }));
vi.mock('@/lib/data/identityClient', () => ({
  identityLaneClient: {
    $queryRaw: () => Promise.reject(Object.assign(new Error('definer refused'), {
      meta: { driverAdapterError: { cause: { originalCode: 'P0001', originalMessage: `makrai:${definerRefusal.code}` } } },
    })),
  },
}));
import { HTTP_COPY, VALIDATION_COPY } from '@/lib/http/copy';
import { DELETED_USER_NAME } from '@/lib/data/identity';
import { EXPORT_COPY } from '@/lib/export/copy';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Plan 1A Task 16c (audit E-API-1 to E-API-7): the fixed texts of the API's answers, word for word, and the answers that carry
 * them with every other key as it was. Only the `error` text (and `message` on the 500) changed; `code`, status and `reference`
 * are what they were.
 */
describe('the fixed texts of API answers (E-API-1 to E-API-7)', () => {
  it('each text is the audit row, word for word', () => {
    expect(API_COPY.unauthenticated).toBe('You have been signed out. Sign in again.');
    expect(API_COPY.mustChangePassword).toBe('Change your password before you continue.');
    expect(API_COPY.notFound).toBe('This page or file is not available. It may have been removed, or you may not have access.');
    expect(API_COPY.forbidden).toBe('Your role does not allow this. Ask an Owner or Admin.');
    expect(API_COPY.databaseUnavailable).toBe('The platform is not answering. Try again in a few minutes.');
    expect(API_COPY.internalError('0a1b2c3d')).toBe('Something went wrong on our side. Try again. If it happens again, give us this reference: 0a1b2c3d');
    expect(VALIDATION_COPY.failed).toBe('Some answers need fixing.');
  });

  it('the answers carry the texts under the same code and status as before', async () => {
    expect(await toResponse(new UnauthenticatedError('x')).json()).toEqual({ error: API_COPY.unauthenticated, code: 'unauthenticated' });
    expect(await toResponse(new NotFoundError()).json()).toEqual({ error: API_COPY.notFound, code: 'not_found' });
    expect(await toResponse(new ForbiddenError('evidence:create', 'viewer')).json()).toEqual({ error: API_COPY.forbidden, code: 'forbidden' });
    const must = toResponse(new PasswordChangeRequiredError());
    expect([must.status, await must.json()]).toEqual([403, { error: API_COPY.mustChangePassword, code: 'must_change_password' }]);
  });

  it('a 500 for an unmapped error carries the reference in its text and in its own key, and error equals message', async () => {
    const r = toResponse(new Error('boom'));
    const body = (await r.json()) as { error: string; message: string; code: string; reference: string };
    expect(r.status).toBe(500);
    expect(body.code).toBe('internal_error');
    expect(body.reference).toMatch(/^[0-9a-f]{8}$/);
    expect(body.error).toBe(API_COPY.internalError(body.reference));
    expect(body.message).toBe(body.error);
    expect(Object.keys(body).sort()).toEqual(['code', 'error', 'message', 'reference']);
  });

  it('the validation answer says the new text, with its 422, its code and its fields', async () => {
    const e = new ValidationFailed([{ field: 'name', message: 'Enter the name.' }]);
    expect(e.message).toBe(VALIDATION_COPY.failed);
    const r = toResponse(e);
    expect([r.status, await r.json()]).toEqual([422, { fields: [{ field: 'name', message: 'Enter the name.' }], error: VALIDATION_COPY.failed, code: 'validation' }]);
  });

  it('the texts nobody reworded are as they were (no audit row or a KEEP row)', async () => {
    // Each class's text before Task 16 (git show ba32b84d:lib/http/errors.ts), written out.
    expect(new ConflictError('moved').message).toBe('Conflict');
    expect(new NotImplementedError('x').message).toBe('Not implemented');
    expect((await toResponse(new ConflictError('moved')).json()).error).toBe('Conflict');
  });

  it('the texts Task 20 reworded (E-API-9 to E-API-13) are the copy module\'s', () => {
    expect(new ErasedError('2026-11-02').message).toBe(HTTP_COPY.erased('2026-11-02'));
    expect(new AcceptancesRequiredError(['terms']).message).toBe(HTTP_COPY.acceptancesRequired);
    expect(new RateLimitedError(30).message).toBe(HTTP_COPY.rateLimited(30));
  });

  it('a 429 says why by its code: too many attempts for rate_limited, two exports in progress for export_busy (review B2 I1)', async () => {
    expect(new RateLimitedError(30, 'rate_limited').message).toBe(HTTP_COPY.rateLimited(30));
    const busy = new RateLimitedError(60, 'export_busy');
    expect(busy.message).toBe(HTTP_COPY.exportBusy);
    expect(busy.message).not.toBe(HTTP_COPY.rateLimited(60));
    // S-20's ruled sentence for the same refusal (lib/export/copy.ts), so the API and the page say one thing.
    expect(HTTP_COPY.exportBusy).toBe(EXPORT_COPY.panel.refused.export_busy);
    const r = toResponse(busy);
    expect([r.status, await r.json()]).toEqual([429, { error: HTTP_COPY.exportBusy, code: 'export_busy', retryAfterSeconds: 60 }]);
  });
});

describe('the name written to a deleted account (review B2 I2: F8 held)', () => {
  it('is the name the newest privacy notice and terms in data/legal promise, so a person who accepted them is shown as told', () => {
    // scrubUserOnDeactivation writes it. The files are read directly: unit runs serve stub legal texts.
    expect(DELETED_USER_NAME).toBe('Deleted user');
    for (const kind of ['privacy', 'terms']) {
      const dir = join(process.cwd(), 'data', 'legal', kind);
      const newest = Math.max(...readdirSync(dir).filter((f) => /^\d+\.md$/.test(f)).map((f) => Number.parseInt(f, 10)));
      expect(readFileSync(join(dir, `${newest}.md`), 'utf8'), `${kind}/${newest}.md`).toContain(`"${DELETED_USER_NAME}"`);
    }
  });
});

describe('the data layer\'s own refusals use the routes\' words (review B2, leftovers)', () => {
  it('a requestId that is not a UUID is refused on its field with E-API-19\'s text, as lib/http/requestIdBody.ts words it', async () => {
    const write = idempotentWrite({ orgId: '00000000-0000-4000-8000-000000000001' } as never, { requestId: 'not-a-uuid' } as never);
    await expect(write).rejects.toBeInstanceOf(ValidationFailed);
    await expect(write).rejects.toMatchObject({ extra: { fields: [{ field: 'requestId', message: HTTP_COPY.outOfDate }] } });
  });

  it('a definer function\'s not_platform_admin answers 403 with E-API-40\'s text, as the administrator routes do', async () => {
    const args = {
      actorUserId: 'u', name: 'n', slug: 's', legalName: 'l', ownerEmail: 'o@example.org', tokenHash: 't', expiresAt: new Date(0),
      linkShown: false, requestId: '00000000-0000-4000-8000-000000000002', digest: 'd',
    };
    definerRefusal.code = 'not_platform_admin';
    await expect(adminCreateOrganisation(args)).rejects.toMatchObject({ status: 403, code: 'not_platform_admin', message: ADMIN_ROUTE_COPY.notPlatformAdmin });
    // Every other definer code keeps its code as its text, as before.
    definerRefusal.code = 'slug_taken';
    await expect(adminCreateOrganisation(args)).rejects.toMatchObject({ status: 409, code: 'slug_taken', message: 'slug_taken' });
  });
});
