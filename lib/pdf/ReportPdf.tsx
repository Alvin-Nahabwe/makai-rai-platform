import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer';
import type { ReportData } from '@/types/domain';
import { formatProvenanceLine, driftBannerText } from '@/lib/report/provenance';

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
  areaRow: { flexDirection: 'row', padding: 6, borderBottom: '1 solid #eee' },
  areaName: { width: '50%' },
  areaScore: { width: '25%', textAlign: 'center' },
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
  const { overallScore, completedStages, principleScores } = reportData;

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
          are `overallScore`, `completedStages` and `principleScores`, and
          it imports no framework content whatsoever (no `questionBank`, no
          `assessmentAreas`). Nothing on this page is recomputed at render
          time, so the unqualified "nothing is recalculated" claim is true
          here. `ReportSummary` passes 'live-findings' for the opposite
          reason; see `lib/report/provenance.ts#DriftBannerScope`.
        */}
        {frameworkDrifted && (
          <View style={styles.driftBanner}>
            <Text>{driftBannerText('cached-only')}</Text>
          </View>
        )}

        <View style={styles.scoreBox}>
          <View style={styles.scoreItem}>
            <Text style={styles.scoreValue}>{Math.round(overallScore)}%</Text>
            <Text style={styles.scoreLabel}>Overall Score</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={styles.scoreValue}>{completedStages.length}/3</Text>
            <Text style={styles.scoreLabel}>Stages Assessed</Text>
          </View>
          <View style={styles.scoreItem}>
            <Text style={styles.scoreValue}>
              {overallScore >= 75 ? 'Strong' : overallScore >= 50 ? 'Developing' : overallScore >= 25 ? 'Needs Work' : 'Critical'}
            </Text>
            <Text style={styles.scoreLabel}>Maturity Level</Text>
          </View>
        </View>

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
                    <Text style={styles.areaScore}>{Math.round(score as number)}%</Text>
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
