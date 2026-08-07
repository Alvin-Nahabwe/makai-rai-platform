import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TenantTx } from '@/lib/data/tenant';

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
 * transaction, so it can be unit-tested and reused by a content-agreement
 * check independent of `getCurrentVersionId`'s own DB half.
 */
export function readCurrentContentVersion(): string {
  const raw = readFileSync(join(process.cwd(), 'data', 'assessmentAreas.json'), 'utf8');
  const parsed = JSON.parse(raw) as { meta?: { version?: string } };
  if (!parsed.meta?.version) {
    throw new Error('data/assessmentAreas.json has no meta.version to read the framework version from.');
  }
  return parsed.meta.version;
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
