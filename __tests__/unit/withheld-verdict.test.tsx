import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { extractText } from '../helpers/extractText';
import { PrincipleScorecard } from '@/components/report/PrincipleScorecard';
import { ReportSummary } from '@/components/report/ReportSummary';
import { AreaCard } from '@/components/report/AreaCard';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { GapHeatmap, LEVEL_STYLES } from '@/components/dashboard/GapHeatmap';
import { withheldVerdictNote } from '@/lib/report/provenance';
import { verdictColor } from '@/lib/report/verdictColor';
import { legendRangeSuffix, maturityLegendContent } from '@/app/(authenticated)/orgs/[slug]/assessment/[id]/report/page';
import { levelLabels } from '@/data/constants';
import type { ReportData } from '@/types/domain';

/**
 * Fix round 1 (coordinator finding 1/2): `extractText` walks TEXT only, by
 * design (its own doc comment). Several surfaces withhold by COLOUR alone,
 * rendering no verdict word at all (`AreaCard`, `GapHeatmap`'s per-cell
 * style) -- a text-only assertion cannot observe that dimension, so it
 * passes whether or not the colour ternary under test does anything.
 * Bypassing each such ternary and re-running the ORIGINAL text-only tests
 * confirmed this: 14/14 stayed green. `findAll` walks the same unrendered
 * element tree `extractText`/`findByClassName` (report-provenance.test.tsx)
 * already walk, but returns every element matching a predicate over
 * `.props` (and, where useful, `.type`) instead of concatenating text --
 * the minimum needed to assert on `style.color` rather than on rendered
 * copy.
 */
interface ElementLike { type?: unknown; props: Record<string, unknown>; }

function findAll(node: unknown, predicate: (el: ElementLike) => boolean, out: ElementLike[] = []): ElementLike[] {
  if (node === null || node === undefined || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') {
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (typeof node === 'object' && 'props' in (node as ElementLike)) {
    const el = node as ElementLike;
    if (predicate(el)) out.push(el);
    findAll((el.props as { children?: ReactNode }).children ?? null, predicate, out);
    return out;
  }
  return out;
}

/**
 * maturity-band-reanchor Task 7. A report scored under a superseded
 * methodology (`lib/report/maturityBands.ts#labelIsShowable` false) must
 * still show its percentage and practices count, but never the band word
 * NOR the band colour -- a colour asserts the same verdict the word does.
 * See that module's own doc comment and task-7-brief.md.
 *
 * Every component under test here is hook-free (verified by reading each
 * file before writing this test) and is called directly as a plain
 * function, per __tests__/unit/report-provenance.test.tsx's own pattern
 * (D-169: no jsdom, no @testing-library/react, no react-test-renderer in
 * this repo).
 *
 * Every test in this file asserts BOTH halves: the percentage is present
 * (so the withholding did not also hide the real number) and the band word
 * is absent (so a stale label cannot leak through) -- a test that only
 * checked one half would pass whether or not the other were true.
 */

describe('PrincipleScorecard withholds the band word for a superseded report', () => {
  // Matches the existing, pinned shape in principle-scorecard.test.tsx
  // (`PrincipleScorecard({ principle } as never)`) -- that file is not in
  // this task's scope and must keep passing, so PrincipleScorecardProps
  // keeps its `principle` wrapper; `labelIsShowable` is threaded in as a
  // SIBLING prop, not folded into `principle`, precisely so the predicate
  // and the percentage/level stay the two independent things the design
  // spec (§3.3) requires them to be.
  const principle = {
    name: 'Fairness & Non-discrimination',
    pct: 78,
    level: 'strong',
    practices: { inPlace: 2, total: 5, byRole: {} },
  };

  it('omits the band word but keeps the percentage when the predicate is false', () => {
    const text = extractText(PrincipleScorecard({ principle, labelIsShowable: false } as never));
    expect(text).toContain('78%');
    expect(text).not.toContain(levelLabels.strong);
  });

  it('still states the verdict for a current report', () => {
    const text = extractText(PrincipleScorecard({ principle, labelIsShowable: true } as never));
    expect(text).toContain('78%');
    expect(text).toContain(levelLabels.strong);
  });
});

describe('ReportSummary withholds the ring label AND the prose verdict for a superseded report', () => {
  // 95, not 78 (coordinator fix round 2): the prior fixture's score put the
  // 'strong' band ONLY in `overallLevel` (an injected, unchecked prop) and
  // never actually reached `getLevel`/`BAND_MINIMUMS` at 78 -- the ungated
  // prose sentences (report/page.tsx's own ternary on `overallScore`, not
  // `overallLevel`) select their branch by the raw NUMBER, so 78 rendered
  // "Solid start, but some areas still need work.", which contains no
  // occurrence of `levelLabels.strong` ("Strong") and let the defect pass
  // `not.toContain(levelLabels.strong)` undetected. 95 >= BAND_MINIMUMS.strong
  // (87.5) puts the strong-band SENTENCE, not just the ring label, in range.
  const BASE = {
    overallScore: 95,
    overallLevel: 'strong',
    overallPractices: { inPlace: 10, total: 20, byRole: {} },
    completedStagesCount: 2,
    strengthsCount: 1,
    attentionsCount: 1,
    gapsCount: 1,
    activeModifiersCount: 0,
    levelLabels,
    levelColors: { strong: '#22C55E' },
    frameworkSemver: '3.0.0',
    frameworkPinnedDate: '2026-08-06',
    frameworkContentHash: 'a'.repeat(64),
    frameworkDrifted: false,
    scoringVersion: '5.0.0',
  };

  it('omits the band word from the ring but keeps the percentage when withheld', () => {
    const text = extractText(ReportSummary({ ...BASE, labelIsShowable: false } as never));
    expect(text).toContain('95%');
    expect(text).not.toContain(levelLabels.strong);
  });

  /**
   * Coordinator fix round 2. The three band-derived prose sentences
   * (report-summary__desc, "There are gaps that need fixing." / "Solid
   * start..." / "You're in good shape...") are a verdict exactly like the
   * ring word -- rendering one while the ring says "Verdict withheld" is
   * the live defect this round fixes (26 of 139 completed reports on the
   * real dev database were caught doing precisely this). Asserted as its
   * own test, distinct from the ring-word test above, because a single
   * shared assertion is exactly how this defect stayed invisible: the
   * prior version of this file's `not.toContain(levelLabels.strong)` only
   * ever checked the ring, never the prose.
   */
  it('omits all three band-derived prose sentences when withheld, but keeps the factual coverage sentence', () => {
    const text = extractText(ReportSummary({ ...BASE, labelIsShowable: false } as never));
    expect(text).toContain('Assessed maturity across 2 completed stages.');
    expect(text).not.toContain('gaps that need fixing');
    expect(text).not.toContain('Solid start');
    expect(text).not.toContain('good shape');
  });

  it('still states the ring verdict for a current report', () => {
    const text = extractText(ReportSummary({ ...BASE, labelIsShowable: true } as never));
    expect(text).toContain('95%');
    expect(text).toContain(levelLabels.strong);
  });

  it('still states the prose verdict for a current report', () => {
    const text = extractText(ReportSummary({ ...BASE, labelIsShowable: true } as never));
    expect(text).toContain("You're in good shape. Keep it up as your system evolves.");
  });
});

describe('AreaCard withholds the maturity colour for a superseded report (no word to withhold here -- the tier badge is a separate, non-band classification)', () => {
  const AREA = {
    id: 'PP-01', name: 'Problem Formulation', stage: 'pre-processing',
    principle: 'Proportionality & Do Not Harm', controls: [],
  };
  const BASE = {
    area: AREA, tier: 'attention' as const, findings: [], controlsMap: {},
    stageLabels: {}, expanded: false, onToggle: () => {},
    score: { maturity: 78, practices: { inPlace: 2, total: 5, byRole: {} } },
  };

  /**
   * The maturity reading's value span AND the practices reading's value
   * span share the SAME className (`gap-card__reading-value`) -- only the
   * maturity one ever carries a `style` prop (the practices span is
   * plain text, no colour at all), which is what disambiguates them here
   * without asserting on tree position.
   */
  function maturityValueStyle(tree: unknown): Record<string, unknown> | undefined {
    const matches = findAll(
      tree,
      (el) => el.props.className === 'gap-card__reading-value' && 'style' in el.props,
    );
    expect(matches.length, 'expected exactly one styled reading-value span').toBe(1);
    return matches[0].props.style as Record<string, unknown> | undefined;
  }

  it('still renders the percentage when withheld', () => {
    const text = extractText(AreaCard({ ...BASE, labelIsShowable: false } as never));
    expect(text).toContain('78%');
  });

  it('still renders the percentage for a current report', () => {
    const text = extractText(AreaCard({ ...BASE, labelIsShowable: true } as never));
    expect(text).toContain('78%');
  });

  it('renders the maturity reading in the withheld colour token, not a band colour, when withheld', () => {
    const style = maturityValueStyle(AreaCard({ ...BASE, labelIsShowable: false } as never));
    expect(style?.color).toBe('var(--color-verdict-withheld)');
  });

  it('renders the maturity reading in its real band colour for a current report', () => {
    const style = maturityValueStyle(AreaCard({ ...BASE, labelIsShowable: true } as never));
    expect(style?.color).not.toBe('var(--color-verdict-withheld)');
    // score.maturity: 78 falls in the 'developing' band under the current
    // bands (BAND_MINIMUMS.strong = 87.5) -- levelColors.developing.
    expect(style?.color).toBe('#FACC15');
  });
});

const REPORT_DATA_CURRENT: ReportData = {
  version: '3.0.0',
  scoringVersion: '6.0.0',
  generatedAt: '2026-08-06T12:00:00.000Z',
  completedStages: ['pre-processing'],
  // 90, not 78: ReportPdf computes its OVERALL level itself via
  // getLevel(overallScore) (unlike the per-principle/per-area rows below,
  // whose `level`/word is injected as data and never asserted on here) --
  // under the current bands (BAND_MINIMUMS.strong = 87.5) 78 is
  // 'developing', not 'strong'. 90 is unambiguously 'strong'.
  overallScore: 90,
  overallPractices: { inPlace: 10, total: 20, byRole: {} },
  stageScores: {
    'pre-processing': {
      'PP-01': { maturity: 78, practices: { inPlace: 4, total: 5, byRole: {} } },
    },
  },
  principleScores: {
    'pre-processing': {
      Fairness: { maturity: 78, practices: { inPlace: 9, total: 15, byRole: {} } },
    },
  },
  activeModifiers: [],
  unlockedConditionals: [],
};

const REPORT_DATA_SUPERSEDED: ReportData = { ...REPORT_DATA_CURRENT, scoringVersion: '5.0.0' };

const PDF_BASE = {
  projectName: 'Probe Project',
  assessorName: 'Alex Assessor',
  assessmentDate: '2026-08-06',
  frameworkSemver: '3.0.0',
  frameworkPinnedDate: '2026-08-06',
  frameworkContentHash: 'a'.repeat(64),
  frameworkDrifted: false,
  evidenceManifest: [],
};

describe('ReportPdf withholds the overall label word and per-row bands for a superseded report', () => {
  it('omits the band word but keeps the percentage when reportData.scoringVersion predates the bands', () => {
    const text = extractText(ReportPdf({ ...PDF_BASE, reportData: REPORT_DATA_SUPERSEDED } as never));
    expect(text).toContain('78%');
    expect(text).not.toContain(levelLabels.strong);
  });

  it('still states the verdict for a report scored under the current bands', () => {
    const text = extractText(ReportPdf({ ...PDF_BASE, reportData: REPORT_DATA_CURRENT } as never));
    expect(text).toContain('78%');
    expect(text).toContain(levelLabels.strong);
  });

  /**
   * `scoringVersion` absent entirely (every report cached before Task 6
   * wrote the field) must withhold too -- `labelIsShowable(undefined)` is
   * `false` by construction, not a special case this component adds.
   */
  it('withholds when scoringVersion was never recorded at all', () => {
    const { scoringVersion: _drop, ...withoutVersion } = REPORT_DATA_CURRENT;
    const text = extractText(ReportPdf({ ...PDF_BASE, reportData: withoutVersion } as never));
    expect(text).toContain('78%');
    expect(text).not.toContain(levelLabels.strong);
  });
});

describe('GapHeatmap withholds the cell colour, per assessment column, for a superseded report', () => {
  it('keeps the percentage text for a superseded column', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '5.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 78, practices: null } } } },
    }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));
    expect(out).toContain('78%');
  });

  /**
   * Coordinator fix round 1, finding 2. `GapHeatmap`'s cell carries no
   * verdict WORD at all (only a percentage and a colour), so a
   * text-based assertion cannot observe the per-cell
   * `labelShowable ? bandLevel : 'withheld'` ternary -- bypassing it left
   * the file's prior text-only test green. `title` disambiguates the one
   * cell under test (`${areaId}: ${score}%`, unique per row/column pair)
   * without depending on tree position.
   */
  function cellStyle(tree: unknown, titleSubstring: string): Record<string, unknown> | undefined {
    const matches = findAll(
      tree,
      (el) => typeof el.props.title === 'string' && (el.props.title as string).includes(titleSubstring),
    );
    expect(matches.length, `expected exactly one cell with title containing '${titleSubstring}'`).toBe(1);
    return matches[0].props.style as Record<string, unknown> | undefined;
  }

  it('resolves the withheld style pair, not a band pair, for a superseded column', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '5.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 90, practices: null } } } },
    }];

    const style = cellStyle(GapHeatmap({ assessments: rows } as never), 'PP-01: 90%');
    expect(style?.backgroundColor).toBe(LEVEL_STYLES.withheld.backgroundColor);
    expect(style?.color).toBe(LEVEL_STYLES.withheld.color);
  });

  it('resolves the real band pair (strong) for a showable column', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '6.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 90, practices: null } } } },
    }];

    const style = cellStyle(GapHeatmap({ assessments: rows } as never), 'PP-01: 90%');
    expect(style?.backgroundColor).toBe(LEVEL_STYLES.strong.backgroundColor);
    expect(style?.color).toBe(LEVEL_STYLES.strong.color);
  });

  /**
   * `LEVEL_STYLES` is generation-tested elsewhere
   * (__tests__/unit/dashboard-scores.test.tsx) to cover every band
   * `getLevel` can return; this only pins that a withheld-style entry
   * exists and is visually distinct from every band pair AND from
   * 'empty' (the "nothing to show" style), the same distinctness property
   * that test already checks for the four real bands.
   */
  it('has a withheld style distinct from every band pair and from the empty (no-data) pair', () => {
    const withheld = LEVEL_STYLES.withheld;
    expect(withheld).toBeDefined();
    const pairs = new Set<string>();
    for (const [key, style] of Object.entries(LEVEL_STYLES)) {
      const pair = `${style.backgroundColor}/${style.color}`;
      expect(pairs.has(pair), `'${key}' collides with an earlier entry`).toBe(false);
      pairs.add(pair);
    }
  });

  /**
   * Same principle as report/page.tsx's Step 6 ("a legend explaining four
   * bands, above a report showing none, is worse than no legend"), applied
   * to this widget's OWN band legend at the bottom of the table. Not
   * hypothetical: every assessment on this branch is still scored under
   * SCORING_VERSION 5.0.0 (pre-6.0.0), so a real compare page right now
   * would show every column withheld while this legend kept explaining
   * bands that appear nowhere on the page.
   */
  it('omits the band-word legend entirely when every compared column is withheld', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '5.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 90, practices: null } } } },
    }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));
    expect(out).toContain('90%');
    expect(out).not.toContain(levelLabels.strong);
  });

  it('still shows the band-word legend when at least one compared column is showable', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '6.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 90, practices: null } } } },
    }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));
    expect(out).toContain(levelLabels.strong);
  });
});

describe('withheldVerdictNote (report-page legend replacement copy)', () => {
  it('states why, without asserting the number is wrong -- only that it cannot be classified', () => {
    const text = withheldVerdictNote();
    expect(text).toContain('superseded scoring methodology');
    expect(text).toContain('cannot be honestly classified');
  });
});

/**
 * Coordinator fix round 1, finding 3. `verdictColor` is the pure function
 * extracted from three previously-untested call sites: report/page.tsx's
 * lifecycle-header colour, and the identical colour decision in
 * `projects/page.tsx`/`projects/[id]/page.tsx` (both hook-heavy or async
 * server components this repo's test harness cannot render, per D-169 --
 * see this file's own header comment). Testing the extracted function
 * directly is the same level of coverage `legendRangeSuffix` already
 * provides for this page's legend text, and all three call sites now
 * literally invoke this function (not a locally re-typed copy of its
 * logic), so proving it correct proves the DECISION correct at every site
 * that calls it.
 */
describe('verdictColor', () => {
  it('returns the real band colour when the label is showable', () => {
    expect(verdictColor(true, 'strong')).toBe('#22C55E');
    expect(verdictColor(true, 'developing')).toBe('#FACC15');
  });

  it('returns the withheld token, never a band colour, when the label is not showable', () => {
    expect(verdictColor(false, 'strong')).toBe('var(--color-verdict-withheld)');
    expect(verdictColor(false, 'critical')).toBe('var(--color-verdict-withheld)');
  });
});

/**
 * Coordinator fix round 1, finding 3. `maturityLegendContent` is the report
 * page's legend-or-sentence decision (Step 6), extracted so it is callable
 * without rendering the hook-heavy page -- see its own doc comment in
 * report/page.tsx. Called directly and walked with `extractText`, the same
 * convention `lib/pdf/ReportPdf.tsx`'s `renderMaturity`/`renderPractices`
 * already establish for an eagerly-called plain function returning JSX.
 */
describe('maturityLegendContent (report page)', () => {
  it('shows the four-band legend, with each band word and its range, when showable', () => {
    const out = extractText(maturityLegendContent(true));
    expect(out).toContain(levelLabels.strong);
    expect(out).toContain(legendRangeSuffix('strong').trim());
    expect(out).not.toContain(withheldVerdictNote());
  });

  it('replaces the legend with the withheld-verdict sentence, and no band word, when not showable', () => {
    const out = extractText(maturityLegendContent(false));
    expect(out).toContain(withheldVerdictNote());
    expect(out).not.toContain(levelLabels.strong);
    expect(out).not.toContain(levelLabels.developing);
  });
});
