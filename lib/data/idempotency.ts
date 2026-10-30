import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { canonicalJson } from '../integrity/canonical.mjs';
import { AppError, ValidationFailed } from '../http/errors';
import type { WriteOutcome } from '../../types/record';
import { isDatabaseUnavailable } from './pgErrors';
import { withOrg, type OrgContext, type TenantTx } from './tenant';

/**
 * Retry-safe writes (SRS 5.3 item 4, line 1261; 9.5 rule 5; NFR-INT-02; FR-DEC-07), exactly as
 * 00-contract.md's Services row for `idempotentWrite` fixes them (rounds 9 and 9b).
 *
 * A request carries a request id, unique per organisation, and the digest of its path ids and
 * body. A repeat by the same account with the same digest answers the first result and creates
 * nothing; any other repeat answers 409 `request_id_reused` with no row data, so a reused id
 * never shows one account's row to another (obligation S8).
 *
 * Normal mode keys on the record table's own (orgId, requestId) unique index: select, then
 * insert, never ON CONFLICT (R5 section B.7; `__tests__/lint/no-on-conflict-append-only.test.ts`).
 * Receipt mode (owner answer A1) keys on `request_receipts` for the routes whose effect is not
 * a row of one of these tables.
 */

/** The eleven tables that carry the request columns (00-contract.md, Data model, "Request columns"). */
export type IdempotentTable =
  | 'decision_versions' | 'evidence' | 'findings' | 'finding_events' | 'mitigation_versions' | 'accepted_risks'
  | 'stage_reviews' | 'seals' | 'issued_documents' | 'document_events' | 'request_receipts';

/** The response fields a receipt may keep for a replay: booleans and numbers only (round 9b), never a token, URL, address or free text. */
export type ReceiptResult = Record<string, boolean | number | null>;

type RecordTable = Exclude<IdempotentTable, 'request_receipts'>;

/** The entering column each record table's actor is compared on. */
const ENTERED_BY: Readonly<Record<RecordTable, string>> = Object.freeze({
  decision_versions: 'enteredById',
  evidence: 'uploadedById',
  findings: 'raisedById',
  finding_events: 'byId',
  mitigation_versions: 'enteredById',
  accepted_risks: 'enteredById',
  stage_reviews: 'openedById',
  seals: 'sealedById',
  issued_documents: 'issuedById',
  document_events: 'byId',
});

/** Lowercase hex SHA-256 of `canonicalJson(body)`; routes pass `{ path, body }` (contract, Services intro). Throws TypeError on a float. */
export function requestDigest(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An 8-4-4-4-12 hexadecimal UUID, either case, any version. */
export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && REQUEST_ID.test(v);
}

/**
 * The RFC 4122 version-5 UUID with namespace `requestId` and name `scope` (UTF-8), lowercase:
 * the request id of a further row one request creates in the same table (contract, "Request
 * columns"), deterministic, so a replay derives the same ids (executed claim E-15).
 */
export function derivedRequestId(requestId: string, scope: string): string {
  if (!isRequestId(requestId)) throw new TypeError('derivedRequestId: requestId is not a UUID');
  const namespace = Buffer.from(requestId.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(Buffer.from(scope, 'utf8')).digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;   // version 5
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

type NormalArgs<T> = {
  table: RecordTable; requestId: string; digest: string; actorUserId: string;
  write: (tx: TenantTx) => Promise<T>;
  replay: (tx: TenantTx, rowId: string) => Promise<T>;
  isolationLevel?: 'ReadCommitted' | 'RepeatableRead';
};
type ReceiptArgs<T> = {
  table: 'request_receipts'; route: string; requestId: string; digest: string; actorUserId: string;
  write: (tx: TenantTx) => Promise<T>;
  receipt: (result: T) => { rowId: string | null; result?: ReceiptResult };
  replay: (tx: TenantTx, receipt: { rowId: string | null; result: ReceiptResult | null }) => Promise<T>;
};

function requireRequestId(requestId: unknown): void {
  if (!isRequestId(requestId)) {
    throw new ValidationFailed([{ field: 'requestId', message: 'requestId must be a UUID (8-4-4-4-12 hexadecimal).' }]);
  }
}

const reused = () => new AppError(409, 'request_id_reused');

export function idempotentWrite<T>(ctx: OrgContext, a: NormalArgs<T>): Promise<WriteOutcome<T>>;
export function idempotentWrite<T>(ctx: OrgContext, a: ReceiptArgs<T>): Promise<WriteOutcome<T>>;
export async function idempotentWrite<T>(ctx: OrgContext, a: NormalArgs<T> | ReceiptArgs<T>): Promise<WriteOutcome<T>> {
  // Before any SQL (finding F29): a malformed id is the client's error, answered on its field.
  requireRequestId(a.requestId);
  return a.table === 'request_receipts' ? receiptWrite(ctx, a) : recordWrite(ctx, a);
}

/**
 * Normal mode: look up (orgId, requestId) in the record table; found with the same actor and
 * digest, replay; found otherwise, 409; not found, write, and check in the same transaction
 * that the write stamped this request's id, actor and digest on its row (otherwise every retry
 * of an append-only write would add another row; a TypeError, which rolls the write back).
 *
 * If the attempt fails, its transaction is rolled back (it is unusable after an error, executed
 * claim E-4) and a new transaction looks again, with the same three outcomes; finding no row,
 * the attempt's own error is rethrown unchanged for the caller to map (a real conflict, such as
 * a base version that moved). 5.3 item 4 names the unique violation, the usual way a concurrent
 * copy fails; the look-again also covers a copy whose own state check fails because the first
 * copy committed between this copy's lookup and its write (a base version that "moved" to this
 * same request's row), which must replay too. An unreachable database is rethrown at once.
 */
async function recordWrite<T>(ctx: OrgContext, a: NormalArgs<T>): Promise<WriteOutcome<T>> {
  if (!Object.hasOwn(ENTERED_BY, a.table)) throw new TypeError(`idempotentWrite: ${String(a.table)} is not a retry-keyed table`);
  const actorColumn = ENTERED_BY[a.table];
  const options = a.isolationLevel === undefined ? undefined : { isolationLevel: a.isolationLevel };

  const replayIfSeen = async (tx: TenantTx): Promise<WriteOutcome<T> | null> => {
    // The table and column come from the closed list above, never from input.
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; requestDigest: string | null; actor: string | null }>>(
      `SELECT "id", "requestDigest", "${actorColumn}" AS "actor" FROM "${a.table}" WHERE "orgId" = $1 AND "requestId" = $2::uuid`,
      ctx.orgId, a.requestId,
    );
    if (rows.length === 0) return null;
    const [row] = rows;
    if (row.actor !== a.actorUserId || row.requestDigest !== a.digest) throw reused();
    return { replayed: true, value: await a.replay(tx, row.id) };
  };

  const writeOnce = async (tx: TenantTx): Promise<WriteOutcome<T>> => {
    const value = await a.write(tx);
    const stamped = await tx.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT ("requestDigest" = $3 AND "${actorColumn}" = $4) AS "ok" FROM "${a.table}" WHERE "orgId" = $1 AND "requestId" = $2::uuid`,
      ctx.orgId, a.requestId, a.digest, a.actorUserId,
    );
    if (stamped.length !== 1 || !stamped[0].ok) {
      throw new TypeError(`idempotentWrite: the write to ${a.table} did not stamp this request's id, digest and actor on its row`);
    }
    return { replayed: false, value };
  };

  try {
    return await withOrg(ctx, async (tx) => (await replayIfSeen(tx)) ?? writeOnce(tx), options);
  } catch (e) {
    if (isDatabaseUnavailable(e)) throw e;
    const again = await withOrg(ctx, replayIfSeen, options);
    if (again === null) throw e;
    return again;
  }
}

/**
 * Receipt mode (owner answer A1; contract rounds 9 and 9b): one transaction, always at READ
 * COMMITTED (under REPEATABLE READ the snapshot would be taken before the lock wait, so a later
 * copy could not see the first copy's receipt), serialised per (organisation, request id) by a
 * transaction-scoped advisory lock. Found with the same actor, route and digest: replay; any of
 * the three different: 409 with no row data; not found: write, then the receipt, in the same
 * transaction, so a write that throws leaves no receipt and a concurrent copy always meets the
 * committed receipt.
 */
async function receiptWrite<T>(ctx: OrgContext, a: ReceiptArgs<T>): Promise<WriteOutcome<T>> {
  return withOrg(
    ctx,
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.orgId} || ':' || ${a.requestId.toLowerCase()}, 0))`;
      const found = await tx.requestReceipt.findUnique({
        where: { orgId_requestId: { orgId: ctx.orgId, requestId: a.requestId } },
        select: { requestDigest: true, actorUserId: true, route: true, rowId: true, result: true },
      });
      if (found !== null) {
        if (found.actorUserId !== a.actorUserId || found.route !== a.route || found.requestDigest !== a.digest) throw reused();
        return { replayed: true, value: await a.replay(tx, { rowId: found.rowId, result: found.result as ReceiptResult | null }) };
      }
      const value = await a.write(tx);
      const { rowId, result } = a.receipt(value);
      await tx.requestReceipt.create({
        data: {
          orgId: ctx.orgId, requestId: a.requestId, requestDigest: a.digest, actorUserId: a.actorUserId, route: a.route,
          rowId, result: result === undefined ? Prisma.DbNull : checkedReceiptResult(result),
        },
      });
      return { replayed: false, value };
    },
    { isolationLevel: 'ReadCommitted' },
  );
}

/** Refuses at run time what the type refuses at compile time: a stored value that is not a boolean, a finite number or null. */
function checkedReceiptResult(result: ReceiptResult): ReceiptResult {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new TypeError('idempotentWrite: a receipt result is an object of booleans, numbers and nulls');
  }
  for (const [key, v] of Object.entries(result)) {
    const ok = v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
    if (!ok) throw new TypeError(`idempotentWrite: receipt result ${key} is not a boolean, a number or null`);
  }
  return result;
}
