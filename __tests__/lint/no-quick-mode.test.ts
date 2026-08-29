import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * D-012 was closed once while the feature was still half-present, and the
 * remnants then survived three weeks because nothing enumerated them. This
 * asserts the property ("no quick mode anywhere") rather than a list of the
 * files that had it, so a reintroduction fails here rather than being noticed
 * by someone reading a diff.
 *
 * Exemptions are scoped to the IDENTIFIER a file has earned, not to the file
 * as a whole. A test that proves an identifier is ABSENT must be allowed to
 * name that identifier once, to assert its absence -- naming it is not
 * reintroducing it. But that earns exactly the one identifier the file's own
 * assertion needs, nothing else: a file exempted wholesale could reintroduce
 * any OTHER retired identifier and this guard would stay green, which is the
 * same "closed while still half-present, nothing enumerated the remnants"
 * failure D-012 already produced once. See JUSTIFIED_SELF_REFERENCES below.
 */

/** Every identifier D-012's cleanup was responsible for retiring, checked independently. */
const RETIRED_IDENTIFIERS: { name: string; pattern: RegExp }[] = [
  { name: 'QuickAssessment', pattern: /QuickAssessment/ },
  { name: 'getQuickScore', pattern: /getQuickScore/ },
  { name: 'AssessmentMode', pattern: /AssessmentMode/ },
  { name: "'quick'", pattern: /['"]quick['"]/ },
  { name: 'badge--quick', pattern: /badge--quick/ },
];

/**
 * Per-file allowlist of the SPECIFIC retired identifiers a file may
 * legitimately name, and why. Widening this later requires naming a new
 * string here, not adding a path -- the exemption is visibly scoped to the
 * exact identifier earned.
 *
 *   - schema-shape.test.ts (Task 3, 2026-08-26) asserts `AssessmentMode` no
 *     longer exists as a Postgres type, which requires querying pg_type for
 *     the literal string "AssessmentMode". It has no legitimate reason to
 *     name any of the other four retired identifiers, so those still fail it.
 */
const JUSTIFIED_SELF_REFERENCES: Record<string, string[]> = {
  '__tests__/integration/schema-shape.test.ts': ['AssessmentMode'],
};

describe('quick assessment mode is gone', () => {
  it('leaves no source reference to quick mode', () => {
    // Task 3 (2026-08-26) dropped assessments.mode and the AssessmentMode
    // enum, so schema.prisma no longer legitimately declares it -- scope now
    // includes it. prisma/migrations/ stays excluded permanently: an applied
    // migration is immutable history, and the enum genuinely existed when
    // 20260629133510_init ran.
    //
    // This file itself is wholly exempt, not identifier-scoped like the map
    // above: the RETIRED_IDENTIFIERS list right here necessarily spells out
    // every one of them, which is self-evident from reading this file rather
    // than something that needs auditing per-identifier.
    const files = execSync('git ls-files app lib components e2e data __tests__ prisma/schema.prisma')
      .toString().trim().split('\n')
      .filter((f) => /\.(ts|tsx|js|jsx|json|css|sql|prisma)$/.test(f))
      .filter((f) => f !== '__tests__/lint/no-quick-mode.test.ts');
    const offenders: string[] = [];
    for (const f of files) {
      const src = execSync(`cat ${JSON.stringify(f)}`).toString();
      const allowed = new Set(JUSTIFIED_SELF_REFERENCES[f] ?? []);
      for (const { name, pattern } of RETIRED_IDENTIFIERS) {
        if (allowed.has(name)) continue;
        if (pattern.test(src)) offenders.push(`${f}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
