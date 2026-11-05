import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { e2eBaseURL } from '../../e2e/helpers/port';

/**
 * Every environment variable the app THROWS without must be one the CI `e2e`
 * job is GIVEN.
 *
 * The sibling `prod-env-completeness.test.ts` guards the same gap for the
 * production container. This one exists because the gap re-opened in CI, twice,
 * from two unrelated changes:
 *
 *   1. Closing open registration (D9) added a gate on a new setting.
 *      `/register` then rendered "Registration is by invitation" and no form,
 *      and 8 specs that drive that page went red.
 *   2. Fixing the dead invitation links added `lib/publicOrigin.ts`, which
 *      throws when neither AUTH_URL nor NEXTAUTH_URL is set. The invitation
 *      POST then 500'd with a non-JSON body and `two-orgs.spec.ts` failed on
 *      `SyntaxError: Unexpected end of JSON input` -- a message naming neither
 *      the variable nor the route.
 *
 * Both were invisible from either file alone, and neither surfaced as "you
 * forgot an environment variable". That is the shape AGENTS.md §3 describes:
 * an enforcement point and its trigger drifting apart. This is the mechanism
 * §0.4 asks for instead of remembering to keep two lists in step.
 *
 * The requirement is READ FROM THE SOURCE MODULE on every run, not written
 * down here -- a hand-copied list would need editing at exactly the moment
 * nobody remembers to.
 */

/**
 * The e2e job's env block, which Playwright merges into the server's env.
 *
 * Parsed directly rather than through a YAML library: when this was written
 * `js-yaml` was only a TRANSITIVE dependency (no `@types`, and nothing kept it
 * installed), so importing it could have made this guard fail for a reason
 * unrelated to what it guards. Since Task 18 it is a direct devDependency with a
 * local type shim, but this reader still works. The block is a flat `KEY: value` list, and `assertParsed` below
 * fails loudly if this ever stops finding it -- a silently-empty map would
 * make every assertion below vacuous.
 */
function e2eEnv(): Record<string, string> {
  const src = readFileSync('.github/workflows/ci.yml', 'utf-8').split('\n');
  const job = src.findIndex((l) => /^  test-e2e:\s*$/.test(l));
  expect(job, 'the `test-e2e` job should still exist in ci.yml').toBeGreaterThan(-1);

  // `env:` at the job's own level (4 spaces), not a step's.
  let i = src.findIndex((l, n) => n > job && /^    env:\s*$/.test(l));
  expect(i, 'the `test-e2e` job should still declare an env block').toBeGreaterThan(-1);

  const out: Record<string, string> = {};
  for (i += 1; i < src.length; i += 1) {
    const line = src[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    // Any line indented 6+ spaces belongs to the block; less ends it.
    if (!/^ {6}\S/.test(line)) break;
    const m = line.match(/^ {6}([A-Z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** Guards against a parser change quietly making every test below vacuous. */
function assertParsed(env: Record<string, string>): Record<string, string> {
  expect(
    Object.keys(env).length,
    'parsed no env keys from the test-e2e job -- the parser, not the workflow, is wrong',
  ).toBeGreaterThan(5);
  expect(env.DATABASE_URL, 'DATABASE_URL is known to be in this block').toBeTruthy();
  return env;
}

function e2eEnvKeys(): Set<string> {
  return new Set(Object.keys(assertParsed(e2eEnv())));
}

/**
 * The `process.env.X` names a module reads, generated from its source. A module
 * that starts reading a NEW variable fails this suite rather than silently
 * requiring something CI does not supply.
 */
function envReadsIn(file: string): string[] {
  const src = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  return [...new Set([...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
}

describe('the CI e2e job supplies what the app refuses to run without', () => {
  it('satisfies lib/publicOrigin.ts, which throws when its variables are unset', () => {
    const required = envReadsIn('lib/publicOrigin.ts');
    expect(required.length, 'publicOrigin should still read at least one env var').toBeGreaterThan(0);

    // `AUTH_URL ?? NEXTAUTH_URL` -- either satisfies it, so this is ANY, not ALL.
    const keys = e2eEnvKeys();
    expect(
      required.some((v) => keys.has(v)),
      `the e2e job sets none of ${required.join(' / ')}, so lib/publicOrigin.ts throws. `
        + 'The invitation POST then 500s with a non-JSON body and the failure surfaces '
        + 'as "Unexpected end of JSON input", naming neither the variable nor the route.',
    ).toBe(true);
  });


  it('points the public origin at the server Playwright actually drives', () => {
    // A syntactically valid but WRONG origin would let publicOrigin() succeed
    // and mint invitation links to a host the test browser never visits --
    // green suite, dead links, which is the defect publicOrigin exists to fix.
    const env = assertParsed(e2eEnv());
    const origin = env.AUTH_URL ?? env.NEXTAUTH_URL;
    // The base URL the CI job drives is the one the config computes from the
    // job's own environment with CI set (port 3000 unless the job sets
    // E2E_PORT), not a literal the config no longer holds. The assertion is
    // needed because ProcessEnv requires NODE_ENV here.
    const ciEnv: Record<string, string> = { ...env, CI: 'true' };
    expect(new URL(origin).origin).toBe(new URL(e2eBaseURL(ciEnv as NodeJS.ProcessEnv)).origin);
  });
});
