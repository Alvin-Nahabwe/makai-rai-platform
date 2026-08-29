/**
 * The single maturity band ladder, and the rule for when a band may be shown
 * as a verdict at all.
 *
 * THIS MODULE IMPORTS NOTHING, AND MUST CONTINUE TO IMPORT NOTHING.
 * `lib/pdf/ReportPdf.tsx` documents why it previously duplicated `getLevel`
 * rather than importing it from `components/report/useFindingsData.ts`: that
 * module statically imports framework content, so importing from it would pull
 * the content into the PDF's module graph and falsify the "cached-only" claim
 * its drift banner depends on -- a claim
 * `__tests__/integration/trigger-enumeration.test.ts` enforces by grepping the
 * PDF's own source. A leaf module lets both call sites share one
 * implementation while that invariant holds. Adding any import here silently
 * re-creates the problem the duplication was avoiding.
 *
 * NO COLOURS ARE EXPORTED. Three colour mechanisms consume these level keys and
 * they are not interchangeable: `levelColors` hexes (data/constants.ts), the
 * `--color-risk-*` CSS custom properties (the project pages), and
 * `GapHeatmap`'s background/foreground PAIRS. Exporting one would force it on
 * all three. This module answers "which band", never "what colour".
 */

/**
 * Inclusive lower bound of each band, in percent.
 *
 * These sit BETWEEN the images of adjacent response options rather than on
 * them. `AssessmentEngine.js#normalizeResponse` divides a likert index by 4, so
 * the five options map to 0/25/50/75/100; the previous boundaries of 75/50/25
 * were three of those five, which meant a uniform "Mostly" answer set landed
 * exactly on the "Strong" edge. Five response levels and four labels means one
 * adjacent pair must share a verdict: the bottom pair does, because for the
 * question the label answers -- does this need action now? -- doing nothing and
 * barely doing anything are the same answer.
 *
 * These are NOT calibrated against outcomes. They restate the answer scale.
 * See the spec's §5 item 1.
 */
export const BAND_MINIMUMS = {
  strong: 87.5,
  developing: 62.5,
  needsWork: 37.5,
} as const;

/** The `SCORING_VERSION` in which this band vocabulary was introduced. */
export const BANDS_INTRODUCED_IN = '6.0.0';

/**
 * Every `SCORING_VERSION` whose reports may be labelled with THIS vocabulary.
 *
 * A SET, not a comparison, for the reason the report-shape-migration spec
 * models its `from` field as one: several scoring versions can denote a single
 * vocabulary, and a future version that leaves the bands untouched joins the
 * set. It is also fail-closed by construction -- `undefined`, an unparseable
 * string and a version newer than this build are all equally non-members, so
 * there is no lexical-versus-numeric ordering bug available to write.
 *
 * WHEN YOU BUMP `SCORING_VERSION`: if the bands are unchanged, add the new
 * value here. Forgetting withholds a label that could have been shown, which is
 * the safe direction to fail.
 */
const KNOWN_BAND_VERSIONS: ReadonlySet<string> = new Set([BANDS_INTRODUCED_IN]);

/**
 * Classify an assessed-maturity percentage.
 *
 * Fix round 1 (coordinator-authorized, 2026-08-26, Task 4
 * "maturity-band-reanchor"): the guard below used to check only
 * `pct === null`, which covers ONE of three ways a value this function
 * cannot classify can arrive:
 *
 *   - `undefined` -- the declared type admits it directly. A cached report
 *     is read back through `assessment.reportData as unknown as ReportData`
 *     (`app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts`), and that cast is
 *     a compile-time claim the stored JSON can violate at runtime: a report
 *     computed under an older scoring version, or missing a key the current
 *     type declares as always present, deserialises with `undefined` at
 *     that key rather than an error.
 *   - `NaN` -- not hypothetical. D-216 (docs/DEFERRED_REGISTER.md) records a
 *     prior defect where an unguarded computation could silently produce
 *     it, and a test that compared `NaN` to `NaN` did not notice.
 *   - `+/-Infinity` -- same shape as `NaN`: a `number` at the type level,
 *     not a percentage at the value level.
 *
 * `null`, `undefined` and `NaN` all make `>= 87.5` (and every other
 * threshold below) evaluate to `false` in JS, so without a guard that
 * catches all three, a value this function cannot classify falls through
 * every branch and lands in 'critical' -- the worst band -- silently. That
 * is worse than rendering nothing: 'critical' is the one band that tells a
 * team to drop everything and act, and asserting it for a value that could
 * not be read is a false verdict in a governance document. The only honest
 * answer when this function cannot compute one is 'notAssessed', so every
 * non-computable input maps there, not just the one the original type
 * signature happened to name.
 *
 * This guard does not excuse the producer from ever emitting a non-finite
 * maturity -- see the "never produce non-finite maturity" test in
 * `__tests__/engine/AssessmentEngine.test.js`, which asserts
 * `calculateAreaScores`/`calculatePrincipleScores` themselves stay within
 * `null | [0, 100]`. A guard here that stayed silent about a genuine
 * computation fault would just move the D-216 failure mode from "untested"
 * to "untestably absorbed"; the two checks are paired on purpose.
 */
export function getLevel(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'notAssessed';
  if (pct >= BAND_MINIMUMS.strong) return 'strong';
  if (pct >= BAND_MINIMUMS.developing) return 'developing';
  if (pct >= BAND_MINIMUMS.needsWork) return 'needsWork';
  return 'critical';
}

/**
 * Legend text for a band, derived from `BAND_MINIMUMS` rather than restated.
 *
 * Minimum-anchored, not an integer range. The previous form was `'50–74%'`,
 * which fractional minimums make unrepresentable: `'62.5–87.4%'` is simply
 * wrong, because 87.45 is still `developing`.
 *
 * `notAssessed` deliberately gets `null`: it means "no maturity question exists
 * here at all", which is not a point on the 0-100 scale the other four divide.
 */
export function levelRange(key: string): string | null {
  switch (key) {
    case 'strong':
      return `${BAND_MINIMUMS.strong}% and above`;
    case 'developing':
      return `${BAND_MINIMUMS.developing}% to under ${BAND_MINIMUMS.strong}%`;
    case 'needsWork':
      return `${BAND_MINIMUMS.needsWork}% to under ${BAND_MINIMUMS.developing}%`;
    case 'critical':
      return `under ${BAND_MINIMUMS.needsWork}%`;
    default:
      return null;
  }
}

/**
 * Whether a report's numbers may carry a verdict at all.
 *
 * A report computed under superseded weights holds numbers this vocabulary was
 * not written for. Showing a band for them would relabel a superseded score --
 * the move the report-shape-migration spec's D2 already forbids for the score
 * itself. Withheld, never relabelled, and that covers the band COLOUR as well
 * as the word: a green dot beside a superseded number asserts what "Strong"
 * asserts.
 */
export function labelIsShowable(scoringVersion: string | undefined): boolean {
  return scoringVersion !== undefined && KNOWN_BAND_VERSIONS.has(scoringVersion);
}
