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
