import { describe, it, expect } from 'vitest';
import { ratingLabels } from '@/data/constants';
import { BAND_MINIMUMS, getLevel, levelRange, labelIsShowable } from '@/lib/report/maturityBands';

/**
 * The image of response option `i` under the engine's normalisation:
 * lib/engine/AssessmentEngine.js#normalizeResponse divides a likert index by 4
 * and the score is scaled to 100, so option i maps to i/(n-1)*100.
 * Derived from `ratingLabels` rather than hard-coded, so that changing the
 * response scale fails THIS test instead of silently re-creating the defect.
 */
const optionImages = ratingLabels.map((_, i) => (i / (ratingLabels.length - 1)) * 100);

describe('band boundaries sit between response options', () => {
  /**
   * THE DEFECT THIS EXISTS TO PREVENT. Before this change the boundaries were
   * 75/50/25, which ARE three of the five option images, so a team answering
   * "Mostly" to every question landed exactly on the "Strong" edge and was told
   * its practices were comprehensive. A boundary that coincides with an option
   * image means the band is decided by the scale's arithmetic rather than by
   * anyone's judgement.
   */
  it('never places a boundary on a response-option image', () => {
    for (const min of Object.values(BAND_MINIMUMS)) {
      expect(optionImages, `boundary ${min} coincides with a response option`).not.toContain(min);
    }
  });

  it('classifies each option image stably under perturbation', () => {
    const eps = 0.001;
    for (const [i, image] of optionImages.entries()) {
      const here = getLevel(image);
      if (image > 0) {
        expect(getLevel(image - eps), `${ratingLabels[i]} (${image}) is on a lower edge`).toBe(here);
      }
      expect(getLevel(image + eps), `${ratingLabels[i]} (${image}) is on an upper edge`).toBe(here);
    }
  });

  it('maps a uniform "Mostly" answer set to developing, not strong', () => {
    expect(getLevel(75)).toBe('developing');
  });

  it('returns notAssessed for null rather than the worst band', () => {
    expect(getLevel(null)).toBe('notAssessed');
  });

  /**
   * Fix round 1 (coordinator, 2026-08-26): the original guard checked only
   * `pct === null`. `undefined` is a real runtime possibility despite the
   * declared `number | null` type -- a cached report is read back through
   * `assessment.reportData as unknown as ReportData`
   * (app/api/v1/orgs/[slug]/reports/[id]/pdf/route.ts), and that cast is a
   * compile-time claim a stored JSON blob missing a key can violate.
   * `undefined >= 87.5` is `false`, exactly like `null >= 87.5`, so without
   * this the same silent-'critical' misroute the null guard exists to
   * prevent was still reachable through the sibling absent value.
   */
  it('returns notAssessed for undefined, not the worst band', () => {
    expect(getLevel(undefined)).toBe('notAssessed');
  });

  /**
   * D-216 (docs/DEFERRED_REGISTER.md) records a prior defect where an
   * unguarded computation could silently produce NaN, and a test comparing
   * NaN to NaN did not catch it. `NaN >= 87.5` is also `false`, so a NaN
   * reaching this function without this guard would silently render
   * 'Critical' -- a false verdict -- rather than being refused.
   */
  it('returns notAssessed for NaN, not the worst band', () => {
    expect(getLevel(NaN)).toBe('notAssessed');
  });

  it('returns notAssessed for +/-Infinity, not the best or worst band', () => {
    expect(getLevel(Infinity)).toBe('notAssessed');
    expect(getLevel(-Infinity)).toBe('notAssessed');
  });
});

describe('legend text', () => {
  it('describes every band without an unrepresentable integer range', () => {
    expect(levelRange('strong')).toBe('87.5% and above');
    expect(levelRange('developing')).toBe('62.5% to under 87.5%');
    expect(levelRange('needsWork')).toBe('37.5% to under 62.5%');
    expect(levelRange('critical')).toBe('under 37.5%');
  });

  it('gives notAssessed no range, because it is not a point on the scale', () => {
    expect(levelRange('notAssessed')).toBeNull();
  });
});

describe('label withholding', () => {
  it('shows a label for a known band vocabulary', () => {
    expect(labelIsShowable('6.0.0')).toBe(true);
  });

  it('withholds for a report predating the bands', () => {
    expect(labelIsShowable('5.0.0')).toBe(false);
  });

  it('withholds when no scoring version was recorded', () => {
    expect(labelIsShowable(undefined)).toBe(false);
  });

  /**
   * Membership, not comparison. A lexical `>=` would rank '10.0.0' BELOW
   * '6.0.0' and start showing labels under a vocabulary this build has never
   * seen. Set membership cannot make that mistake.
   */
  it('withholds for a version newer than this build knows', () => {
    expect(labelIsShowable('7.0.0')).toBe(false);
    expect(labelIsShowable('10.0.0')).toBe(false);
  });

  it('withholds for anything unparseable', () => {
    expect(labelIsShowable('')).toBe(false);
    expect(labelIsShowable('latest')).toBe(false);
  });
});

import { execSync } from 'node:child_process';

describe('the module stays a leaf', () => {
  /**
   * The whole reason ReportPdf.tsx can import from here. Documented in the
   * module header; asserted here because a comment does not fail a build.
   */
  it('imports nothing', () => {
    const src = execSync('cat lib/report/maturityBands.ts').toString();
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\s*\(/);
  });
});
