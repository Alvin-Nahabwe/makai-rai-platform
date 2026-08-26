import { levelColors } from '@/data/constants';

/**
 * The colour a maturity reading should render in, given whether its band
 * verdict may be shown at all and which band it would be. Both facts are
 * computed by the CALLER -- this function only combines two already-derived
 * values, it never re-derives either one:
 *
 * - `labelShowable`: `lib/report/maturityBands.ts#labelIsShowable`, applied
 *   to the report/row's `scoringVersion`.
 * - `level`: `lib/report/maturityBands.ts#getLevel`, applied to the raw
 *   percentage.
 *
 * maturity-band-reanchor Task 7, fix round 1. Coordinator finding 3: the
 * report page's lifecycle-header colour and both project list/detail pages
 * performed this IDENTICAL two-input decision as three separately-typed
 * inline ternaries, none of them independently testable without jsdom
 * (report/page.tsx is hook-heavy; the project pages are async server
 * components with a live Prisma query). Extracting the decision into one
 * pure, directly-callable function does two things at once: it is now
 * testable the same way `legendRangeSuffix`/`getLevel`/`computeFindingsData`
 * already are in this codebase (call it, assert the return value -- no
 * render pass needed), and it removes the THIRD near-duplicate copy of a
 * fact that only ever needs deriving once -- the exact shape D-219's three
 * contradicting band ladders took, one level up (a colour DECISION repeated,
 * not a THRESHOLD repeated).
 *
 * Deliberately NOT placed in `maturityBands.ts`, which imports nothing and
 * exports no colours by design (that module's own header comment) -- this
 * function imports `levelColors`, so it lives beside it in `lib/report/`
 * instead, mirroring `provenance.ts`'s sibling role.
 *
 * Not used by `lib/pdf/ReportPdf.tsx`: `@react-pdf/renderer` has no CSS
 * cascade, so its own withheld colour is a literal hex constant
 * (`VERDICT_WITHHELD_COLOR`), not `var(--color-verdict-withheld)` -- see
 * that file's own comment for why. Not used by `GapHeatmap.tsx` either: its
 * cells need a background/foreground PAIR (`LEVEL_STYLES`), a different
 * colour mechanism this function does not produce.
 */
export function verdictColor(labelShowable: boolean, level: string): string {
  return labelShowable ? levelColors[level] : 'var(--color-verdict-withheld)';
}
