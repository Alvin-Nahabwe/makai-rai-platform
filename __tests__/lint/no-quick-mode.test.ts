import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * D-012 was closed once while the feature was still half-present, and the
 * remnants then survived three weeks because nothing enumerated them. This
 * asserts the property ("no quick mode anywhere") rather than a list of the
 * files that had it, so a reintroduction fails here rather than being noticed
 * by someone reading a diff.
 */
describe('quick assessment mode is gone', () => {
  it('leaves no source reference to quick mode', () => {
    // Task 3 (2026-08-26) dropped assessments.mode and the AssessmentMode
    // enum, so schema.prisma no longer legitimately declares it -- scope now
    // includes it. prisma/migrations/ stays excluded permanently: an applied
    // migration is immutable history, and the enum genuinely existed when
    // 20260629133510_init ran.
    const files = execSync('git ls-files app lib components e2e data __tests__ prisma/schema.prisma')
      .toString().trim().split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx|json|css|sql|prisma)$/.test(f))
      .filter((f) => f !== '__tests__/lint/no-quick-mode.test.ts');
    const offenders: string[] = [];
    for (const f of files) {
      const src = execSync(`cat ${JSON.stringify(f)}`).toString();
      if (/QuickAssessment|getQuickScore|AssessmentMode|['"]quick['"]|badge--quick/.test(src)) {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
