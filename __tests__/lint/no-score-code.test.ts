import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * RM (score removal), FR-RM-02 and NFR-MNT-04: no score code is left behind.
 * The property is asserted over the tree, not over a list of the files that
 * once held a score, so a score identifier that returns anywhere under the
 * named roots fails here.
 */

const PATTERN =
  /overallScore|reportData|scoringVersion|engineState|maturityBand|calculateAreaScores|generateReportData|crossStageWeights/;

/** Every text file under `roots`, as a repo-relative path with '/' separators. */
function textFiles(roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs|json|css|md)$/.test(name)) out.push(full.split(path.sep).join('/'));
    }
  };
  // A missing root throws (ENOENT) rather than being skipped, so a renamed
  // directory cannot turn the scan into a pass over nothing.
  for (const r of roots) walk(r);
  return out.sort();
}

function grepFiles(roots: string[], pattern: RegExp): string[] {
  return textFiles(roots).filter((f) => pattern.test(readFileSync(f, 'utf8')));
}

describe('FR-RM-02: no score code', () => {
  it('FR-RM-02 NFR-MNT-04: no score identifier outside the migrations', () => {
    expect(grepFiles(['app', 'components', 'lib', 'data', 'types'], PATTERN)).toEqual([]);
  });

  it('FR-RM-02: the engine, the band library, the charts, the stage picker, the scoring configuration and the 4.0.0 hash do not exist', () => {
    for (const f of [
      'lib/engine/AssessmentEngine.js',
      'lib/engine/AssessmentEngine.d.ts',
      'lib/report/maturityBands.ts',
      'components/dashboard/ScoreGauge.tsx',
      'components/dashboard/RadarChart.tsx',
      'components/dashboard/GapHeatmap.tsx',
      'components/dashboard/TrendChart.tsx',
      'components/assessment/StageSelector.tsx',
      'lib/pdf/ReportPdf.tsx',
      'data/scoringConfig.json',
      'lib/framework/bundleHash.ts',
    ])
      expect(existsSync(f), f).toBe(false);
  });

  it('FR-RM-01 NFR-PERF-01: no chart library is a dependency, and no page-weight exception names RM', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).dependencies).not.toHaveProperty('recharts');
    // H0's file; absent until unit/h0 merges.
    const f = 'scripts/first-load-exceptions.json';
    if (existsSync(f)) {
      expect(
        JSON.parse(readFileSync(f, 'utf8')).filter((e: { owner: string }) => e.owner === 'RM'),
      ).toEqual([]);
    }
  });
});
