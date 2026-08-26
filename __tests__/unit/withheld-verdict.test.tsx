import { describe, it, expect } from 'vitest';
import { extractText } from '../helpers/extractText';
import { PrincipleScorecard } from '@/components/report/PrincipleScorecard';
import { ReportSummary } from '@/components/report/ReportSummary';
import { AreaCard } from '@/components/report/AreaCard';
import { ReportPdf } from '@/lib/pdf/ReportPdf';
import { GapHeatmap, LEVEL_STYLES } from '@/components/dashboard/GapHeatmap';
import { withheldVerdictNote } from '@/lib/report/provenance';
import { levelLabels } from '@/data/constants';
import type { ReportData } from '@/types/domain';

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

describe('ReportSummary withholds the ring label for a superseded report', () => {
  const BASE = {
    overallScore: 78,
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
    expect(text).toContain('78%');
    expect(text).not.toContain(levelLabels.strong);
  });

  it('still states the verdict for a current report', () => {
    const text = extractText(ReportSummary({ ...BASE, labelIsShowable: true } as never));
    expect(text).toContain('78%');
    expect(text).toContain(levelLabels.strong);
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

  it('still renders the percentage when withheld (colour is not visible to extractText, which only walks text)', () => {
    const text = extractText(AreaCard({ ...BASE, labelIsShowable: false } as never));
    expect(text).toContain('78%');
  });

  it('still renders the percentage for a current report', () => {
    const text = extractText(AreaCard({ ...BASE, labelIsShowable: true } as never));
    expect(text).toContain('78%');
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
  it('keeps the percentage text and uses the withheld style, not a band style, for a superseded column', () => {
    const rows = [{
      id: 'a1', version: 1, completedAt: '2026-08-19T00:00:00Z', scoringVersion: '5.0.0',
      reportData: { stageScores: { 'pre-processing': { 'PP-01': { maturity: 78, practices: null } } } },
    }];

    const out = extractText(GapHeatmap({ assessments: rows } as never));
    expect(out).toContain('78%');
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
