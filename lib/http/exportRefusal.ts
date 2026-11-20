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

/** Why the working report page was given back a refused download (fix wave item 8; silent-failure audit I1). A closed set. */
export type ReportRefusal = 'report_busy' | 'part' | 'not_found' | 'internal_error';
const REPORT_REFUSALS: ReadonlySet<string> = new Set<ReportRefusal>(['report_busy', 'part', 'not_found', 'internal_error']);
/** A support reference as lib/http/supportReference.ts makes it: eight lowercase hexadecimal characters. */
const REFERENCE = /^[0-9a-f]{8}$/;

/**
 * Where a refused working-report download goes back to when a browser opened it as a page: the report page of the same project,
 * with the reason (and, for a server fault, its support reference) in the query. Same rules as `exportRefusalLocation`: the slug and
 * id enter the path only after they pass their pattern, and `null` means "keep the route's JSON".
 */
export function reportRefusalLocation(slug: string, projectId: string, reason: ReportRefusal, reference?: string): string | null {
  if (!SLUG.test(slug) || !PROJECT_ID.test(projectId)) return null;
  if (reason === 'internal_error') return reference !== undefined && REFERENCE.test(reference) ? `/orgs/${slug}/projects/${projectId}/report?refused=internal_error&reference=${reference}` : null;
  return `/orgs/${slug}/projects/${projectId}/report?refused=${reason}`;
}

/** The report page's reading of its query: the refusal to show, or null for anything else (a list, an unknown reason, a bad reference). */
export function reportRefusalFrom(searchParams: Record<string, string | string[] | undefined>): { reason: ReportRefusal; reference: string | null } | null {
  const r = searchParams.refused;
  if (typeof r !== 'string' || !REPORT_REFUSALS.has(r)) return null;
  if (r !== 'internal_error') return { reason: r as ReportRefusal, reference: null };
  const ref = searchParams.reference;
  return typeof ref === 'string' && REFERENCE.test(ref) ? { reason: 'internal_error', reference: ref } : null;
}
