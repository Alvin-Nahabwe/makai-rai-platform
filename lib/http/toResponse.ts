import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';
import {
  UNAVAILABLE_ADAPTER_KINDS, UNAVAILABLE_ERRNO_CODES, UNAVAILABLE_PRISMA_CODES, logRequestFailure, newSupportReference,
} from '@/lib/http/supportReference';

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

const isOneOf = (list: readonly string[], v: unknown): v is string => typeof v === 'string' && list.includes(v);

/**
 * Which of the thirteen fixed names `isDatabaseUnavailable` matched, for the log line of a 503: the Prisma
 * code, else the adapter's kind, else, for a raw Node socket error, the errno code. Never the error's message,
 * which names the database host and port. Called only for an error that function has accepted.
 *
 * The errno code is the error's own `code`; a refused connection to a host with two addresses is an
 * `AggregateError` that may carry no code of its own, and then the code of its first `errors[]` entry decides.
 * `undefined` when none of the thirteen is found, and the line then has no cause.
 */
function unavailableCause(e: unknown): string | undefined {
  if (!isObject(e)) return undefined;
  if (isOneOf(UNAVAILABLE_PRISMA_CODES, e.code)) return e.code;
  const adapter = isObject(e.meta) && isObject(e.meta.driverAdapterError) ? e.meta.driverAdapterError.cause : undefined;
  if (isObject(adapter) && isOneOf(UNAVAILABLE_ADAPTER_KINDS, adapter.kind)) return adapter.kind;
  // A DriverAdapterError itself carries its kind at `cause.kind`.
  if (e.name === 'DriverAdapterError' && isObject(e.cause) && isOneOf(UNAVAILABLE_ADAPTER_KINDS, e.cause.kind)) return e.cause.kind;
  if (isOneOf(UNAVAILABLE_ERRNO_CODES, e.code)) return e.code;
  const first = Array.isArray(e.errors) ? e.errors[0] : undefined;
  if (isObject(first) && isOneOf(UNAVAILABLE_ERRNO_CODES, first.code)) return first.code;
  return undefined;
}

/**
 * The one place every org-scoped route handler's catch block delegates to.
 * Maps the error types `requireOrgContext`/`requireIdentityForApi` can
 * throw, every `AppError` (lib/http/errors.ts) and an unreachable database
 * to their HTTP status and `code` — and nothing else: an error that is none
 * of these is NOT this function's to interpret. Rethrowing lets it surface as
 * a loud 500 (Next.js's own unhandled-error path) instead of being
 * laundered into a misleading 4xx (AGENTS.md §2: investigate a failure,
 * don't paper over it with a broad catch).
 *
 * `NotFoundError` carries no detail by construction (lib/data/tenant.ts) —
 * "unknown slug" and "not a member" are indistinguishable here on purpose
 * (ADR-0001: never leak org existence to a non-member).
 *
 * Every answer with status 500 or more carries a support reference in its body and writes one log line with the
 * same reference (lib/http/supportReference.ts, NFR-OBS-05); the answers below 500 carry none and log nothing.
 *
 * `PasswordChangeRequiredError` is the single mapping every caller of
 * `requireIdentityForApi()` shares for the must-change-password gate (see
 * that function's comment in lib/auth/identity.ts) — centralised here so
 * every route that reaches it (directly, or transitively through
 * `requireOrgContext`) reports the SAME 403 shape, `code` included, rather
 * than each route re-deciding its own wording.
 */
export function toResponse(e: unknown): NextResponse {
  if (e instanceof AppError) {
    // `error` and `code` come after `extra` so a caller's `extra` can never replace them. `reference` comes last for
    // the same reason (round 9c): the value in the body is the one in the log line, whatever a caller passed.
    if (e.status >= 500) {
      const reference = newSupportReference();
      logRequestFailure({ reference, status: e.status, code: e.code });
      return NextResponse.json({ ...e.extra, error: e.message, code: e.code, reference }, { status: e.status });
    }
    return NextResponse.json({ ...e.extra, error: e.message, code: e.code }, { status: e.status });
  }
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: 'Unauthorized', code: 'unauthenticated' }, { status: 401 });
  }
  if (e instanceof PasswordChangeRequiredError) {
    return NextResponse.json(
      { error: 'Password change required', code: 'must_change_password' },
      { status: 403 },
    );
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: 'Not found', code: 'not_found' }, { status: 404 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: 'Forbidden', code: 'forbidden' }, { status: 403 });
  }
  if (isDatabaseUnavailable(e)) {
    // A fixed body: the adapter's own message names the database host and port. The log line names which kind of
    // outage it was (one of thirteen fixed names), so a pool exhaustion can be told from a refused connection.
    const reference = newSupportReference();
    logRequestFailure({ reference, status: 503, code: 'database_unavailable', cause: unavailableCause(e) });
    return NextResponse.json(
      { error: 'Service unavailable', code: 'database_unavailable', reference },
      { status: 503 },
    );
  }
  throw e;
}
