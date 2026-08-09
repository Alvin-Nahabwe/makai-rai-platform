import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

/**
 * D-184. `AssessmentPageClient.tsx`'s evidence mount effect used to call the
 * shared `fetchEvidence` `useCallback` bare, synchronously, at the top of a
 * `useEffect` body. `react-hooks/set-state-in-effect` flags that shape
 * because its static analysis can prove the callee sets state — but does
 * not follow the same call through a NEW nested function boundary. Fixed by
 * wrapping the call in a local `function run() { fetchEvidence(); } run();`,
 * without changing `fetchEvidence` itself in any way.
 *
 * This repo has no jsdom/`@testing-library/react` (D-169), so this
 * hook-bearing component cannot be rendered and its effect cannot be
 * observed directly by `vitest` at all. The only thing that can pin "this
 * exact regression does not recur" is running the REAL rule against the
 * REAL file — matching `__tests__/lint/effective-config.test.ts`'s own
 * technique of shelling out to `eslint` rather than reimplementing its
 * logic (a hand-rolled regex proxy for a React-Compiler-based static
 * analysis rule would drift from the rule's actual behaviour).
 *
 * Non-vacuity proven by hand, not merely claimed: temporarily reverted this
 * file's effect back to the bare `fetchEvidence();` shape and re-ran this
 * test — it failed, reporting `react-hooks/set-state-in-effect` at the
 * effect's location, for the expected reason. Restored the fix and re-ran —
 * passed. Full transcript in the D-184 register row and the C6
 * lint-and-flake report.
 */
const FILE = 'app/(authenticated)/orgs/[slug]/assessment/[id]/AssessmentPageClient.tsx';

describe('AssessmentPageClient.tsx lints clean (D-184 regression)', () => {
  it('produces zero eslint errors — in particular, no react-hooks/set-state-in-effect on the evidence mount effect', () => {
    let output = '';
    let exitCode = 0;
    try {
      output = execFileSync('npx', ['eslint', FILE], { encoding: 'utf8' });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      exitCode = err.status ?? 1;
      output = String(err.stdout ?? '') + String(err.stderr ?? '');
    }
    expect(exitCode, output).toBe(0);
  });
});
