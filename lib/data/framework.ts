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
 * NOT tenant data and has no RLS -- makrai_app holds SELECT on it, load-bearing
 * for this read (the report's provenance line, and the drift check
 * `resolveFramework` layers on top of it) as well as for
 * `resolveCurrentFramework`'s creation-time read below. See ADR-0003.
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
 * `components/report/useFindingsData.ts`, renamed from `useEvidenceData.ts`
 * in Plan 1c Task 9); (b) removes synchronous disk I/O
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
 * Resolves the `framework_versions` row for an explicit semver, requiring
 * `status = 'published'`.
 *
 * C6 whole-branch review, F5: this used to be `resolvePublishedVersionId`
 * and selected `id` alone. It now returns the whole `PinnedVersion`,
 * because `contentHash` is what `resolveCurrentFramework` below needs to
 * answer "does the deployed content still match the row we are about to
 * pin to?" -- and re-querying for it, or duplicating the throw-no-fallback
 * rule in a second function, would be two mechanisms for one fact (design
 * decision #6, the reason `evidenceLevel` had to become derived).
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
export async function resolvePublishedVersion(semver: string, tx: TenantTx): Promise<PinnedVersion> {
  const row = await tx.frameworkVersion.findFirst({
    where: { semver, status: 'published' },
    select: { id: true, semver: true, contentHash: true },
  });
  if (!row) {
    throw new Error(
      `No published framework_versions row matches content version "${semver}". ` +
        'An assessment cannot be created without a version to pin against -- register the version first.',
    );
  }
  return row;
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
 * The framework version a NEW assessment should be pinned to -- whatever
 * `data/assessmentAreas.json` currently declares, resolved to its
 * `framework_versions` row -- AND whether the deployed content bundle still
 * hashes to what that row records.
 *
 * C6 whole-branch review, F5. This replaces `getCurrentVersionId`, which
 * returned an id and nothing else. Resolving by SEMVER STRING ALONE is not
 * enough to make a pin meaningful: content edited without a `meta.version`
 * bump still resolves to the same row, whose `contentHash` no longer
 * describes what is deployed. Creation then succeeded (201) and pinned the
 * assessment to a version it did not match, and the very first autosave
 * PATCH hit `respondToAssessment`'s own drift check and 409'd -- for good,
 * since there is no in-product way to re-pin or revert (D-167). The three
 * existing O-14 guards all sat on WRITES to an existing assessment; nothing
 * guarded the write that brings one into existence.
 *
 * Returns the SAME `FrameworkResolution` shape `resolveFramework` returns
 * for an existing assessment, deliberately: the caller then branches on
 * `!resolution.matches`, the identical idiom the other three guards use,
 * which is also the source string
 * `__tests__/integration/trigger-enumeration.test.ts` greps for. A differently-shaped check here would have been correct and
 * still unenumerable.
 *
 * Not a fallback and not a repair: `resolvePublishedVersion` still throws
 * when nothing matches the semver at all (D-147's separate failure mode),
 * and this function never picks a different row to "make it work".
 */
export async function resolveCurrentFramework(tx: TenantTx): Promise<FrameworkResolution> {
  return toResolution(await resolvePublishedVersion(readCurrentContentVersion(), tx));
}

/**
 * THE definition of "has the deployed content drifted from this version?",
 * in one place. Extracted by the C6 fix wave's `simplify` pass: this
 * expression was written out longhand in BOTH `resolveCurrentFramework`
 * above and `resolveFramework` below, so the match rule lived in two places
 * from the moment the fourth guard was added. A future change to it — a
 * second condition, a normalisation step — would have had to be made twice
 * or the two would silently disagree. That is the same "two mechanisms for
 * one fact" defect design decision #6 gives as the reason `evidenceLevel`
 * had to become derived, and this file's own doc comments already invoke it
 * elsewhere; it just had not been applied to this line.
 */
function toResolution(pinned: PinnedVersion): FrameworkResolution {
  return { pinned, matches: pinned.contentHash === RUNNING_BUNDLE_HASH };
}

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
  return toResolution(pinned);
}
