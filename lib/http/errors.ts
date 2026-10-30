import type { ApiErrorBody } from '@/types/api';
import type { FieldError, CalendarDate } from '@/types/record';
import type { LegalTextKind } from '@/types/legal';

/**
 * An error a route answers with a known status and code. `toResponse`
 * (lib/http/toResponse.ts) turns it into `{ error, code, ...extra }`, so the
 * client reads `code` and never the message text.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    // `reference` is the support reference toResponse adds to a 500 or more; a thrower cannot set it.
    readonly extra?: Omit<ApiErrorBody, 'error' | 'code' | 'reference'>,
  ) {
    // A status outside 400 to 599 would make `toResponse` throw (Response rejects it) or answer
    // a failure with a success status; refuse it here, at the throw site that is wrong.
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      throw new RangeError(`AppError '${code}' needs an HTTP error status from 400 to 599, got ${status}`);
    }
    super(message ?? code);
    this.name = new.target.name;
  }
}

export class ValidationFailed extends AppError {
  constructor(fields: FieldError[]) {
    super(422, 'validation', 'Validation failed', { fields });
  }
}

export class ConflictError extends AppError {
  constructor(code: string, current?: unknown) {
    super(409, code, 'Conflict', current === undefined ? undefined : { current });
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number, code: 'rate_limited' | 'export_busy' = 'rate_limited') {
    // The body's `retryAfterSeconds` and the Retry-After header are whole seconds of a wait that
    // exists: NaN, a negative, zero or an infinite value is a caller bug, refused where it is made.
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
      throw new RangeError(`RateLimitedError needs a positive, finite retryAfterSeconds, got ${retryAfterSeconds}`);
    }
    super(429, code, 'Too many requests. Please try again later.', { retryAfterSeconds: Math.ceil(retryAfterSeconds) });
  }
}

export class ErasedError extends AppError {
  constructor(erasedOn: CalendarDate) {
    super(410, 'erased', 'Erased', { erasedOn });
  }
}

export class NotImplementedError extends AppError {
  constructor(unit: string) {
    super(501, 'not_implemented', 'Not implemented', { unit });
  }
}

export class AcceptancesRequiredError extends AppError {
  constructor(missing: LegalTextKind[]) {
    super(403, 'acceptances_required', 'Acceptances required', { missing });
  }
}
