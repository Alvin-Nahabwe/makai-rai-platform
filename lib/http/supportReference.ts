import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { isDatabaseUnavailable } from '@/lib/data/pgErrors';

/**
 * The support reference of a failed request (NFR-OBS-05, SRS line 3376). A person who sees "Support reference:
 * 3fa9c2d1" on a page or in an answer can read it out, and the line `REQUEST_FAILED` with the same reference is
 * the server's side of what happened. `toResponse` (lib/http/toResponse.ts) puts one in the body of every
 * answer with status 500 or more and writes one line for it.
 *
 * The line holds `event`, `reference`, `status`, `code` and `at`, and nothing else, except `cause` on a 503
 * `database_unavailable` (NFR-PRIV-03, H-S6). It never holds the error's message, which for a connection
 * problem names the database host and port, and never a record's text or an address.
 */

/** The Prisma codes `isDatabaseUnavailable` (lib/data/pgErrors.ts) reads as an outage. */
export const UNAVAILABLE_PRISMA_CODES = ['P1001', 'P1002', 'P1008', 'P1017'] as const;
/** The driver adapter's kinds of a connection that cannot be made or was lost. */
export const UNAVAILABLE_ADAPTER_KINDS = ['DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections'] as const;
/** The Node socket error codes of a connection that cannot be made or was lost. */
export const UNAVAILABLE_ERRNO_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'] as const;

/** The thirteen names a `cause` may take. Fixed words, so no host, port or message can reach the log through one. */
const CAUSES: ReadonlySet<string> = new Set([...UNAVAILABLE_PRISMA_CODES, ...UNAVAILABLE_ADAPTER_KINDS, ...UNAVAILABLE_ERRNO_CODES]);

/** Eight lowercase hexadecimal characters from `crypto.randomBytes(4)`. */
export function newSupportReference(): string {
  return randomBytes(4).toString('hex');
}

/**
 * The support reference of one failure, carried by the error itself as its `digest`. Next shows a person the `digest`
 * of the error that failed a page, and prints it once in the server's own output; when an error has no digest Next makes
 * one from a hash of its message and stack, which is the same for every request that fails the same way, so two people
 * would be told the same reference for two failures (NFR-OBS-05: the same reference is in exactly one log line). Next
 * keeps a digest the error already carries (node_modules/next/dist/server/app-render/create-error-handler.js:79-81),
 * so this puts a fresh reference there first.
 *
 * For a non-null object whose `digest` is not already a string, it sets `digest` to a new reference. It returns the
 * error's digest, so the same error always has one reference; for anything that cannot carry one (not an object,
 * frozen) it returns a new reference that nothing else holds.
 */
export function stampReference(err: unknown): string {
  if (typeof err !== 'object' || err === null) return newSupportReference();
  const existing = (err as { digest?: unknown }).digest;
  if (typeof existing === 'string') return existing;
  const reference = newSupportReference();
  Reflect.set(err, 'digest', reference); // false, not an exception, for a frozen object
  return reference;
}

/**
 * The `$allOperations` hook of every database lane's client: when an operation fails because the database cannot be
 * reached, it stamps that error with a reference (`stampReference`) and rethrows the same error, so whatever catches it
 * further up (a route's `toResponse`, or Next rendering the page) finds a reference of this failure on it. Only an
 * unavailable error is stamped; every other error passes untouched.
 */
export async function stampUnavailableOperation({ args, query }: { args: unknown; query: (args: unknown) => Promise<unknown> }): Promise<unknown> {
  try {
    return await query(args);
  } catch (e) {
    if (isDatabaseUnavailable(e)) stampReference(e);
    throw e;
  }
}

/**
 * Makes a lane's client stamp its database-unavailable errors, in the two places they leave it. A query that fails goes
 * through the extension's `$allOperations` hook (`stampUnavailableOperation`). A failure to connect from an interactive
 * or batch `$transaction` is thrown by `$transaction` itself, before any operation runs, so the hook never sees it;
 * the wrapper below stamps it there, once for every lane and every caller (`withOrg`, the reminder lane, the pre-auth
 * writes). Every other member of the client is the extended client's own, bound to it.
 *
 * The extension adds no model or method, so the wrapped client behaves as a PrismaClient at runtime; the one cast
 * drops only type detail that the callers' PrismaClient and Prisma.TransactionClient parameters cannot take. Every
 * lane client is made through this function, so no caller casts on its own.
 */
export function withUnavailableStamp(client: PrismaClient): PrismaClient {
  const extended = client.$extends({ query: { $allOperations: stampUnavailableOperation } });
  const transaction = (...args: unknown[]): Promise<unknown> =>
    (extended.$transaction as unknown as (...a: unknown[]) => Promise<unknown>)(...args).catch((e: unknown) => {
      if (isDatabaseUnavailable(e)) stampReference(e);
      throw e;
    });
  return new Proxy(extended, {
    get(target, prop) {
      if (prop === '$transaction') return transaction;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PrismaClient;
}

/**
 * One `console.error` of `{ event: 'REQUEST_FAILED', reference, status, code, cause, at }`.
 *
 * `cause` is written only when `status` is 503 and `code` is `database_unavailable`, so a pool exhaustion
 * (`TooManyConnections`) can be told from an outage (`ECONNREFUSED`), and only when it is one of the thirteen
 * names above; any other value is left out of the line rather than written. For any other status or code the
 * key is absent even when a caller passes one.
 */
export function logRequestFailure(a: { reference: string; status: number; code: string; cause?: string }): void {
  const line: Record<string, string | number> = { event: 'REQUEST_FAILED', reference: a.reference, status: a.status, code: a.code };
  if (a.status === 503 && a.code === 'database_unavailable' && a.cause !== undefined && CAUSES.has(a.cause)) {
    line.cause = a.cause;
  }
  line.at = new Date().toISOString();
  console.error(JSON.stringify(line));
}
