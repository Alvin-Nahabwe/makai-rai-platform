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
