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

/** The database cannot be reached, or dropped the connection: the caller answers 503. */
export function isDatabaseUnavailable(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (UNAVAILABLE_CODES.has(e.code)) return true;
  const kind = adapterCause(e)?.kind;
  return typeof kind === 'string' && UNAVAILABLE_KINDS.has(kind);
}
