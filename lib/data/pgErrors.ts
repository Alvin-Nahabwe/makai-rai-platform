import { Prisma } from '@prisma/client';

/**
 * Through @prisma/adapter-pg a database error carries the driver's own
 * description at `meta.driverAdapterError.cause`: the SQLSTATE in
 * `originalCode`, a violated unique index in `constraint.index`, and, for a
 * connection problem, a `kind`. A unique violation is `P2002` from the model
 * API and `P2010` from a raw query, and `meta.target` is absent in both, so
 * these functions read the cause and never `code` or `meta.target`.
 */
type AdapterCause = { originalCode?: unknown; constraint?: unknown; kind?: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function adapterCause(e: unknown): AdapterCause | null {
  if (!isObject(e) || !isObject(e.meta)) return null;
  const adapterError = e.meta.driverAdapterError;
  if (!isObject(adapterError) || !isObject(adapterError.cause)) return null;
  return adapterError.cause;
}

/** SQLSTATE 23505, unique_violation. */
export function isUniqueViolation(e: unknown): boolean {
  return adapterCause(e)?.originalCode === '23505';
}

/**
 * SQLSTATE 40001, serialization_failure: at REPEATABLE READ, a row this transaction locks or updates was changed by a
 * transaction that committed after its snapshot. The work may be retried in a new transaction (a new snapshot).
 */
export function isSerializationFailure(e: unknown): boolean {
  return adapterCause(e)?.originalCode === '40001';
}

/** The name of the unique index a violation names, or null. */
export function uniqueViolationIndex(e: unknown): string | null {
  const cause = adapterCause(e);
  if (cause?.originalCode !== '23505' || !isObject(cause.constraint)) return null;
  const index = cause.constraint.index;
  return typeof index === 'string' ? index : null;
}

const UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['P1001', 'P1002', 'P1008', 'P1017']);
const UNAVAILABLE_KINDS: ReadonlySet<string> = new Set([
  'DatabaseNotReachable', 'ConnectionClosed', 'SocketTimeout', 'TooManyConnections',
]);
/** The Node socket error codes of a connection that cannot be made or was lost. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
]);

function isUnavailableKind(kind: unknown): boolean {
  return typeof kind === 'string' && UNAVAILABLE_KINDS.has(kind);
}

function hasNetworkCode(v: unknown): boolean {
  return isObject(v) && typeof v.code === 'string' && NETWORK_CODES.has(v.code);
}

/**
 * The database cannot be reached, or dropped the connection: the caller answers 503.
 *
 * Three shapes reach a caller, and each is read here:
 *  - a `PrismaClientKnownRequestError` with a connection code (P1001, P1002, P1008, P1017), or an
 *    adapter cause of an unreachable kind (the model API and raw queries), or the Node socket code
 *    itself as its own `code` with no adapter cause (CI run 41117906312: `prisma.user.findUnique()`
 *    on a refused connection threw `code: 'ECONNREFUSED'`, `meta: { modelName: 'User' }`);
 *  - a `DriverAdapterError` itself, which carries its kind at `cause.kind`, matched by name as
 *    `@prisma/driver-adapter-utils` does (it is not a direct dependency);
 *  - a raw Node socket error: a refused connection to a host that resolves to two addresses is an
 *    `AggregateError` with an own `code: 'ECONNREFUSED'` and the per-address errors in `errors`, so
 *    the own code decides, else every one of a non-empty `errors` must carry a network code.
 *
 * Any Node socket error that reaches this function reads as an outage, not only the database's.
 */
export function isDatabaseUnavailable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return UNAVAILABLE_CODES.has(e.code) || NETWORK_CODES.has(e.code) || isUnavailableKind(adapterCause(e)?.kind);
  }
  if (!(e instanceof Error)) return false;
  if (e.name === 'DriverAdapterError' && isObject(e.cause) && isUnavailableKind(e.cause.kind)) return true;
  if (hasNetworkCode(e)) return true;
  const inner = (e as { errors?: unknown }).errors;
  // An empty `errors` must not read as "all of them are network errors".
  return Array.isArray(inner) && inner.length > 0 && inner.every(hasNetworkCode);
}
