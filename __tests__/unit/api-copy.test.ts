import { describe, expect, it } from 'vitest';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { AppError, ValidationFailed } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { API_COPY } from '@/lib/http/api/copy';
import { VALIDATION_COPY } from '@/lib/http/copy';

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
    const r = toResponse(new AppError(409, 'x', 'Conflict'));
    expect((await r.json()).error).toBe('Conflict');
  });
});
