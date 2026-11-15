import { isRequestId } from '@/lib/data/idempotency';
import { ValidationFailed } from '@/lib/http/errors';
import { HTTP_COPY } from '@/lib/http/copy';

/** The request id's refusal, worded as every route words it (422 on `requestId`). */
export const REQUEST_ID_FIELD_ERROR = { field: 'requestId', message: HTTP_COPY.outOfDate } as const;

/** A parsed JSON body that must be an object; anything else is 422 on `body`. */
export function asJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationFailed([{ field: 'body', message: HTTP_COPY.unreadable }]);
  }
  return raw as Record<string, unknown>;
}

/** Refuses a body whose `requestId` is not a UUID, before any digest is computed over the body (a number would throw in `requestDigest`). */
export function assertRequestId(o: Record<string, unknown>): string {
  if (!isRequestId(o.requestId)) throw new ValidationFailed([{ ...REQUEST_ID_FIELD_ERROR }]);
  return o.requestId;
}

/** The body of a route whose request is only `RequestIdBody`: `{ requestId }` and nothing else is read. */
export function parseRequestIdBody(raw: unknown): { requestId: string } {
  return { requestId: assertRequestId(asJsonObject(raw)) };
}
