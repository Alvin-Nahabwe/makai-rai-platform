import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * D-422: the chromium e2e suite runs in parallel shards, one job each, so the e2e check no longer takes ~60 minutes on
 * one worker. Each shard has its own Postgres service and builds its own fixture (the steps are the job's own). Playwright
 * is given the total from `strategy.job-total`, so changing the matrix cannot drop a slice of the specs. The
 * single-run steps (the idle sign-out spec and the nginx-in-front specs) run on one shard only. An aggregate job named
 * `e2e` keeps the check name branch protection has required since D-203, and is green only when every shard is.
 */

interface Step { name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  strategy?: { 'fail-fast'?: boolean; matrix?: { shard?: number[] } };
  steps: Step[];
}

const ci = load(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> };
const shards = ci.jobs['test-e2e'];
const step = (name: string) => shards.steps.find((s) => s.name === name);

describe('D-422: the chromium e2e suite is sharded across jobs', () => {
  it('the test-e2e job is a matrix of shards 1..N (N > 1) that do not cancel one another', () => {
    const list = shards.strategy?.matrix?.shard ?? [];
    expect(list.length).toBeGreaterThan(1);
    expect(list).toEqual(Array.from({ length: list.length }, (_, i) => i + 1));
    expect(shards.strategy?.['fail-fast']).toBe(false);
    expect(shards.name).toBe('e2e (shard ${{ matrix.shard }}/${{ strategy.job-total }})');
  });

  it('the suite step runs this job’s shard, out of the matrix total', () => {
    expect(step('Run e2e suite')?.run?.trim()).toBe(
      'npx playwright test --project=chromium --no-deps --fail-on-flaky-tests --workers=1 --shard=${{ matrix.shard }}/${{ strategy.job-total }}',
    );
  });

  it('the idle sign-out and nginx-in-front steps run on exactly one shard, one that exists', () => {
    const list = shards.strategy?.matrix?.shard ?? [];
    const conds = ['Run the idle sign-out test (RF-3)', 'Pull the nginx image the nginx-in-front run pins', 'Run the sign-in specs with nginx in front']
      .map((n) => step(n)?.if);
    const k = /^matrix\.shard == (\d+)$/.exec(conds[0] ?? '')?.[1];
    expect(k, 'the idle step names one shard').toBeDefined();
    expect(list).toContain(Number(k));
    expect(conds).toEqual(conds.map(() => `matrix.shard == ${k}`));
  });

  it('each shard uploads its report under a name of its own', () => {
    const up = step('Upload Playwright report');
    expect(up?.with?.name).toBe('playwright-report-shard-${{ matrix.shard }}');
  });

  it('an aggregate job named e2e waits for every shard and passes only when all of them passed', () => {
    const agg = ci.jobs.e2e;
    expect(agg?.name).toBe('e2e');
    expect(agg.needs).toEqual(['test-e2e']);
    expect(agg.if).toBe('always()');
    expect(agg.steps).toHaveLength(1);
    expect(agg.steps[0].env).toEqual({ RESULT: '${{ needs.test-e2e.result }}' });
    // The result reaches the script through env, never interpolated into it.
    expect(agg.steps[0].run).not.toContain('${{');
    expect(agg.steps[0].run).toContain('[ "$RESULT" = success ]');
  });
});
