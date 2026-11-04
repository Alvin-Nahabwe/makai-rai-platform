import { AppError } from '@/lib/http/errors';
import type { TenantTx } from '@/lib/data/tenant';
import { STORAGE_FULL_TEXT } from '@/lib/evidence/copy';

/** NFR-REL-09, exact copy (the text lives in the pure copy module so the browser modules can import it). */
export { STORAGE_FULL_TEXT };

const DEFAULT_ORG_BYTES = 1073741824;           // 1 GiB
const DEFAULT_ACCOUNT_BYTES_PER_DAY = 209715200; // 200 MiB

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/**
 * The two caps, read on each call so a test (or an operator's restart) changes them with no module state. A value
 * that is not a positive integer is the default (NFR-REL-09, SRS line 3179).
 */
export function storageLimits(env: Readonly<Record<string, string | undefined>> = process.env): { orgBytes: number; accountBytesPerDay: number } {
  return {
    orgBytes: positiveInteger(env.MAKRAI_ORG_STORAGE_CAP_BYTES, DEFAULT_ORG_BYTES),
    accountBytesPerDay: positiveInteger(env.MAKRAI_ACCOUNT_UPLOAD_BYTES_PER_DAY, DEFAULT_ACCOUNT_BYTES_PER_DAY),
  };
}

/**
 * Refuses an upload that would take the organisation, or the uploading account within it, past its cap (413
 * `storage_full`). Takes a per-organisation transaction lock first, so concurrent uploads count one after another.
 * Both sums run inside the tenant transaction, so row-level security limits them to the current organisation: the
 * account cap counts per account within an organisation, and each organisation's own cap bounds its total (contract
 * owner question 12; finding SEC-05). Evidence tables are append-only, so a row lock is not available; the advisory
 * lock is.
 */
export async function assertStorageAvailable(tx: TenantTx, a: { userId: string; addBytes: number }): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('evidence-storage:' || current_setting('app.current_org_id'), 0))`;
  const [org] = await tx.$queryRaw<{ bytes: bigint }[]>`
    SELECT (
      COALESCE((SELECT sum(e."byteSize") FROM "evidence" e WHERE EXISTS (SELECT 1 FROM "evidence_blobs" b WHERE b."evidenceId" = e."id")), 0)
      + COALESCE((SELECT sum("byteSize") FROM "issued_documents" WHERE "pdf" IS NOT NULL), 0)
    )::bigint AS "bytes"`;
  const [account] = await tx.$queryRaw<{ bytes: bigint }[]>`
    SELECT COALESCE(sum("byteSize"), 0)::bigint AS "bytes" FROM "evidence"
    WHERE "uploadedById" = ${a.userId} AND "uploadedAt" > now() - interval '24 hours'`;
  const limits = storageLimits();
  if (Number(org.bytes) + a.addBytes > limits.orgBytes || Number(account.bytes) + a.addBytes > limits.accountBytesPerDay) {
    throw new AppError(413, 'storage_full', STORAGE_FULL_TEXT);
  }
}
