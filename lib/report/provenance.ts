/**
 * Plan 1c Task 9 (O-14 completed half, O-15). Shared by BOTH report
 * surfaces -- the HTML `components/report/ReportSummary.tsx` and the PDF
 * `lib/pdf/ReportPdf.tsx` -- so the exact copy and the drift condition
 * cannot drift between them. Two independent implementations of one fact
 * disagreeing is the exact shape design decision #6
 * (docs/superpowers/specs/2026-08-06-phase1c-evidence-and-pinning-design.md
 * §1) names for why `evidenceLevel` had to become derived rather than
 * hand-set from two places.
 *
 * Deliberately dependency-free: no React, no `lib/data/framework.ts`, no
 * Node builtins. `ReportSummary.tsx` is a `'use client'` component shipped
 * to the browser -- `lib/data/framework.ts` computes
 * `const RUNNING_BUNDLE_HASH = computeBundleHash()` at module load
 * (`node:crypto` + `node:fs`, see `lib/framework/bundleHash.ts`), so
 * importing it from a client component would either break the browser
 * bundle or silently pull Node-only code into it. This module never
 * imports anything that could do that.
 */

export interface ProvenanceInfo {
  /** `framework_versions.semver` this assessment is pinned to. */
  semver: string;
  /**
   * The date THIS ASSESSMENT was pinned, formatted `YYYY-MM-DD` by the
   * caller. That is `Assessment.startedAt`, not
   * `framework_versions.publishedAt`: the pin is written once, at creation
   * (`prisma/schema.prisma`'s `Assessment.frameworkVersionId` comment,
   * "written once" -- an `UPDATE` changing it is rejected by a database
   * trigger, O-3), so the moment the assessment itself became pinned to
   * this version IS the moment it started. `publishedAt` is a property of
   * the VERSION, shared by every assessment ever pinned to it, and answers
   * a different question ("when was 3.0.0 published") than the one an
   * auditor reading THIS report is asking ("when was THIS assessment
   * pinned"). `resolveFramework`'s own `PinnedVersion` type
   * (`lib/data/framework.ts`) carries no date field at all -- confirming
   * this reading by its absence, not merely by inference from the copy.
   */
  pinnedDate: string;
  /** `framework_versions.contentHash` -- full sha256 hex. This function
   * truncates it to the first 8 characters per the design doc's exact
   * copy (`docs/superpowers/specs/2026-08-06-...-design.md` §4.2). */
  contentHash: string;
}

/**
 * O-15's exact required copy:
 * "Assessed against MAK-AI RAI Framework {semver}, pinned {date} ·
 * content {hash8}…"
 * An ISO 42001 auditor's first question about any assessment is which
 * version of the control set it was answered against -- before this task,
 * no surface in this product could answer it.
 */
export function formatProvenanceLine({ semver, pinnedDate, contentHash }: ProvenanceInfo): string {
  return `Assessed against MAK-AI RAI Framework ${semver}, pinned ${pinnedDate} · content ${contentHash.slice(0, 8)}…`;
}

/**
 * O-14, completed half (design doc §4.1): "Completed → render the cached
 * reportData with a provenance banner." Deliberately asymmetric: an
 * in-progress, mismatched assessment has no cached report yet to annotate,
 * and Task 6 already stops it from accepting further evidence
 * (`app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts`, `kind:
 * 'drifted'`) -- this function only ever decides whether the REPORT
 * SURFACE should show a mismatch banner, and for an in-progress assessment
 * the answer is "there is nothing to show yet", not merely "false because
 * matches happens to be false".
 *
 * `status` is typed `string`, not Prisma's generated `AssessmentStatus`
 * enum, so this module stays importable from a `'use client'` component
 * without pulling in `@prisma/client` runtime code -- `AssessmentStatus`
 * has exactly two values (`'in_progress' | 'completed'`,
 * `prisma/schema.prisma`), and this function only ever compares against
 * the literal `'completed'`.
 */
export function isFrameworkDrifted(status: string, matches: boolean): boolean {
  return status === 'completed' && !matches;
}

/**
 * The drift banner's copy. Extracted here (fix round 2) rather than left
 * independently duplicated in `ReportSummary.tsx` and `ReportPdf.tsx` --
 * exactly the shape this module's own header comment warns about: the two
 * copies had ALREADY drifted from each other by the time this was
 * extracted (one used an em dash, the other a colon, from an unrelated
 * authoring slip), and a single source of truth is what O-15's
 * `formatProvenanceLine` already does for the identical reason.
 *
 * Fix round 2, Critical: this copy previously read "...it has not been
 * recomputed against the newer content" -- true only for an assessment
 * whose completion was itself gated on drift (the gate `completeAssessment`
 * gained this same round, closing a path fix round 1 missed entirely). It
 * is NOT knowable from stored data alone whether an assessment completed
 * before that gate existed was scored against matching or already-drifted
 * content -- nothing records what was deployed AT completion time, only
 * what is deployed now. This copy therefore asserts only what holds
 * unconditionally, for every reachable state now and before this fix:
 * the cached report reflects whatever was recorded at completion, and
 * viewing it never triggers a recalculation. It does not claim that
 * recording was itself against matching content, which cannot be verified
 * after the fact for data that predates the completion-time guard.
 */
export function driftBannerText(): string {
  return (
    'The framework content deployed today differs from the pinned version this assessment ' +
    "was answered against. This report reflects the assessment's state as recorded at " +
    'completion — it is not recalculated when viewed.'
  );
}
