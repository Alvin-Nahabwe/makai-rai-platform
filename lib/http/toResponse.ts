import { NextResponse } from 'next/server';
import { NotFoundError, ForbiddenError } from '@/lib/data/tenant';
import { UnauthenticatedError, PasswordChangeRequiredError } from '@/lib/auth/identity';
import { AppError } from '@/lib/http/errors';
import { API_COPY } from '@/lib/http/api/copy';
import type { ApiErrorBody } from '@/types/api';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';
import { redactEmails } from '@/lib/redact';
import {
  UNAVAILABLE_ADAPTER_KINDS, UNAVAILABLE_ERRNO_CODES, UNAVAILABLE_PRISMA_CODES, logRequestFailure, stampReference,
} from '@/lib/http/supportReference';

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ERROR_CODE = /^(P\d{4}|[A-Z][A-Z0-9_]{1,40})$/;
// A V8 stack frame: `at` and a location that ends in `:line:column`, either bare or in parentheses after a function
// name. A line of a message that merely starts with `at` does not end so, and is never taken as a frame.
const FRAME = /^\s+at (?:.+ \()?[^\s()]+:\d+:\d+\)?$/;

/** What the REQUEST_FAILED line of an unmapped 500 says about the error (lib/http/supportReference.ts). */
type UnmappedErrorInfo = { name: string; code?: string; frames: string[] };

/**
 * `name` is the constructor's name when it is a plain identifier, else `typeof e`; `code` only when it is a Prisma or
 * errno-shaped string; `frames` the first ten stack lines that start with `at`, read only from the part of the stack
 * after the message (a multi-line message can hold a line that starts with `at`), through `redactEmails`. Never the
 * message, `String(e)` or the stack's first line. A logger must not throw from inside the failure it reports (the
 * thrown value may be an object whose getters throw), so a failed read answers `{ name: typeof e, frames: [] }`.
 */
function describeUnmappedError(e: unknown): UnmappedErrorInfo {
  try {
    const ctorName = isObject(e) && typeof e.constructor?.name === 'string' ? e.constructor.name : '';
    const info: UnmappedErrorInfo = { name: CLASS_NAME.test(ctorName) ? ctorName : typeof e, frames: [] };
    if (isObject(e) && typeof e.code === 'string' && ERROR_CODE.test(e.code)) info.code = e.code;
    const stack = isObject(e) && typeof e.stack === 'string' ? e.stack : '';
    const message = isObject(e) ? String(e.message ?? '') : '';
    const head = `${isObject(e) ? String(e.name) : ''}: ${message}`;
    const afterMessage = stack.startsWith(head) ? stack.slice(head.length).split('\n') : stack.split('\n').slice(message.split('\n').length);
    info.frames = afterMessage.filter((l) => FRAME.test(l)).slice(0, 10).map((l) => String(redactEmails(l.trim())));
    return info;
  } catch {
    // The values read here are the thrown object's own; one that throws on read still gets its answer and its line.
    return { name: typeof e, frames: [] };
  }
}

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
 * of these is NOT this function's to interpret, so it is never laundered into
 * a 4xx (AGENTS.md §2: investigate a failure, don't paper over it with a broad
 * catch). It is a bug, and it answers 500 `internal_error` with a support
 * reference. The bug stays visible in the same single REQUEST_FAILED line,
 * which carries the error's class name, code and code locations, never its
 * message (a Prisma message can carry argument values; NFR-PRIV-03), so the
 * reference is in exactly one log line (NFR-OBS-05).
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
      const reference = stampReference(e);
      logRequestFailure({ reference, status: e.status, code: e.code });
      return NextResponse.json({ ...e.extra, error: e.message, code: e.code, reference }, { status: e.status });
    }
    return NextResponse.json({ ...e.extra, error: e.message, code: e.code }, { status: e.status });
  }
  if (e instanceof UnauthenticatedError) {
    return NextResponse.json({ error: API_COPY.unauthenticated, code: 'unauthenticated' }, { status: 401 });
  }
  if (e instanceof PasswordChangeRequiredError) {
    return NextResponse.json(
      { error: API_COPY.mustChangePassword, code: 'must_change_password' },
      { status: 403 },
    );
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: API_COPY.notFound, code: 'not_found' }, { status: 404 });
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: API_COPY.forbidden, code: 'forbidden' }, { status: 403 });
  }
  if (isDatabaseUnavailable(e)) {
    // A fixed body: the adapter's own message names the database host and port. The log line names which kind of
    // outage it was (one of thirteen fixed names), so a pool exhaustion can be told from a refused connection.
    const reference = stampReference(e);
    logRequestFailure({ reference, status: 503, code: 'database_unavailable', cause: unavailableCause(e) });
    return NextResponse.json(
      { error: API_COPY.databaseUnavailable, code: 'database_unavailable', reference },
      { status: 503 },
    );
  }
  // Neither mapped nor an outage: a bug. Its class, code and code locations go into the one log line under the
  // reference, never its message (a Prisma message can carry argument values), then the answer carries the reference.
  const reference = stampReference(e);
  logRequestFailure({ reference, status: 500, code: 'internal_error', error: describeUnmappedError(e) });
  const text = API_COPY.internalError(reference);
  const body: ApiErrorBody = { error: text, code: 'internal_error', message: text, reference };
  return NextResponse.json(body, { status: 500 });
}
