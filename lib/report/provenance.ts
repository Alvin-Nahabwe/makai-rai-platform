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
 * in-progress, mismatched assessment has no report SURFACE to annotate,
 * and Task 6 already stops it from accepting further evidence
 * (`app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts`, `kind:
 * 'drifted'`) -- this function only ever decides whether the REPORT
 * SURFACE should show a mismatch banner, and for an in-progress assessment
 * the answer is "there is nothing to show yet", not merely "false because
 * matches happens to be false".
 *
 * C6 whole-branch review, F1 -- READ THIS BEFORE TRUSTING THE PARAGRAPH
 * ABOVE. It used to say an in-progress assessment "has no cached report
 * yet to annotate". True of the HTML page, which redirects a non-completed
 * assessment away; FALSE of the PDF route, which computed one inline from
 * `engineState` against DEPLOYED content and stamped the pinned hash on
 * it -- so the `status !== 'completed'` arm of this function was actively
 * SUPPRESSING the banner on the one document that most needed it. The
 * premise is now true rather than assumed: that route returns 409 for a
 * non-completed assessment (see its own comment), so neither surface
 * reaches this function with one, and the asymmetry is safe for the reason
 * stated rather than by luck.
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
 * How much of the surface asking for this banner is actually cached.
 *
 * C6 whole-branch review, F3: this parameter exists because the two
 * surfaces differ, and one sentence could not be true of both.
 *
 * - `'cached-only'` — every value the surface renders comes from the
 *   assessment's stored `reportData`. `lib/pdf/ReportPdf.tsx` is this: it
 *   destructures exactly `overallScore`, `completedStages` and
 *   `principleScores` off `reportData` and reads no framework content at
 *   all.
 * - `'live-findings'` — scores come from the cached report, but the
 *   surface ALSO renders question- and area-level material recomputed from
 *   the DEPLOYED content on every view. The HTML report page is this:
 *   `components/report/useFindingsData.ts` statically imports
 *   `data/questionBank.json` and `data/assessmentAreas.json` and rebuilds
 *   `gaps`/`attentions`/`strengths`/`notAssessed` — and therefore the
 *   counts `ReportSummary` displays — inside a `useMemo` keyed only on
 *   `report`/`engineState`, never on the pin. The per-principle
 *   scorecards are MIXED: each `pct`/`level` comes from the cached
 *   `report.principleScores`, while the list of questions rendered under
 *   it comes from today's bank.
 *
 *   The copy for this scope deliberately does NOT enumerate the affected
 *   sections. A `code-review` pass on the first version of this fix read
 *   its four-item list as a complete inventory and reported the principle
 *   scorecards as a missed case — the reviewer's specific claim was wrong
 *   (those percentages ARE cached), but the underlying objection was
 *   right: an enumeration inside user-facing copy is a claim of
 *   completeness that nothing keeps true as sections are added. It now
 *   says "the scores are as recorded, everything else is today's", which
 *   stays true however the page grows.
 *
 * Deliberately a required parameter with no default. A default would let a
 * future third surface inherit whichever claim happened to be listed
 * first, which is precisely how the original single-copy version came to
 * make a false statement on one of its two call sites.
 */
export type DriftBannerScope = 'cached-only' | 'live-findings';

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
 *
 * C6 whole-branch review, F3 (this round): "...it is not recalculated when
 * viewed" was still false on the HTML surface, for the report's LARGEST
 * sections. The fix is scoping, not softening -- the words are still owned
 * by this one function, but a caller must say which claim its surface can
 * actually support. Making the claim TRUE instead (snapshotting the
 * question bank into `reportData` at completion) was the alternative
 * considered and not taken: it is a data-model change with a backfill,
 * belongs with Plan 2a's framework-as-data work, and is recorded as D-175
 * rather than done quietly here.
 */
export function driftBannerText(scope: DriftBannerScope): string {
  const opening =
    'The framework content deployed today differs from the pinned version this assessment ' +
    'was answered against. ';
  if (scope === 'cached-only') {
    return (
      opening +
      "This document reflects the assessment's state as recorded at completion — it is not " +
      'recalculated when viewed. Every value shown comes from that stored record.'
    );
  }
  return (
    opening +
    "The scores on this page reflect the assessment's state as recorded at completion and " +
    'are not recalculated when viewed. Everything else shown — which findings are listed, ' +
    "which areas and questions they name, and their counts — is rebuilt from today's " +
    'framework content each time the page loads, so it can differ from what was recorded ' +
    'at completion.'
  );
}

/**
 * The provisional-score marker (ENG-05).
 *
 * `VISION_AND_PLAN.md` §4.1 objects to the headline percentage in specific
 * terms: it is "an opaque absolute" with "no defensible basis for collapsing
 * 21 areas into one percentage", and the single number should be "a rollup,
 * not the headline". The framework's own IP-04 (metric-selection
 * impossibility) argues the same way against false precision.
 *
 * The Phase 1 design spec therefore required that the score render with an
 * explicit provisional marker in UI and PDF until the maturity rubric is
 * derived. Register row D-037 recorded that marker as shipped. It never
 * existed on any surface, which is why this function is the single source for
 * both: a second copy of this sentence would drift from the first, exactly as
 * the area-scoring rule did when it was implemented twice.
 *
 * Remove this marker only when the rubric work lands — not sooner, and not by
 * editing the string to sound more confident.
 */
export function provisionalScoreNote(): string {
  return (
    'Provisional score. The question weights that combine 21 areas into this ' +
    'single number have no published derivation yet, so treat it as a rough ' +
    'rollup rather than a measurement. The per-area findings below are the ' +
    'defensible part of this report.'
  );
}
