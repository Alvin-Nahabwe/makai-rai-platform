/**
 * Where a refused export goes back to (contract Routes row 20, owner question B4): S-20's page of the same
 * scope, with the reason in the query. The proxy builds it for the hourly limit (`rate_limited`) and EXP's
 * handler for the platform-wide cap (`export_busy`), both through this one function so they cannot disagree.
 *
 * Pure, and the only place the shapes of a slug and a project id are written for this purpose. The slug and
 * the id are put into the path only after they pass their pattern, so nothing the caller sent is echoed
 * unchecked; `null` means "do not redirect, keep the JSON 429".
 */

/** The alphabet `deriveSlug` produces (lib/data/preauth.ts:462-474). */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Prisma's `uuid()` ids, lower case (prisma/schema.prisma:101). */
const PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function exportRefusalLocation(
  slug: string,
  projectId: string | null,
  reason: 'export_busy' | 'rate_limited',
): string | null {
  if (!SLUG.test(slug)) return null;
  if (projectId === null) return `/orgs/${slug}/export?refused=${reason}`;
  if (!PROJECT_ID.test(projectId)) return null;
  return `/orgs/${slug}/projects/${projectId}/export?refused=${reason}`;
}
