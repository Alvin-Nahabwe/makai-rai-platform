import { describe, it, expect } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { formatProvenanceLine, isFrameworkDrifted, driftBannerText } from '@/lib/report/provenance';
import { ReportSummary } from '@/components/report/ReportSummary';
import { ReportPdf, sanitizeManifestText, type EvidenceManifestRow } from '@/lib/pdf/ReportPdf';
import { toEvidenceManifest } from '@/app/api/v1/orgs/[slug]/reports/[id]/pdf/route';
import type { ReportData } from '@/types/domain';

/**
 * Plan 1c Task 9 (O-14 completed half, O-15, O-16). `ReportSummary` and
 * `ReportPdf` are both plain function components with no hooks (confirmed
 * by reading both files before writing this test) -- calling them directly
 * as functions, the way `__tests__/unit/evidence-inspect.test.ts` and
 * `evidence-data.test.ts` call pure functions directly, returns the
 * unrendered React element tree (JSX compiles to plain `{type, props}`
 * object construction; nothing about it requires a DOM or a reconciler).
 * `vitest.config.ts` runs this suite under `environment: 'node'` -- no
 * jsdom, no `@testing-library/react`, no `react-test-renderer` is
 * installed (checked package.json) -- so walking `.props.children`
 * ourselves is not a workaround, it is the only technique available, and it
 * is renderer-agnostic: it works identically for ReportSummary's `<div>`
 * tree and ReportPdf's `<Document>` tree (built on @react-pdf/renderer's
 * own Document/Page/View/Text components) because it never inspects
 * `.type`, only `.props.children`.
 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const children = (node as ReactElement<{ children?: ReactNode }>).props?.children;
    return extractText(children ?? null);
  }
  return '';
}

const PROVENANCE = {
  semver: '3.0.0',
  pinnedDate: '2026-08-06',
  contentHash: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
};

describe('formatProvenanceLine (O-15)', () => {
  it('renders the exact copy the design doc specifies (§4.2)', () => {
    expect(formatProvenanceLine(PROVENANCE)).toBe(
      'Assessed against MAK-AI RAI Framework 3.0.0, pinned 2026-08-06 · content a1b2c3d4…',
    );
  });

  it('truncates the content hash to its first 8 characters regardless of full length', () => {
    const line = formatProvenanceLine({ ...PROVENANCE, contentHash: 'deadbeef'.repeat(8) });
    expect(line).toContain('content deadbeef…');
    expect(line).not.toContain('deadbeefdeadbeef');
  });
});

/**
 * Fix round 2, Critical: this copy previously asserted "it has not been
 * recomputed against the newer content" -- true only for an assessment
 * whose completion was itself gated on drift, which is not knowable from
 * stored data alone for an assessment completed before that gate existed
 * (`lib/data/assessments.ts#completeAssessment` gained it this round).
 * Pinned here as its own exact-copy test, the same way `formatProvenanceLine`
 * is pinned above -- both surfaces call this ONE function
 * (`ReportSummary.tsx`, `ReportPdf.tsx`) rather than each carrying their own
 * copy, precisely because two independently-typed copies of "the same"
 * sentence had ALREADY drifted from each other (one used an em dash, the
 * other a colon) by the time this was noticed.
 */
describe('driftBannerText (O-14, completed half)', () => {
  it('does not claim the underlying computation was against matching content -- only that it is not recalculated on viewing', () => {
    const text = driftBannerText();
    expect(text).toContain('differs from the pinned version');
    expect(text).toContain("state as recorded at completion");
    expect(text).toContain('not recalculated when viewed');
    // The specific claim fix round 2 found false for pre-guard data:
    expect(text).not.toMatch(/not been recomputed/i);
  });
});

describe('isFrameworkDrifted (O-14, completed half)', () => {
  // Exhaustive 2x2 truth table over {status} x {matches} -- non-vacuous by
  // construction: an implementation that used ONLY `matches` (ignoring
  // status) fails the second case below; one that used ONLY `status`
  // (ignoring matches) fails the third case; one with the AND backwards
  // fails the fourth. No single case can pass all four by accident.
  it('is false for an in-progress assessment whose content still matches', () => {
    expect(isFrameworkDrifted('in_progress', true)).toBe(false);
  });

  it('is false for an in-progress, MISMATCHED assessment -- Task 6 already blocks further input at the API; the report surface has no cached report to annotate yet', () => {
    expect(isFrameworkDrifted('in_progress', false)).toBe(false);
  });

  it('is false for a completed assessment whose content still matches', () => {
    expect(isFrameworkDrifted('completed', true)).toBe(false);
  });

  it('is true only for a completed, mismatched assessment', () => {
    expect(isFrameworkDrifted('completed', false)).toBe(true);
  });
});

const BASE_SUMMARY_PROPS = {
  overallScore: 62,
  overallLevel: 'developing',
  completedStagesCount: 2,
  strengthsCount: 3,
  attentionsCount: 1,
  gapsCount: 2,
  activeModifiersCount: 0,
  levelLabels: { developing: 'Developing' },
  levelColors: { developing: '#f59e0b' },
  frameworkSemver: PROVENANCE.semver,
  frameworkPinnedDate: PROVENANCE.pinnedDate,
  frameworkContentHash: PROVENANCE.contentHash,
  frameworkDrifted: false,
};

describe('ReportSummary -- provenance line and drift banner (O-15 HTML half, O-14 completed half)', () => {
  it('renders the provenance line with the real semver, pinned date and short hash', () => {
    const text = extractText(ReportSummary(BASE_SUMMARY_PROPS));
    expect(text).toContain(formatProvenanceLine(PROVENANCE));
  });

  it('shows no drift banner when the deployed content has not drifted', () => {
    const text = extractText(ReportSummary({ ...BASE_SUMMARY_PROPS, frameworkDrifted: false }));
    expect(text).not.toMatch(/differs from the pinned version/i);
  });

  it('shows the drift banner, matching driftBannerText() exactly -- one source of copy, not a paraphrase', () => {
    const text = extractText(ReportSummary({ ...BASE_SUMMARY_PROPS, frameworkDrifted: true }));
    expect(text).toContain(driftBannerText());
  });
});

const REPORT_DATA: ReportData = {
  version: '3.0.0',
  generatedAt: '2026-08-06T12:00:00.000Z',
  completedStages: ['pre-processing'],
  overallScore: 62,
  stageScores: { 'pre-processing': { Fairness: 62 } },
  principleScores: { 'pre-processing': { Fairness: 62 } },
  activeModifiers: [],
  unlockedConditionals: [],
};

const MANIFEST: EvidenceManifestRow[] = [
  { filename: 'bias-audit.pdf', sha256: 'a'.repeat(64), uploaderName: 'Jordan Lee', uploadedAt: '2026-08-05' },
  { filename: 'dpia.docx', sha256: 'b'.repeat(64), uploaderName: 'Unknown', uploadedAt: '2026-08-06' },
];

const BASE_PDF_PROPS = {
  reportData: REPORT_DATA,
  projectName: 'Probe Project',
  assessorName: 'Alex Assessor',
  assessmentDate: '2026-08-06',
  frameworkSemver: PROVENANCE.semver,
  frameworkPinnedDate: PROVENANCE.pinnedDate,
  frameworkContentHash: PROVENANCE.contentHash,
  frameworkDrifted: false,
  evidenceManifest: MANIFEST,
};

describe('ReportPdf -- provenance line (O-15 PDF half)', () => {
  it('renders the identical provenance line the HTML surface renders -- one formatter, not two', () => {
    const text = extractText(ReportPdf(BASE_PDF_PROPS));
    expect(text).toContain(formatProvenanceLine(PROVENANCE));
  });
});

describe('ReportPdf -- drift banner (O-14 completed half, PDF)', () => {
  it('shows no banner when the deployed content has not drifted', () => {
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, frameworkDrifted: false }));
    expect(text).not.toMatch(/differs from the pinned version/i);
  });

  it('shows the banner, matching driftBannerText() exactly -- the SAME function ReportSummary uses, not a second copy', () => {
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, frameworkDrifted: true }));
    expect(text).toContain(driftBannerText());
  });
});

describe('ReportPdf -- evidence manifest (O-16)', () => {
  it('renders one manifest row per evidence item, carrying filename, sha256, uploader and date', () => {
    const text = extractText(ReportPdf(BASE_PDF_PROPS));
    for (const row of MANIFEST) {
      expect(text).toContain(row.filename);
      expect(text).toContain(row.sha256);
      expect(text).toContain(row.uploaderName);
      expect(text).toContain(row.uploadedAt);
    }
  });

  it('renders no manifest row content when there is no evidence', () => {
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, evidenceManifest: [] }));
    expect(text).not.toContain('bias-audit.pdf');
    expect(text).not.toContain('dpia.docx');
  });

  /**
   * Non-vacuity proof for O-16's "not the bytes" half. `EvidenceManifestRow`
   * is typed as exactly {filename, sha256, uploaderName, uploadedAt} -- no
   * `content` field exists in the type ReportPdf declares it accepts. But a
   * TYPE is not a runtime guarantee: a variable typed as a WIDER shape
   * (here, one that also carries `content`) is structurally assignable to
   * the narrower `EvidenceManifestRow[]` parameter without a cast, so if a
   * future change to the PDF route ever fetched evidence WITH its blob
   * (e.g. an accidental `include: { blob: true }`) and passed the row
   * straight through, TypeScript would not catch it. This fixture
   * reproduces exactly that shape and proves the COMPONENT -- not the type
   * checker -- is what keeps the bytes out: it would PASS if
   * ReportPdf's manifest rendering spread `{...row}` or otherwise read
   * `row.content` instead of naming the four fields explicitly. See
   * task-9-report.md for the red (guard temporarily removed) / green
   * (guard restored) proof.
   */
  it('never renders a `content` field even when a manifest row carries one (O-16 no-bytes proof)', () => {
    const leaked = MANIFEST.map((row) => ({ ...row, content: 'RAW_BYTES_MARKER_never_render_me' }));
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, evidenceManifest: leaked }));
    expect(text).not.toContain('RAW_BYTES_MARKER_never_render_me');
  });
});

describe('sanitizeManifestText -- fresh C1 finding: Evidence.filename/User.name have no length bound anywhere in the write path', () => {
  it('passes a short, ordinary filename through unchanged', () => {
    expect(sanitizeManifestText('bias-audit.pdf')).toBe('bias-audit.pdf');
  });

  it('truncates a filename far longer than any real upload needs, with a visible truncation marker', () => {
    const long = 'a'.repeat(500);
    const result = sanitizeManifestText(long);
    expect(result.length).toBeLessThan(150);
    expect(result.endsWith('…')).toBe(true);
  });

  it('replaces embedded control characters (CR/LF/tab) so one row cannot force @react-pdf/textkit to break across many lines', () => {
    // @react-pdf/textkit treats an embedded "\n" as an explicit line break
    // (node_modules/@react-pdf/textkit/lib/textkit.js:1397, confirmed by
    // reading the source, not assumed) -- and Task 7's own O-8 proof
    // (evidence-download.test.ts) already established a stored
    // Evidence.filename CAN contain literal CR/LF.
    const hostile = 'evil\r\n\r\n\r\n\r\n\r\nfilename.pdf';
    const result = sanitizeManifestText(hostile);
    expect(result).not.toContain('\n');
    expect(result).not.toContain('\r');
  });

  /**
   * Proves the sanitizer is actually WIRED into ReportPdf's manifest
   * rendering, not just correct in isolation -- a pure-function test above
   * could pass while the component itself renders `row.filename` raw next
   * to it (two mechanisms for one fact, AGENTS.md §3). Non-vacuous the same
   * way: see task-9-report.md for the red/green proof of removing the call
   * site.
   */
  it('is applied to manifest filenames actually rendered by ReportPdf, not only available as a standalone function', () => {
    const long = 'x'.repeat(500) + '.pdf';
    const text = extractText(
      ReportPdf({
        ...BASE_PDF_PROPS,
        evidenceManifest: [{ filename: long, sha256: 'c'.repeat(64), uploaderName: 'Sam', uploadedAt: '2026-08-06' }],
      }),
    );
    expect(text).not.toContain(long);
    expect(text).toContain(sanitizeManifestText(long));
  });
});

/**
 * `toEvidenceManifest` is the PDF route's DB-row -> EvidenceManifestRow
 * shaping step, extracted into its own exported function (fix during this
 * task, see task-9-report.md) specifically so this claim is testable at
 * all: @react-pdf/renderer's real rendered output writes `<Text>` content
 * as hex-encoded glyph-ID show operators (confirmed by reading
 * node_modules/@react-pdf/render/lib/index.js's `_renderGlyphs`, and by a
 * live `renderToBuffer` probe for this task), so a filename NEVER appears
 * as literal text in a rendered PDF's content stream -- an integration test
 * that greps decompressed PDF bytes for a real filename cannot pass for
 * the right reason, only by accident or not at all. Testing this function
 * directly against realistic row shapes is what actually proves the
 * route's DB -> manifest wiring; `report-provenance.test.tsx`'s ReportPdf
 * tests above already prove the RENDERING half (an EvidenceManifestRow[]
 * given to ReportPdf renders correctly), and
 * __tests__/integration/report-provenance.test.ts proves this function
 * against REAL fetched database rows.
 */
describe('toEvidenceManifest (route wiring: shapes real Evidence rows into EvidenceManifestRow[])', () => {
  const baseRow = {
    id: 'ev1',
    orgId: 'org1',
    assessmentId: 'a1',
    frameworkVersionId: 'fv1',
    questionId: 'Q-PP-01',
    remediationItemId: null,
    mimeType: 'application/pdf',
    byteSize: 10,
  };

  it('maps filename and sha256 straight through, formats the date, and resolves uploaderName from the names map', () => {
    const rows = [
      { ...baseRow, filename: 'a.pdf', sha256: 'x'.repeat(64), uploadedById: 'u1', uploadedAt: new Date('2026-08-05T10:00:00.000Z') },
    ];
    const names = new Map([['u1', { name: 'Jordan Lee' }]]);
    expect(toEvidenceManifest(rows, names)).toEqual([
      { filename: 'a.pdf', sha256: 'x'.repeat(64), uploaderName: 'Jordan Lee', uploadedAt: '2026-08-05' },
    ]);
  });

  it('falls back to "Unknown" when uploadedById is null (user erasure, O-5.2) or absent from the names map', () => {
    const rows = [
      { ...baseRow, filename: 'scrubbed.pdf', sha256: 'y'.repeat(64), uploadedById: null, uploadedAt: new Date('2026-08-06T00:00:00.000Z') },
      { ...baseRow, filename: 'unresolved.pdf', sha256: 'z'.repeat(64), uploadedById: 'ghost', uploadedAt: new Date('2026-08-06T00:00:00.000Z') },
    ];
    const manifest = toEvidenceManifest(rows, new Map());
    expect(manifest[0].uploaderName).toBe('Unknown');
    expect(manifest[1].uploaderName).toBe('Unknown');
  });

  it('produces one row per input row, in the same order, for multiple evidence items', () => {
    const rows = [
      { ...baseRow, filename: 'a.pdf', sha256: 'a'.repeat(64), uploadedById: 'u1', uploadedAt: new Date('2026-08-01T00:00:00.000Z') },
      { ...baseRow, filename: 'b.pdf', sha256: 'b'.repeat(64), uploadedById: 'u1', uploadedAt: new Date('2026-08-02T00:00:00.000Z') },
    ];
    const names = new Map([['u1', { name: 'Jordan Lee' }]]);
    expect(toEvidenceManifest(rows, names).map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf']);
  });

  it('returns an empty array for an assessment with no evidence', () => {
    expect(toEvidenceManifest([], new Map())).toEqual([]);
  });
});
