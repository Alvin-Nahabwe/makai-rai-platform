import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Every environment variable the production code READS must be one the
 * production container is GIVEN.
 *
 * Opened 2026-08-27 after a question about where to set `EMAIL_FROM_ADDRESS`
 * turned up three variables the app requires and `docker/docker-compose.prod.yml`
 * never passed: `APP_DATABASE_URL`, `RESEND_API_KEY` and `EMAIL_FROM_ADDRESS`.
 * The first is the serious one. `lib/data/connection.ts#requireDatabaseUrl`
 * THROWS when it is unset, deliberately, because `pg` would otherwise fall back
 * to `PG*` variables and libpq defaults "which can land on the schema owner and
 * bypass RLS entirely" (ADR-0001). So a container missing it starts cleanly and
 * then refuses every tenant-scoped query -- the refusal being the control
 * working, not a defect.
 *
 * None of that was visible from either file alone. It lives in the gap between
 * a `process.env` read and a compose `environment:` block, which is exactly the
 * shape AGENTS.md §3 describes: a control whose enforcement point and whose
 * trigger drifted apart. This is the mechanism §0.4 asks for in place of
 * remembering to keep two lists in step.
 *
 * The list is GENERATED from the source on every run rather than written down
 * here, per §3 -- a hand-written copy would be a latent defect with a timestamp
 * on it, and would need editing every time a new variable is introduced, which
 * is precisely the moment nobody remembers to.
 */

/** Variables the production runtime reads but the container must NOT be given. */
const JUSTIFIED_ABSENCES: Record<string, string> = {
  // next-auth resolves its secret as `AUTH_SECRET ?? NEXTAUTH_SECRET`
  // (verified against next-auth/lib/env.js, see lib/auth/secret.ts). Only the
  // NEXTAUTH_ name is set in this project, deliberately -- lib/auth/secret.ts
  // says so in terms. Passing both would create two names for one secret and
  // a way for them to disagree.
  AUTH_SECRET: 'alternative next-auth name for NEXTAUTH_SECRET, which IS passed',
};

/**
 * Strip comments before looking for reads. Without this the scan matches prose:
 * `lib/data/connection.ts:8` documents libpq's fallback behaviour and mentions
 * `process.env.USER` inside a doc comment, which is a description of what pg
 * does, not a read this application performs.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function productionSources(): string[] {
  return execSync('git ls-files app lib')
    .toString()
    .trim()
    .split('\n')
    .filter((f) => /\.(ts|tsx)$/.test(f));
}

/**
 * Two shapes, not one, and the second is the reason this test exists at all.
 *
 * A `process.env.NAME` scan alone MISSES `APP_DATABASE_URL` — the variable whose
 * absence silently disables tenant isolation — because it is never read that
 * way. `lib/data/connection.ts#requireDatabaseUrl(name)` reads `process.env[name]`
 * with the name passed in as an argument, so the literal appears at the CALL
 * site and the read appears in a different file. Written with one lens this
 * guard would have passed while missing exactly the variable that motivated it.
 *
 * `assertNoUnscannableReads` below is the backstop for the general case: any
 * NEW computed read this function does not understand fails the suite rather
 * than quietly shrinking the list.
 */
function productionEnvReads(): string[] {
  const found = new Set<string>();
  for (const f of productionSources()) {
    const src = stripComments(readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)) {
      if (m[1] === 'NODE_ENV') continue; // supplied by the runtime, not by us
      found.add(m[1]);
    }
    // Names reaching process.env[...] through this codebase's one such helper.
    for (const m of src.matchAll(/requireDatabaseUrl\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
      found.add(m[1]);
    }
  }
  return [...found].sort();
}

/** Every computed `process.env[...]` read the scan above knows how to resolve. */
const UNDERSTOOD_COMPUTED_READS = ['lib/data/connection.ts'];

function composeEnvKeys(): string[] {
  const yaml = readFileSync('docker/docker-compose.prod.yml', 'utf8');
  // The `nextjs` service's environment block, up to the next top-level key.
  const service = yaml.slice(yaml.indexOf('  nextjs:'), yaml.indexOf('  postgres:'));
  const env = service.slice(service.indexOf('environment:'));
  return [...env.matchAll(/^\s{6}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1]).sort();
}

describe('the production container is given every variable the code reads', () => {
  it('passes every process.env read in app/ and lib/ that is not justified as absent', () => {
    const reads = productionEnvReads();
    const passed = new Set(composeEnvKeys());
    const missing = reads.filter((k) => !passed.has(k) && !(k in JUSTIFIED_ABSENCES));

    expect(
      missing,
      missing.length === 0
        ? ''
        : `docker/docker-compose.prod.yml does not pass ${missing.join(', ')}, but production ` +
          `code reads them. A container without them starts cleanly and fails at the first ` +
          `request that needs one -- which is the worst moment to find out. Add each to the ` +
          `nextjs service's environment: block as \${NAME}, add it to .env.example and to the ` +
          `deployment runbook's .env template, or record it in JUSTIFIED_ABSENCES above with ` +
          `the reason it must NOT reach the container.`,
    ).toEqual([]);
  });

  it('reads something, so a scan that silently found nothing fails instead of passing', () => {
    // Guards the shape D-216 catalogues: an assertion that holds vacuously
    // because its input was empty. If the git ls-files call or either regex
    // ever stops matching, the test above would pass by finding no reads at
    // all. This fired for real on first run -- the count came back at exactly
    // 3, which is what led to noticing that APP_DATABASE_URL was invisible to
    // a `process.env.NAME` scan.
    expect(productionEnvReads().length).toBeGreaterThan(3);
    expect(composeEnvKeys().length).toBeGreaterThan(3);
  });

  it('finds no computed process.env read it cannot resolve', () => {
    // The scan above understands `process.env.NAME` and one helper that takes
    // the name as an argument. A new `process.env[someVar]` elsewhere would be
    // invisible to it, and the failure mode is silent: the list shrinks and
    // the first test still passes. Fail loudly instead, and make whoever adds
    // one teach this file how to read it.
    const offenders = productionSources().filter(
      (f) =>
        !UNDERSTOOD_COMPUTED_READS.includes(f) &&
        /process\.env\s*\[/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(
      offenders,
      `these files read process.env with a computed key, which the completeness ` +
        `scan cannot follow: ${offenders.join(', ')}. Either read the variable by ` +
        `its literal name, or teach productionEnvReads() to resolve this shape and ` +
        `add the file to UNDERSTOOD_COMPUTED_READS.`,
    ).toEqual([]);
  });
});
