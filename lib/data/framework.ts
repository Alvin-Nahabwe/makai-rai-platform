import assessmentAreas from '@/data/assessmentAreas.json';
import type { TenantTx } from '@/lib/data/tenant';
import { computeBundleHash } from '@/lib/framework/bundleHash';

export type PinnedVersion = {
  id: string;
  semver: string;
  contentHash: string;
};

/**
 * The pinned framework version for one assessment.
 *
 * Runs inside a withOrg transaction: `assessments` is RLS-protected, so the
 * assessment lookup is tenant-filtered by the GUC. `framework_versions` is
 * NOT tenant data and has no RLS -- makrai_app holds SELECT on it for exactly
 * this read (the report's provenance line).
 */
export async function getPinnedVersion(
  assessmentId: string,
  tx: TenantTx,
): Promise<PinnedVersion | null> {
  const row = await tx.assessment.findUnique({
    where: { id: assessmentId },
    select: {
      frameworkVersion: { select: { id: true, semver: true, contentHash: true } },
    },
  });
  return row?.frameworkVersion ?? null;
}

/**
 * The write half of the pin (fix round 1, 2026-08-07, coordinator-authorised
 * Task 1 scope extension). `getPinnedVersion` above reads back a pin an
 * assessment already has; this resolves what a NEW assessment should be
 * pinned to, at creation time.
 *
 * `data/assessmentAreas.json`'s `meta.version` is the framework version --
 * NOT `engineState.version` (the engine's own version, D-138) and NOT
 * `Assessment.version` (an attempt counter). Pure: no database, no
 * transaction, so it can be unit-tested on its own.
 *
 * STATIC import (fix round 2, 2026-08-08), not `readFileSync` -- four
 * reasons, none of them "the prior version was broken in production" (it
 * was not; the coordinator verified `@vercel/nft` traces an all-literal
 * `readFileSync` path into the standalone build same as it would any other
 * traced file, and `.next/standalone/data/assessmentAreas.json` was present
 * either way). (a) matches how every other production consumer of this file
 * already loads it (`app/(authenticated)/explore/framework/page.tsx`,
 * `app/(authenticated)/explore/controls/page.tsx`,
 * `components/report/useEvidenceData.ts`); (b) removes synchronous disk I/O
 * from inside an open `withOrg` transaction, which holds one of only 10
 * pooled connections (`lib/data/tenant.ts:125`); (c) removes the unchecked
 * `as { meta?: { version?: string } }` cast that `readFileSync` + `JSON.parse`
 * needed -- with `resolveJsonModule`, TypeScript infers `meta.version`'s
 * real type from the file, so a future edit that made it a JSON number
 * (`3` instead of `"3.0.0"`) is a compile error here, not a value that
 * silently passed the old `!parsed.meta?.version` guard (truthy for any
 * non-zero number) and returned from a function typed `: string`;
 * (d) stops depending on an `nft` static-path-tracing heuristic nobody
 * chose deliberately.
 *
 * Reused directly by the content-agreement test
 * (`__tests__/integration/framework-current-version.test.ts`), which calls
 * this function for the `assessmentAreas` side of the comparison rather
 * than importing the JSON file a second time.
 */
export function readCurrentContentVersion(): string {
  const version = assessmentAreas.meta.version;
  if (!version) {
    throw new Error('data/assessmentAreas.json meta.version is empty.');
  }
  return version;
}

/**
 * Resolves the `framework_versions` row id for an explicit semver, requiring
 * `status = 'published'`.
 *
 * NO FALLBACK. If nothing matches, this throws -- never "the newest row",
 * never a default, never null for the caller to silently paper over. An
 * unpinnable assessment must not be creatable: a silent fallback here would
 * reproduce the exact defect this whole plan exists to close, a provenance
 * field holding a value nobody verified (AGENTS.md §2 fallback trigger).
 * Runs inside the caller's own `withOrg` transaction -- `framework_versions`
 * carries no RLS, so no org context is required for this read, but no
 * caller should open a second transaction for it either (one transaction
 * per request, matching the rest of this route's writes).
 */
export async function resolvePublishedVersionId(semver: string, tx: TenantTx): Promise<string> {
  const row = await tx.frameworkVersion.findFirst({
    where: { semver, status: 'published' },
    select: { id: true },
  });
  if (!row) {
    throw new Error(
      `No published framework_versions row matches content version "${semver}". ` +
        'An assessment cannot be created without a version to pin against -- register the version first.',
    );
  }
  return row.id;
}

/**
 * The framework version a NEW assessment should be pinned to: whatever
 * `data/assessmentAreas.json` currently declares, resolved to its
 * `framework_versions` row. Exported and independent per the coordinator's
 * note -- Task 2 extends this file with `resolveFramework` (which reads
 * back an EXISTING pin via `getPinnedVersion`), a different concern this
 * function does not overlap with.
 */
export async function getCurrentVersionId(tx: TenantTx): Promise<string> {
  return resolvePublishedVersionId(readCurrentContentVersion(), tx);
}

/**
 * Computed once at module load. The content files are static imports in every
 * other consumer, so they cannot change under a running process.
 */
const RUNNING_BUNDLE_HASH = computeBundleHash();

export type FrameworkResolution = {
  pinned: PinnedVersion;
  /** false when the deployed content does not match what this assessment pinned. */
  matches: boolean;
};

/**
 * Makes the pin mean something (Task 2, O-13/O-14 first half): reads back
 * what an assessment is pinned to (`getPinnedVersion`, already tenant-scoped
 * by the caller's `tx`) and reports whether the DEPLOYED content bundle's
 * hash still matches the hash recorded at pin time. `null` when the
 * assessment itself does not resolve (mirrors `getPinnedVersion`'s own
 * contract) -- not a fallback, a pass-through of "no such assessment in this
 * tenant's context".
 */
export async function resolveFramework(
  assessmentId: string,
  tx: TenantTx,
): Promise<FrameworkResolution | null> {
  const pinned = await getPinnedVersion(assessmentId, tx);
  if (!pinned) return null;
  return { pinned, matches: pinned.contentHash === RUNNING_BUNDLE_HASH };
}
