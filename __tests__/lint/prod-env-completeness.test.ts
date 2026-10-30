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
  // Same shape, same reason, one layer up. `lib/auth/secureCookie.ts` reads
  // `AUTH_URL ?? NEXTAUTH_URL` because that is @auth/core's own precedence
  // (`@auth/core/lib/utils/env.js:68`), and the whole point of that helper is
  // that it cannot disagree with the library about which cookie holds the
  // session. Mirroring the precedence is therefore correct.
  //
  // Passing it to the container would not be. Only the NEXTAUTH_ name is set
  // in this project, deliberately; supplying both would create two names for
  // one value and a way for them to drift, which is the failure this list
  // exists to prevent for AUTH_SECRET directly above.
  AUTH_URL: 'alternative next-auth name for NEXTAUTH_URL, which IS passed',
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
  // Tracked AND not-yet-tracked. `git ls-files` alone lists only tracked files,
  // which made this guard blind at the exact moment it is most needed: when a
  // NEW file introduces a NEW variable. Demonstrated 2026-08-30 --
  // `lib/auth/openRegistration.ts` was created, the full suite was run and
  // passed, and only after the commit did this test notice that
  // `ALLOW_OPEN_REGISTRATION` never reached the container. The check ran, the
  // suite was green, and the variable was invisible.
  //
  // `--others --exclude-standard` adds untracked files while still honouring
  // .gitignore, so build output and node_modules stay out.
  const tracked = execSync('git ls-files app lib').toString();
  const untracked = execSync('git ls-files --others --exclude-standard app lib').toString();
  return [...new Set((tracked + untracked).trim().split('\n'))]
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

/** The `nextjs` service's text, up to the next top-level key. */
function nextjsService(): string {
  const yaml = readFileSync('docker/docker-compose.prod.yml', 'utf8');
  return yaml.slice(yaml.indexOf('  nextjs:'), yaml.indexOf('  postgres:'));
}

/** The `nextjs` service's environment block as KEY -> value text. */
function composeEnv(): Record<string, string> {
  const service = nextjsService();
  const env = service.slice(service.indexOf('environment:'));
  return Object.fromEntries(
    [...env.matchAll(/^\s{6}([A-Z_][A-Z0-9_]*):(.*)$/gm)].map((m) => [m[1], m[2].trim()]),
  );
}

function composeEnvKeys(): string[] {
  return Object.keys(composeEnv()).sort();
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

  /**
   * ADR-0009, obligation P1: the web process holds no superuser credential. The owner
   * role's password reaches a container only through this file, so the property is a
   * statement about the `nextjs` block: no `DATABASE_URL`, no value built from
   * `POSTGRES_PASSWORD`, and no `env_file:` that would hand over the whole `.env`
   * behind the block's back. The identity lane has its own unprivileged URL instead.
   */
  it('gives the web container no owner-role connection', () => {
    const env = composeEnv();
    expect(Object.keys(env)).not.toContain('DATABASE_URL');
    expect(Object.entries(env).filter(([, v]) => v.includes('POSTGRES_PASSWORD'))).toEqual([]);
    expect(nextjsService()).not.toMatch(/^\s{4}env_file:/m);
    expect(env.IDENTITY_DATABASE_URL).toBe('${IDENTITY_DATABASE_URL}');
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

/**
 * The suite above reads `app/` and `lib/` -- FIRST-PARTY code only. It therefore
 * cannot see the variable whose absence is a guaranteed production outage,
 * because nothing in this repository reads it: `AUTH_TRUST_HOST` is consumed by
 * @auth/core, inside node_modules.
 *
 * This is the APP_DATABASE_URL shape again, arriving from the other direction.
 * There, the read was inside our tree but written in a form one lens could not
 * see. Here it is written in the most ordinary form there is and simply lives
 * outside the tree we searched. AGENTS.md §3 names exactly this: "vary the
 * search ROOT, not only the predicate" -- and `node_modules` is the root the
 * first version of this file never left `app/` and `lib/` to reach.
 *
 * Found as DEP-03 by the 2026-08-17 platform audit, which reproduced it live and
 * rated it Critical. It was never converted into a register row, and was still
 * unfixed twelve days later with a production deploy in progress.
 */
const REQUIRED_BY_DEPENDENCIES: Record<string, string> = {
  // @auth/core computes its trustHost default as
  //   !!(AUTH_URL ?? AUTH_TRUST_HOST ?? VERCEL ?? CF_PAGES ?? NODE_ENV !== "production")
  // (node_modules/@auth/core/lib/utils/env.js:40-44). The runner image sets
  // NODE_ENV=production (docker/Dockerfile:33) and none of the others, so
  // trustHost resolves FALSE and assertConfig returns UntrustedHost for every
  // auth request (node_modules/@auth/core/lib/utils/assert.js:56-58). Login is
  // not degraded, it is impossible. CI reproduced this against a real
  // `npm run build && npm run start`: /api/auth/csrf returned HTTP 500 without
  // the variable and HTTP 200 with it (.github/workflows/ci.yml:288-311).
  // Note the expression reads AUTH_URL, NOT NEXTAUTH_URL -- so the NEXTAUTH_URL
  // this project already passes does not satisfy it.
  AUTH_TRUST_HOST:
    '@auth/core trustHost default; without it every auth request throws UntrustedHost',
};

describe('variables required by production dependencies rather than by our own code', () => {
  it('passes every variable a dependency requires even when no app/ or lib/ file reads it', () => {
    const passed = new Set(composeEnvKeys());
    const missing = Object.keys(REQUIRED_BY_DEPENDENCIES).filter((k) => !passed.has(k));

    expect(
      missing,
      missing.length === 0
        ? ''
        : `docker/docker-compose.prod.yml does not pass ${missing.join(', ')}. A dependency ` +
          `reads these, not app/ or lib/, so the first-party scan above is structurally blind ` +
          `to them: ` +
          missing.map((k) => `${k} -- ${REQUIRED_BY_DEPENDENCIES[k]}`).join('; '),
    ).toEqual([]);
  });

  it('never tells auth to trust the Host header without also pinning the canonical origin', () => {
    // AUTH_TRUST_HOST=true stops @auth/core rejecting requests by Host. That is
    // only safe because createActionURL prefers a pinned origin and falls back to
    // x-forwarded-host/host ONLY when neither AUTH_URL nor NEXTAUTH_URL is set
    // (node_modules/@auth/core/lib/utils/env.js:66-86). The two settings are a
    // PAIR: trust-the-host with no pinned origin means every callback URL and
    // every emailed link is built from an attacker-suppliable header.
    //
    // nginx closes most of this off: the default_server in
    // docker/nginx/default.conf drops any request whose Host is not makrai.org.
    // That is one layer, and this pair is the other. `proxy_set_header Host $host`
    // forwards the Host verbatim, so a request that reached the makrai.org server
    // under another Host (the default block removed, or a name added to the
    // server) would hand the app the attacker's value.
    //
    // Nothing else in the tree states this dependency. Without this test,
    // deleting NEXTAUTH_URL is a one-line change with no visible consequence.
    const passed = new Set(composeEnvKeys());
    const trustsHost = passed.has('AUTH_TRUST_HOST');
    const pinsOrigin = passed.has('NEXTAUTH_URL') || passed.has('AUTH_URL');

    expect(
      !trustsHost || pinsOrigin,
      `docker/docker-compose.prod.yml passes AUTH_TRUST_HOST but pins no canonical origin. ` +
        `@auth/core will then derive every auth URL from the x-forwarded-host/host header, ` +
        `which reaches the container unfiltered. Pass NEXTAUTH_URL (or AUTH_URL) as well, or ` +
        `stop passing AUTH_TRUST_HOST.`,
    ).toBe(true);
  });
});
