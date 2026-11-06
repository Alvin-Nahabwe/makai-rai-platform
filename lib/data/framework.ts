import { runningContent } from '@/lib/content/loader';
import type { TenantTx } from '@/lib/data/tenant';
import { AppError } from '@/lib/http/errors';
import type { ContentRef } from '@/types/api';

/**
 * The content registry lookups (ADR-0003; FR-DEC-02, FR-CNT-07). `framework_versions` is reference data with no RLS;
 * makrai_app holds SELECT on it, so both run inside the caller's `withOrg` transaction. The 4.0.0 resolvers that
 * pinned an assessment to the files at data/ (getPinnedVersion, readCurrentContentVersion, resolvePublishedVersion,
 * resolveCurrentFramework, resolveFramework) are gone: RM removed every route that called them, and nothing here
 * reads the 4.0.0 bundle hash any more: lib/framework/bundleHash.ts was removed in 0.6.0.
 */

/**
 * The published `framework_versions` row whose semver and hash both equal the running content's, else
 * `AppError(503, 'content_not_published')` (K-2, SRS line 273). Content edited after its registry migration
 * hashes differently and finds no match, so every save stops until the new version is published; a row that
 * is deprecated no longer opens the gate either. The message is the code alone, because a response carries it.
 *
 * Looked up by the unique `semver` and compared in code, so a missing value can never widen the match: Prisma
 * drops an `undefined` filter key, which would turn a three-key `where` into a looser one.
 */
export async function resolveRunningContentVersion(tx: TenantTx): Promise<ContentRef> {
  const c = runningContent();
  const row = await tx.frameworkVersion.findUnique({
    where: { semver: c.semver },
    select: { id: true, semver: true, contentHash: true, status: true },
  });
  if (row === null || row.contentHash !== c.contentHash || row.status !== 'published') {
    throw new AppError(503, 'content_not_published');
  }
  return { contentVersionId: row.id, semver: row.semver, contentHash: row.contentHash };
}

/**
 * The registered version a stored decision names, whatever its status: an old version stays readable after a
 * newer one is published (FR-CNT-07). An id no row holds answers `unknown_content_version` (500), because
 * the id came from a row the product wrote.
 */
export async function contentRefById(tx: TenantTx, contentVersionId: string): Promise<ContentRef> {
  const row = await tx.frameworkVersion.findUnique({
    where: { id: contentVersionId },
    select: { id: true, semver: true, contentHash: true },
  });
  if (row === null) throw new AppError(500, 'unknown_content_version');
  return { contentVersionId: row.id, semver: row.semver, contentHash: row.contentHash };
}
