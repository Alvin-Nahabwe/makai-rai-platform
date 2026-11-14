import { expect, it, vi } from 'vitest';
import { AppError } from '@/lib/http/errors';
import { toResponse } from '@/lib/http/toResponse';
import { API_COPY } from '@/lib/http/api/copy';
import type { ApiErrorBody } from '@/types/api';

/**
 * Contract round 19, R19-5: `ApiErrorBody` has an optional `message`, and the only body that sets it is the 500 that
 * `toResponse` gives an error nothing maps. A thrower cannot set it: `AppError`'s `extra` leaves `message` out, as it
 * leaves out `error`, `code` and `reference`. The type half of this file is checked by `npm run typecheck`
 * (an unused @ts-expect-error is an error there); the run half is below.
 */

it('NFR-MNT-01: the body of a 500 that nothing mapped is an ApiErrorBody with a message and a reference', async () => {
  const body: ApiErrorBody = { error: 'internal_error', code: 'internal_error', message: 'internal_error', reference: '0a8e18f2' };
  expect(body.message).toBe('internal_error');
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const res = toResponse(new Error('not mapped'));
    const answered = (await res.json()) as ApiErrorBody;
    expect(res.status).toBe(500);
    expect(answered.reference).toMatch(/^[0-9a-f]{8}$/);
    const text = API_COPY.internalError(answered.reference as string);
    expect(answered.error).toBe(text);
    expect(answered.message).toBe(text);
  } finally {
    spy.mockRestore();
  }
});

it('NFR-MNT-01: a thrower cannot set message through AppError\'s extra', () => {
  // @ts-expect-error `message` is not allowed in extra: only toResponse's 500 sets it
  const e = new AppError(400, 'bad_request', 'Bad request', { message: 'x' });
  expect(e.status).toBe(400);
  // The fields a thrower may still set.
  expect(new AppError(409, 'moved', 'Conflict', { current: 1, retryAfterSeconds: 3 }).extra).toEqual({ current: 1, retryAfterSeconds: 3 });
});
