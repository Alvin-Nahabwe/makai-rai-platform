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
    //
    // Exactly two files are excluded, both on the SAME property, not two
    // unrelated carve-outs: a test that proves an identifier is ABSENT must
    // be allowed to name that identifier once, in order to assert its
    // absence -- naming it is not reintroducing it.
    //   - this file: the detection regex below necessarily spells out every
    //     retired identifier it hunts for.
    //   - schema-shape.test.ts (Task 3): asserts `AssessmentMode` no longer
    //     exists as a Postgres type, which requires querying pg_type for the
    //     literal string "AssessmentMode" -- the same self-reference this
    //     file has, one guard test proving the property this file also
    //     enforces, from a different angle (live schema vs. source grep).
    const SELF_PROVING_ABSENCE = new Set([
      '__tests__/lint/no-quick-mode.test.ts',
      '__tests__/integration/schema-shape.test.ts',
    ]);
    const files = execSync('git ls-files app lib components e2e data __tests__ prisma/schema.prisma')
      .toString().trim().split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx|json|css|sql|prisma)$/.test(f))
      .filter((f) => !SELF_PROVING_ABSENCE.has(f));
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
