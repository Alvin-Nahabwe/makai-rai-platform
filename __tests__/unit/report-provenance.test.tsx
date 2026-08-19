import { describe, it, expect } from 'vitest';
import { formatProvenanceLine, isFrameworkDrifted, driftBannerText, maturityRingAriaLabel } from '@/lib/report/provenance';
import { ReportSummary } from '@/components/report/ReportSummary';
import { ReportPdf, sanitizeManifestText, type EvidenceManifestRow } from '@/lib/pdf/ReportPdf';
import { toEvidenceManifest } from '@/app/api/v1/orgs/[slug]/reports/[id]/pdf/route';
import { extractText } from '../helpers/extractText';
import type { ReportData } from '@/types/domain';

/**
 * Plan 1c Task 9 (O-14 completed half, O-15, O-16). `ReportSummary` and
 * `ReportPdf` are both plain function components with no hooks (confirmed
 * by reading both files before writing this test) -- calling them directly
 * as functions, the way `__tests__/unit/evidence-inspect.test.ts` and
 * `evidence-data.test.ts` call pure functions directly, returns the
 * unrendered React element tree.
 */

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
    const text = driftBannerText('cached-only');
    expect(text).toContain('differs from the pinned version');
    expect(text).toContain("state as recorded at completion");
    expect(text).toContain('not recalculated when viewed');
    // The specific claim fix round 2 found false for pre-guard data:
    expect(text).not.toMatch(/not been recomputed/i);
  });

  /**
   * C6 whole-branch review, F3 (MEDIUM). The single, unparameterised copy
   * ended "...it is not recalculated when viewed" and was rendered by BOTH
   * surfaces. That is true of the PDF, which reads only `overallScore`,
   * `completedStages` and `principleScores` off the cached `reportData` --
   * and FALSE of the HTML report page, whose largest sections (gaps,
   * areas to strengthen, areas of strength, not-yet-assessed, and the four
   * counts `ReportSummary` itself renders) are recomputed by
   * `components/report/useFindingsData.ts` on every view from its STATIC
   * imports of `data/questionBank.json` and `data/assessmentAreas.json`,
   * i.e. today's deployed content. Under drift -- the one situation this
   * banner exists for -- the banner sat directly above numbers it said
   * were not recalculated and which were.
   *
   * The copy is now scoped rather than made vaguer: one source of truth
   * (this module) still owns every word, but each surface names what IT
   * recomputes, so neither can inherit a claim that is false for it.
   */
  it('makes a strictly narrower promise for a surface with live findings than for a cached-only one', () => {
    const cached = driftBannerText('cached-only');
    const live = driftBannerText('live-findings');
    expect(live).not.toBe(cached);
    // Both still open with the fact that triggered the banner.
    expect(live).toContain('differs from the pinned version');
    // The cached-only variant claims EVERYTHING shown is from the stored
    // record; the live-findings variant must NOT make that claim...
    expect(cached).toMatch(/every value shown comes from that stored record/i);
    expect(live).not.toMatch(/every value shown comes from that stored record/i);
    // ...and must say, in terms, that the findings are derived from
    // today's content.
    expect(live).toMatch(/findings/i);
    expect(live).toMatch(/today's framework content/i);
    // The scores claim survives in both: it is true in both.
    expect(cached).toContain('recorded at completion');
    expect(live).toContain('recorded at completion');
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

  /**
   * C6 whole-branch review, F3/F1. This case's title used to read "the
   * report surface has no cached report to annotate yet". That was true of
   * the HTML page, which redirects a non-completed assessment away, and
   * FALSE of the PDF route, which generated one inline and stamped the
   * pinned hash on it -- the title encoded the very premise that made F1
   * invisible. Both surfaces now genuinely refuse a non-completed
   * assessment (the page redirects; the route 409s, C6 F1), so this
   * function is never consulted for one at all, and `false` is the right
   * answer for a reason that now holds everywhere rather than in one
   * place.
   */
  it('is false for an in-progress, MISMATCHED assessment -- no report surface renders one at all: the HTML page redirects and the PDF route refuses (C6 F1)', () => {
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
  // Task 6: the second independent reading (PracticeCoverage | null).
  // Defaulted to null here so every pre-existing test in this describe
  // block -- none of which is about practice coverage -- keeps exercising
  // the "absent" branch rather than silently picking up a stray non-null
  // value.
  overallPractices: null as { inPlace: number; total: number; byRole: Record<string, { inPlace: number; total: number }> } | null,
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

  it("shows the drift banner, matching driftBannerText('live-findings') exactly -- one source of copy, not a paraphrase", () => {
    const text = extractText(ReportSummary({ ...BASE_SUMMARY_PROPS, frameworkDrifted: true }));
    expect(text).toContain(driftBannerText('live-findings'));
  });

  /**
   * C6 F3. The claim above is "the copy is not paraphrased"; this one is
   * "the copy is the RIGHT VARIANT for this surface", and neither proves
   * the other. `ReportSummary` renders `strengthsCount`/`attentionsCount`/
   * `gapsCount` -- all three recomputed from deployed content by
   * `useFindingsData` on every view -- so the cached-only variant, which
   * promises nothing is recalculated, would be a false statement sitting
   * directly above three numbers that are.
   */
  it('renders the live-findings variant, never the cached-only one -- its own counts are recomputed on every view', () => {
    const text = extractText(ReportSummary({ ...BASE_SUMMARY_PROPS, frameworkDrifted: true }));
    expect(text).not.toContain(driftBannerText('cached-only'));
  });
});

/**
 * Task 6. `overallScore` is now assessed MATURITY, not a single combined
 * "readiness" figure -- see `types/domain.ts#ReportData.overallScore`'s own
 * comment. `overallPractices` is the second, independent reading (checklist
 * coverage, a count, not a percentage). The wording below
 * ("N of M practices in place" / "No practices assessed") is not invented
 * here: it is the SAME copy `AreaCard.tsx` and `PrincipleScorecard.tsx`
 * already render for the identical concept (Tasks 5/5b) -- a reader must
 * not meet "practices in place" on an area card and a different phrase for
 * the same idea in the executive summary.
 */
/**
 * `extractText` (used everywhere else in this file) walks only
 * `.props.children`, so it cannot see an attribute like `aria-label` --
 * confirmed by reading `__tests__/helpers/extractText.ts` before writing
 * this. This walks the identical `.props.children` tree, but returns the
 * first element whose `className` matches, so the ring's ACTUAL rendered
 * `aria-label` -- not just `maturityRingAriaLabel` called in isolation --
 * can be asserted against. Local to this file rather than added to the
 * shared helper: nothing else in this repo currently needs to find an
 * element by className, only its text.
 */
function findByClassName(node: unknown, className: string): { props: Record<string, unknown> } | null {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
    return null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClassName(child, className);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === 'object' && 'props' in (node as { props?: unknown })) {
    const el = node as { props: Record<string, unknown> };
    if (el.props?.className === className) return el;
    return findByClassName(el.props?.children ?? null, className);
  }
  return null;
}

describe('ReportSummary -- maturity ring vs. practice coverage (Task 6)', () => {
  it('rings the maturity score and states practice coverage separately', () => {
    const out = extractText(ReportSummary({
      ...BASE_SUMMARY_PROPS,
      overallScore: 62,
      overallPractices: { inPlace: 30, total: 48, byRole: {} },
    }));

    expect(out).toContain('62%');
    expect(out).toContain('30 of 48 practices in place');
  });

  it('states coverage as absent rather than zero when nothing was ticked', () => {
    const out = extractText(ReportSummary({
      ...BASE_SUMMARY_PROPS, overallScore: 62, overallPractices: null,
    }));

    expect(out).toContain('No practices assessed');
    expect(out).not.toContain('0 of 0');
  });

  /**
   * The ring's `aria-label` names WHICH reading it describes. Pinned as an
   * exact-copy test the same way `formatProvenanceLine` is pinned above:
   * `maturityRingAriaLabel` is the single function both the component and
   * this test call, so there is no risk of the test re-deriving the same
   * wrong wording the component uses (D-166-shaped bug class). The
   * previous copy, "Overall readiness score: N%, <level>", is asserted
   * ABSENT below -- that is the exact defect the brief requires fixed: a
   * screen-reader user told "overall readiness" for a figure that now
   * measures only one of two independent readings.
   */
  it("names the ring as the maturity reading in its aria-label ('Assessed maturity: N%, <level>'), not a generic 'overall readiness' figure", () => {
    expect(maturityRingAriaLabel(62, 'Developing')).toBe('Assessed maturity: 62%, Developing');
    expect(maturityRingAriaLabel(62, 'Developing')).not.toMatch(/overall readiness/i);
  });

  /**
   * The test above proves the formatter is right in isolation; this one
   * proves the COMPONENT actually wires it into the rendered ring's
   * `aria-label`, rather than having its own separately-typed copy that
   * happens to match today. Fails if `ReportSummary` stops calling
   * `maturityRingAriaLabel`, calls it with the wrong arguments, or reverts
   * to an inline template literal.
   */
  it('renders that exact aria-label on the score-ring element itself', () => {
    const ring = findByClassName(ReportSummary(BASE_SUMMARY_PROPS), 'score-ring');
    expect(ring).not.toBeNull();
    expect(ring?.props['aria-label']).toBe(
      maturityRingAriaLabel(BASE_SUMMARY_PROPS.overallScore, BASE_SUMMARY_PROPS.levelLabels.developing),
    );
  });

  /**
   * The narrative paragraph used to open "Overall readiness across N
   * completed stages" -- a claim of completeness that stopped being true
   * once `overallPractices` became a second, independent reading this same
   * paragraph says nothing about. It must now name the SAME reading the
   * ring's aria-label names ("Assessed maturity"), not a generic claim to
   * summarise "readiness" as a whole.
   */
  it('describes the narrative paragraph as maturity, not as an unqualified summary of overall readiness', () => {
    const out = extractText(ReportSummary(BASE_SUMMARY_PROPS));
    expect(out).toContain('Assessed maturity across');
    expect(out).not.toMatch(/Overall readiness across/i);
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

  it("shows the banner, matching driftBannerText('cached-only') exactly -- the SAME function ReportSummary uses, not a second copy", () => {
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, frameworkDrifted: true }));
    expect(text).toContain(driftBannerText('cached-only'));
  });

  /**
   * C6 F3, the PDF-side counterpart of `ReportSummary`'s variant test.
   * This document renders no live findings at all, so the narrower
   * live-findings copy would be a warning about sections that are not on
   * it -- wrong in the other direction.
   */
  it('renders the cached-only variant, never the live-findings one -- this document contains no recomputed section', () => {
    const text = extractText(ReportPdf({ ...BASE_PDF_PROPS, frameworkDrifted: true }));
    expect(text).not.toContain(driftBannerText('live-findings'));
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

  /**
   * C6 F2: this case's title used to attribute the null to "user erasure,
   * O-5.2". Erasure does not null this column and cannot -- `makrai_app`
   * has no `UPDATE` grant on `evidence`. An erased uploader renders as
   * 'Deleted user' (the scrubbed `users.name`), never 'Unknown'. What is
   * pinned below is a TOTALITY property over the declared types, which is
   * a real and worthwhile claim; it just is not the erasure claim. D-174.
   */
  it('falls back to "Unknown" for the type-level cases -- a null uploadedById, or an id absent from the names map', () => {
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
