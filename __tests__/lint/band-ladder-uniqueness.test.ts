import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

const OWNER = 'lib/report/maturityBands.ts';

function sourceFiles(): string[] {
  return execSync('git ls-files app lib components')
    .toString().trim().split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => f !== OWNER);
}

describe('exactly one maturity band ladder exists', () => {
  /**
   * D-219: three ladders classified the same assessed-maturity number and
   * disagreed -- 75/50/25 on the report and PDF, 80/60/40 on the project
   * pages, 70/40 on the gap heatmap. An area at 78 read Strong and green on
   * one screen and amber on another.
   *
   * TWO properties, not one, and that is the lesson rather than a detail. The
   * first draft of the spec enumerated by numeric-literal alone and missed
   * AreaCard.tsx and PrincipleScorecard.tsx, which contain no literal because
   * they IMPORT getLevel. One lens is not an inventory (AGENTS.md §3).
   */
  it('has no second numeric ladder', () => {
    const ladder = /\b(score|maturity|pct|percent|overall\w*)\s*(>=|<=|>|<)\s*\d/i;
    const offenders = sourceFiles().filter((f) =>
      ladder.test(execSync(`cat ${JSON.stringify(f)}`).toString()),
    );
    expect(offenders).toEqual([]);
  });

  it('has no second getLevel definition', () => {
    const definition = /(function\s+getLevel|const\s+getLevel\s*=)/;
    const offenders = sourceFiles().filter((f) =>
      definition.test(execSync(`cat ${JSON.stringify(f)}`).toString()),
    );
    expect(offenders).toEqual([]);
  });
});
