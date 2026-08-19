import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { ReportData, PracticeCoverage } from '@/types/domain';
import { formatProvenanceLine, driftBannerText, provisionalScoreNote, formatScoringLine } from '@/lib/report/provenance';
import { levelColors, levelLabels } from '@/data/constants';

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: 'Helvetica', fontSize: 10 },
  header: { marginBottom: 20, borderBottom: '2 solid #C06014', paddingBottom: 10 },
  title: { fontSize: 20, fontFamily: 'Helvetica-Bold', color: '#1a1a2e' },
  subtitle: { fontSize: 12, color: '#666', marginTop: 4 },
  provenance: { fontSize: 9, color: '#666', marginTop: 6 },
  driftBanner: {
    backgroundColor: '#FEE2E2',
    color: '#B91C1C',
    padding: 8,
    borderRadius: 4,
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 12,
  },
  section: { marginTop: 16, marginBottom: 8 },
  sectionTitle: { fontSize: 14, fontFamily: 'Helvetica-Bold', marginBottom: 8, color: '#C06014' },
  scoreBox: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 },
  scoreItem: { padding: 8, backgroundColor: '#f5f5f5', borderRadius: 4, width: '30%', textAlign: 'center' },
  scoreValue: { fontSize: 24, fontFamily: 'Helvetica-Bold' },
  scoreLabel: { fontSize: 8, color: '#666' },
  provisionalNote: { fontSize: 8, color: '#666', fontStyle: 'italic', marginTop: 6, marginBottom: 4, lineHeight: 1.4 },
  /**
   * Task 7: `areaRow` now carries THREE columns (name/id, maturity,
   * practices), not two -- widths adjusted from the pre-Task-7 50%/25%
   * split accordingly. Shared by both the "Principle Scores" and "Area
   * Scores" sections below, which render the identical two-reading layout.
   */
  areaRow: { flexDirection: 'row', padding: 6, borderBottom: '1 solid #eee' },
  areaName: { width: '35%' },
  areaScore: { width: '25%', textAlign: 'center' },
  areaPractices: { width: '40%', fontSize: 9 },
  /**
   * Task 7: matches `.gap-card__reading-value--muted` /
   * `.scorecard-card__pct--muted` (components/report/ReportPage.css) --
   * italic, muted grey -- for the null-reading branches ("No maturity
   * questions" / "No practices assessed"). Never applied to a real value.
   */
  muted: { fontStyle: 'italic', color: '#666' },
  /**
   * Task 7: the second independent reading beside the overall score box --
   * mirrors `.report-summary__practices` (ReportSummary.tsx). No
   * percentage, no level colour: a coverage count carries no band, same
   * rule as the area/principle readings below.
   */
  overallPracticesBlock: { padding: 8, backgroundColor: '#f5f5f5', borderRadius: 4, marginBottom: 12 },
  overallPracticesLabel: { fontSize: 8, color: '#666', marginBottom: 2 },
  overallPracticesValue: { fontSize: 12, fontFamily: 'Helvetica-Bold' },
  /**
   * A DELIBERATELY SEPARATE style from `[overallPracticesValue, muted]`,
   * not that combination -- @react-pdf/renderer resolves fonts against the
   * base-14 PDF set, which has no bold-italic variant registered for
   * "Helvetica-Bold" the way "Helvetica" (this page's default) resolves an
   * italic request to "Helvetica-Oblique". Combining `overallPracticesValue`
   * (`fontFamily: 'Helvetica-Bold'`) with `muted` (`fontStyle: 'italic'`)
   * throws `Could not resolve font for Helvetica-Bold, fontWeight 400,
   * fontStyle italic` at render time -- caught only by an actual
   * `renderToBuffer` pass (`__tests__/integration/report-provenance.test.ts`),
   * never by `extractText`, which walks props and never invokes the real
   * font-resolution/layout pipeline at all.
   */
  overallPracticesValueMuted: { fontSize: 12, fontStyle: 'italic', color: '#666' },
  manifestRow: { flexDirection: 'row', padding: 6, borderBottom: '1 solid #eee' },
  manifestFilename: { width: '34%', fontSize: 9 },
  manifestHash: { width: '34%', fontSize: 7, fontFamily: 'Courier' },
  manifestUploader: { width: '18%', fontSize: 9 },
  manifestDate: { width: '14%', fontSize: 9, textAlign: 'right' },
  footer: { position: 'absolute', bottom: 30, left: 40, right: 40, fontSize: 8, color: '#999', textAlign: 'center' },
});

/**
 * O-16's manifest row shape: filename, SHA-256, uploader, date -- and
 * EXPLICITLY NOTHING ELSE (design doc section 4.3: "An evidence manifest ... and
 * NOT the bytes"). There is no `content`/bytes field in this type by
 * construction; `toEvidenceManifest` below (the PDF route's job to call,
 * per its own module doc) builds this from `listEvidenceForAssessment`'s
 * metadata-only query, which structurally cannot return blob bytes since
 * it never `include`s the `evidenceBlob` relation.
 */
export interface EvidenceManifestRow {
  filename: string;
  sha256: string;
  uploaderName: string;
  /** 'YYYY-MM-DD', formatted by the caller from `evidence.uploadedAt`. */
  uploadedAt: string;
}

/** Generous for any real filename; short enough to keep a manifest row
 * legible and bounded. See this function's doc comment for why it exists. */
const MAX_MANIFEST_TEXT_LENGTH = 120;

/**
 * Fresh C1 finding for this task (not previously flagged by Task 6/7):
 * `Evidence.filename` has no length bound anywhere in the write path
 * (`prisma/schema.prisma`'s `filename String` is unbounded `text`; the
 * upload route never slices `file.name`), and Task 7's own O-8 proof
 * (`__tests__/integration/evidence-download.test.ts`) already established a
 * stored filename CAN contain literal CR/LF. This is the first surface
 * that renders `filename` (and, via the same uploader-name lookup every
 * OTHER name on this PDF already goes through, `User.name`) into a
 * react-pdf `<Text>`, and `@react-pdf/textkit` treats an embedded `"\n"` as
 * an explicit line break (`node_modules/@react-pdf/textkit/lib/textkit.js:1397`,
 * confirmed by reading the source). An adversarial filename could otherwise
 * make a single manifest row span an unbounded number of visual lines --
 * working against the exact "the PDF stays bounded" property O-16 exists to
 * prove, even though it is not the bytes-embedding O-16 itself names. NOT a
 * content-stream-injection concern -- see this file's own module doc
 * comment for why `<Text>` content cannot be used that way at all.
 *
 * Scoped to rendering (this task's own surface), not the upload path (Task
 * 6/7's already-shipped, already-reviewed territory).
 */
export function sanitizeManifestText(value: string): string {
  // Deliberately matching C0 controls (\n, \r, \t, ...) and DEL; see the
  // doc comment above.
  const flattened = value.replace(/[\x00-\x1F\x7F]/g, ' ');
  return flattened.length > MAX_MANIFEST_TEXT_LENGTH
    ? `${flattened.slice(0, MAX_MANIFEST_TEXT_LENGTH)}\u2026`
    : flattened;
}

/**
 * Task 7 (practices/maturity split, PDF half). Derives the same maturity
 * band `components/report/useFindingsData.ts#getLevel` derives (identical
 * thresholds, identical keys -- 'strong' | 'developing' | 'needsWork' |
 * 'critical' | 'notAssessed' -- matching `data/constants.ts`'s
 * `levelColors`/`levelLabels`), reimplemented here rather than imported.
 * `useFindingsData.ts` is a `'use client'` module that, at its own top,
 * statically imports the assessment-areas content file and the scoring
 * engine's JS module -- importing `getLevel` from it would transitively
 * pull BOTH into this file's module graph, directly contradicting this
 * component's own "cached-only" doc comment below ("imports no framework
 * content whatsoever"), which the drift-banner scope
 * (`driftBannerText('cached-only')`) depends on staying true, and which
 * `__tests__/integration/trigger-enumeration.test.ts` enforces mechanically
 * by grepping this file's own source for those exact module names -- this
 * comment deliberately does not spell them out either, for the same
 * reason. A four-line pure function duplicated once is a smaller
 * liability than that import.
 */
function getLevel(maturity: number | null): string {
  if (maturity === null) return 'notAssessed';
  if (maturity >= 75) return 'strong';
  if (maturity >= 50) return 'developing';
  if (maturity >= 25) return 'needsWork';
  return 'critical';
}

/**
 * Task 7. The maturity half of the two-reading treatment
 * `AreaCard.tsx`/`PrincipleScorecard.tsx` establish: a percentage with its
 * level colour, or "No maturity questions" (muted, never "0%") when the
 * reading is absent. Called directly as a plain function -- `{renderMaturity(x)}`,
 * never `<RenderMaturity .../>` -- because this file's tests
 * (`__tests__/unit/report-provenance.test.tsx`) call `ReportPdf(...)`
 * directly and walk the result with `extractText`, which recurses only
 * into `.props.children` and never invokes a component function (D-169).
 * A JSX-tag sub-component with no `children` prop of its own would render
 * as an empty leaf to that walker regardless of what it would have
 * produced \u2014 see `components/report/AreaCard.tsx`'s `<FindingItems/>` /
 * `<ControlsList/>` for the same reason those are never asserted on
 * through `AreaCard`'s own tests. Returning JSX from an eagerly-called
 * plain function, as `evidenceManifest.map(...)`'s callback below already
 * does, has no such gap: the returned element is already expanded before
 * extractText ever sees it.
 */
function renderMaturity(maturity: number | null) {
  if (maturity === null) {
    return <Text style={[styles.areaScore, styles.muted]}>No maturity questions</Text>;
  }
  return (
    <Text style={[styles.areaScore, { color: levelColors[getLevel(maturity)] }]}>
      {maturity}%
    </Text>
  );
}

/**
 * Task 7. The practices half -- a plain coverage COUNT, deliberately never
 * a percentage and never coloured by level (a coverage count carries no
 * band, the same rule `AreaCard`/`PrincipleScorecard`/`ReportSummary`
 * already apply). "No practices assessed" for an absent reading, never
 * "0 of 0 practices in place". Same calling convention as `renderMaturity`
 * above, for the same reason.
 */
function renderPractices(practices: PracticeCoverage | null) {
  if (practices === null) {
    return <Text style={[styles.areaPractices, styles.muted]}>No practices assessed</Text>;
  }
  return (
    <Text style={styles.areaPractices}>
      {`${practices.inPlace} of ${practices.total} practices in place`}
    </Text>
  );
}

interface ReportPdfProps {
  reportData: ReportData;
  projectName: string;
  assessorName: string;
  assessmentDate: string;
  /** O-15: see `components/report/ReportSummary.tsx`'s identical prop doc
   * comments -- both surfaces take the same raw pin data and format it
   * through the same `formatProvenanceLine`, so the copy cannot drift. */
  frameworkSemver: string;
  frameworkPinnedDate: string;
  frameworkContentHash: string;
  /** O-14, completed half: computed by the caller via
   * `isFrameworkDrifted(assessment.status, resolution.matches)` -- this
   * component has neither piece of information on its own. */
  frameworkDrifted: boolean;
  /** O-16: metadata only, never the bytes -- see `EvidenceManifestRow`. */
  evidenceManifest: EvidenceManifestRow[];
}

/**
 * The auditor-facing PDF export. `<Text>` content in this component is
 * NEVER at risk of PDF content-stream injection from user-supplied data
 * (evidence filenames, uploader names): @react-pdf/renderer's actual text
 * path (`@react-pdf/render`'s `_renderGlyphs`, which pdfkit's font/glyph
 * layer feeds) shapes every character into a glyph ID and writes it as a
 * PDF HEX STRING (`<48656c6c6f>`) inside a `TJ` operator -- never as a
 * literal parenthesized PDF string. A hex string admits only `[0-9a-f]` by
 * construction, so there is no PDF syntax for injected characters (`(`,
 * `)`, `\`, control bytes) to break out through, regardless of what the
 * source string contains. Confirmed by reading
 * `node_modules/@react-pdf/render/lib/index.js` (`_renderGlyphs`,
 * `renderGlyphs`) and `node_modules/@react-pdf/pdfkit/lib/pdfkit.js`
 * (`encode`/`glyphsForString`), not assumed from React's own (unrelated)
 * escaping behaviour. (`@react-pdf/pdfkit` separately has a
 * literal-string-escaping path, `PDFObject.convert`, used for PDF metadata
 * dictionary values such as `Document`'s `title`/`author` -- this component
 * never passes user-supplied data through that path, since it sets no such
 * metadata at all.) `sanitizeManifestText` above exists for a DIFFERENT
 * reason -- layout boundedness, not injection -- see its own doc comment.
 */
export function ReportPdf({
  reportData,
  projectName,
  assessorName,
  assessmentDate,
  frameworkSemver,
  frameworkPinnedDate,
  frameworkContentHash,
  frameworkDrifted,
  evidenceManifest,
}: ReportPdfProps) {
  /**
   * Task 7 fresh finding, surfaced (not created) by this task's own change.
   * `lib/data/assessments.ts#completeAssessment`'s 'quick' mode branch
   * writes a reportData shape that is NOT a `ReportData` at all --
   * `{ mode: 'quick', overallScore, completedStages: [], generatedAt }`,
   * with no `overallPractices`, `stageScores` or `principleScores` key at
   * all -- through an unchecked `as unknown as Prisma.InputJsonValue` cast
   * that tsc never validates against the real type. `completedStages: []`
   * happened to make this harmless before Task 7: every access this
   * component made to `principleScores` lived inside a
   * `completedStages.map(...)` callback, which a quick-mode assessment's
   * empty array never invokes. Task 7's overall-practices reading has no
   * such gate -- it renders unconditionally -- so it is the first access in
   * this file a quick-mode report's genuinely ABSENT (`undefined`, not the
   * real, valid `null` the type declares) field can reach. Defaulted at the
   * destructure, not with a stricter `!== null` check at each use site: an
   * absent field and a real `null` mean the exact same thing to a reader
   * ("no practice-coverage data exists for this report"), so they render
   * through the identical "No practices assessed" branch rather than one
   * of them crashing. Not a `lib/data/assessments.ts` fix -- that file is
   * outside this task's scope and its own bug, not this component's; this
   * is `ReportPdf` refusing to trust a boundary the type system cannot
   * actually enforce, the same posture `formatScoringLine`'s
   * `string | undefined` parameter already takes for the identical class
   * of "real stored data can predate a field" gap.
   */
  const {
    overallScore,
    overallPractices = null,
    completedStages,
    stageScores = {},
    principleScores = {},
  } = reportData;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Responsible AI Readiness Report</Text>
          <Text style={styles.subtitle}>{projectName} {'\u00B7'} {assessorName} {'\u00B7'} {assessmentDate}</Text>
          <Text style={styles.provenance}>
            {formatProvenanceLine({ semver: frameworkSemver, pinnedDate: frameworkPinnedDate, contentHash: frameworkContentHash })}
          </Text>
        </View>

        {/*
          C6 F3: 'cached-only' is a claim about THIS component, checkable
          two lines up -- the only fields it destructures off `reportData`
          are `overallScore`, `overallPractices`, `completedStages`,
          `stageScores` and `principleScores` (Task 7 added the middle two
          to this list; all five are still read straight off the cached
          `reportData` object, nothing new), and it imports no framework
          content whatsoever (no `questionBank`, no `assessmentAreas` --
          see `getLevel`'s own doc comment above for why that stayed true
          even after Task 7 needed a maturity-band function). Nothing on
          this page is recomputed at render time, so the unqualified
          "nothing is recalculated" claim is true here. `ReportSummary`
          passes 'live-findings' for the opposite reason; see
          `lib/report/provenance.ts#DriftBannerScope`.
        */}
        {frameworkDrifted && (
          <View style={styles.driftBanner}>
            <Text>{driftBannerText('cached-only')}</Text>
          </View>
        )}

        <View style={styles.scoreBox}>
          {/*
            Task 7: "Overall Score" -> "Assessed maturity" -- lowercase
            'm', byte-identical to `AreaCard.tsx`/`PrincipleScorecard.tsx`'s
            reading-label string (the brief's binding rule: strings must be
            IDENTICAL, not merely similarly worded). `overallScore`
            stopped being the report's one combined figure the moment
            `overallPractices` became a second, independent reading (Task
            3) -- exactly the reasoning `lib/report/provenance.ts#maturityRingAriaLabel`
            gives for the HTML ring's identical rename. The HTML surface
            disambiguates via an `aria-label` a sighted reader never sees
            printed; a PDF has no aria tree at all (see this file's own
            `driftBannerText` scope comment above), so the visible label
            is the ONLY place this document can say which reading the
            percentage is. Value coloured by level, mirroring
            `AreaCard`/`PrincipleScorecard`'s reading-value treatment.
          */}
          <View style={styles.scoreItem}>
            <Text style={[styles.scoreValue, { color: levelColors[getLevel(overallScore)] }]}>
              {Math.round(overallScore)}%
            </Text>
            <Text style={styles.scoreLabel}>Assessed maturity</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={styles.scoreValue}>{completedStages.length}/3</Text>
            <Text style={styles.scoreLabel}>Stages Assessed</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={styles.scoreValue}>{levelLabels[getLevel(overallScore)]}</Text>
            <Text style={styles.scoreLabel}>Maturity Level</Text>
          </View>
        </View>

        {/*
          Task 7: the second independent reading, stated as a count beside
          the maturity box above -- mirrors `.report-summary__practices`
          (`components/report/ReportSummary.tsx`). Same two strings that
          component renders for the identical concept, verbatim: "{n} of
          {m} practices in place" / "No practices assessed". No
          percentage, no level colour -- a coverage count carries no band.
        */}
        <View style={styles.overallPracticesBlock}>
          <Text style={styles.overallPracticesLabel}>Practices</Text>
          {overallPractices !== null ? (
            <Text style={styles.overallPracticesValue}>
              {`${overallPractices.inPlace} of ${overallPractices.total} practices in place`}
            </Text>
          ) : (
            <Text style={styles.overallPracticesValueMuted}>No practices assessed</Text>
          )}
        </View>

        <Text style={styles.provisionalNote}>{provisionalScoreNote()}</Text>
        <Text style={styles.provisionalNote}>{formatScoringLine(reportData.scoringVersion)}</Text>

        {/*
          Task 7: each principle's two readings, mirroring
          `PrincipleScorecard.tsx` -- maturity as a coloured percentage (or
          "No maturity questions" when absent), practices as a separate,
          uncoloured count (or "No practices assessed"). Previously
          `Math.round(score as number)}%`, an unsafe cast that treated the
          whole `EvidenceScore` object as a number (the pre-existing
          `lib/pdf/ReportPdf.tsx(201,64)` tsc error this task owns fixing --
          see task-7-report.md).
        */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Principle Scores</Text>
          {completedStages.map((stage: string) => {
            const scores = principleScores[stage] || {};
            return (
              <View key={stage} style={{ marginBottom: 8 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
                  {stage.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                </Text>
                {Object.entries(scores).map(([principle, score]) => (
                  <View key={principle} style={styles.areaRow}>
                    <Text style={styles.areaName}>{principle}</Text>
                    {renderMaturity(score.maturity)}
                    {renderPractices(score.practices)}
                  </View>
                ))}
              </View>
            );
          })}
        </View>

        {/*
          Task 7. `stageScores` (Task 3's per-AREA readings, keyed by area
          ID) was destructured off `reportData` but never rendered anywhere
          in this document before this task -- see the judgement-call
          section of task-7-report.md for why an area section belongs
          here at all (the brief's Step 1 fixture explicitly names "an
          area lacking coverage") and why it is labelled by area ID rather
          than by the area's human-readable name/description: those live in
          the assessment-areas content file, which this component's
          'cached-only' design (the comment above `driftBannerText` call)
          deliberately never imports -- an area's NAME can change across
          framework versions, but its cached `EvidenceScore` is exactly
          what this assessment was scored against, so labelling by the
          stable ID keeps every value on this page provably from the one
          cached record. The per-practice ITEM list `AreaCard.tsx` shows
          when expanded is deliberately NOT reproduced here -- also
          explained in that section: it is not merely a design choice, the
          cached `reportData` this document's whole architecture is
          restricted to literally does not carry itemised practice data,
          only the aggregate `PracticeCoverage` count.
        */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Area Scores</Text>
          {completedStages.map((stage: string) => {
            const areas = stageScores[stage] || {};
            return (
              <View key={stage} style={{ marginBottom: 8 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', marginBottom: 4 }}>
                  {stage.replace(/-/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase())}
                </Text>
                {Object.entries(areas).map(([areaId, score]) => (
                  <View key={areaId} style={styles.areaRow}>
                    <Text style={styles.areaName}>{areaId}</Text>
                    {renderMaturity(score.maturity)}
                    {renderPractices(score.practices)}
                  </View>
                ))}
              </View>
            );
          })}
        </View>

        {evidenceManifest.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Evidence</Text>
            <View style={styles.manifestRow}>
              <Text style={[styles.manifestFilename, { fontFamily: 'Helvetica-Bold' }]}>Filename</Text>
              <Text style={[styles.manifestHash, { fontFamily: 'Helvetica-Bold' }]}>SHA-256</Text>
              <Text style={[styles.manifestUploader, { fontFamily: 'Helvetica-Bold' }]}>Uploaded by</Text>
              <Text style={[styles.manifestDate, { fontFamily: 'Helvetica-Bold' }]}>Date</Text>
            </View>
            {/*
              O-16: metadata only, per row -- filename, sha256, uploader,
              date -- and NOTHING else read off `row`. This is the guard the
              test suite's "no-bytes proof" (report-provenance.test.tsx)
              pins: a `row` that also happened to carry a `content` field
              (e.g. from a future, careless `include: { blob: true }` on the
              query that built `evidenceManifest`) would still never reach
              this document, because nothing below ever reads any key but
              these four. Never `{...row}`.
            */}
            {evidenceManifest.map((row, idx) => (
              <View key={`${row.sha256}-${idx}`} style={styles.manifestRow}>
                <Text style={styles.manifestFilename}>{sanitizeManifestText(row.filename)}</Text>
                <Text style={styles.manifestHash}>{row.sha256}</Text>
                <Text style={styles.manifestUploader}>{sanitizeManifestText(row.uploaderName)}</Text>
                <Text style={styles.manifestDate}>{row.uploadedAt}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.footer}>Generated by MAK-AI Responsible AI Toolkit {'\u00B7'} {assessmentDate}</Text>
      </Page>
    </Document>
  );
}
