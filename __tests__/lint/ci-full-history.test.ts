import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { expect, it } from 'vitest';

/**
 * The spec-12 gate (`protected-tests.test.ts`, `test-replacements.test.ts`) reads files at the tag `stage-1-base`
 * with `git show`. A depth-1 checkout has neither the tag nor the commit, so every job in `ci.yml` that runs vitest
 * must check out the full history (`fetch-depth: 0`, which also fetches tags).
 */

type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const workflow = loadYaml(readFileSync('.github/workflows/ci.yml', 'utf8')) as Workflow;

it('every job in ci.yml that runs vitest checks out the full history', () => {
  const runners = Object.entries(workflow.jobs).filter(([, job]) => (job.steps ?? []).some((s) => /\bvitest\b/.test(s.run ?? '')));
  expect(runners.map(([name]) => name), 'at least the unit job runs vitest').toContain('unit');
  for (const [name, job] of runners) {
    const checkout = (job.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/checkout@'));
    expect(checkout, `job "${name}" runs vitest and must have an actions/checkout step`).toBeDefined();
    expect(checkout?.with?.['fetch-depth'], `job "${name}" runs vitest: its checkout needs fetch-depth: 0 for the tag stage-1-base`).toBe(0);
  }
});
