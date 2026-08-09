import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * The phase-exit review of this branch (2026-08-05) found two security
 * controls that were fully built, correctly reasoned about in ADR-0002, and
 * completely inert: `bumpSessionEpoch` (lib/auth/identity.ts) had zero
 * production callers, and `mustChangePassword` was read into the `Identity`
 * type and returned by `resolveIdentity` but nothing downstream ever
 * branched on it (the one place that used to — `proxy.ts` — read the flag
 * off a JWT claim ADR-0002 §3 had already removed from the token, so it
 * type-checked and silently evaluated to `undefined` forever).
 *
 * `port-completeness.test.ts` and `preauth-surface.test.ts` enumerate
 * SURFACES from disk (routes, exported functions) — neither would have
 * caught this, because both defects were fully-formed, exported,
 * correctly-typed surface. What was missing was a TRIGGER: something that
 * actually calls the exported guard, or actually branches on the flag it
 * reads. This suite enumerates triggers the same mechanical way
 * `org-context.test.ts`'s "OrgContext construction is enumerable" test
 * enumerates `createOrgContext`'s importers — from disk, on every run, so a
 * regression that quietly re-orphans either control fails a test, not a
 * future review.
 */

describe('bumpSessionEpoch has a production trigger', () => {
  it('is called from somewhere other than its own definition', () => {
    const hits = execSync(`grep -rl "bumpSessionEpoch" app lib --include=*.ts --include=*.tsx || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();

    // lib/auth/identity.ts is the definition — everything else is a real
    // caller. Pinned to the exact set (not just "non-empty") so a future
    // caller being REMOVED (e.g. the logout-everywhere route getting
    // refactored to bump the epoch some other way) is a conscious decision
    // that updates this test, not a silent regression back to zero callers.
    const callers = hits.filter((f) => f !== 'lib/auth/identity.ts');
    expect(callers).toEqual(['app/api/users/me/sessions/route.ts']);
  });
});

/**
 * Added fix round 4 (task-6-report.md, D-157), on a
 * `pr-review-toolkit:silent-failure-hunter` finding about the REACH of that
 * round's change rather than about the change itself.
 *
 * `hmrSingleton`'s memo (`lib/data/connection.ts`) became a process-wide
 * registry keyed by a bare string, and — this is the new part — it is now
 * active IN PRODUCTION. Before, production had no cross-call-site memo at
 * all: each call site got its own client from its own `create()`, so two
 * sites sharing a key was merely wasteful. Now the second caller silently
 * receives the FIRST caller's client, with its `create()` never invoked and
 * no error anywhere.
 *
 * That matters because the four keys do not all carry the same authority:
 * `appClient` is built on `APP_DATABASE_URL` (`makrai_app`, NOBYPASSRLS, the
 * RLS-enforced identity the whole tenant boundary depends on), while
 * `identityBaseClient` and `preauthClient` are built on `DATABASE_URL` — the
 * schema OWNER, which is BYPASSRLS. A key collision would substitute one for
 * the other, and `requireDatabaseUrl('APP_DATABASE_URL')` would never run.
 * `assertRestrictedIdentity` (`lib/data/tenant.ts`) backstops the dangerous
 * direction by throwing on `rolsuper`/`rolbypassrls`, so this is a latent
 * trap rather than a live hole — which is exactly the kind of thing that
 * should be held by a generated check instead of by whoever next adds a
 * caller remembering it.
 *
 * Generated from disk rather than hand-listed, per AGENTS.md §3: a
 * hand-written list that must be complete is a latent defect with a
 * timestamp on it.
 */
describe('hmrSingleton keys are unique across call sites', () => {
  it('no two hmrSingleton() call sites share a key', () => {
    const lines = execSync(
      `grep -rn "hmrSingleton(['\\"]" app lib --include=*.ts --include=*.tsx || true`,
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    const sites = lines.map((line) => {
      const key = /hmrSingleton\(\s*['"]([^'"]+)['"]/.exec(line)?.[1];
      return { line, key };
    });

    // Every matched call site must actually yield a key — otherwise the
    // regex has silently stopped matching the code's shape and this whole
    // test would pass by enumerating nothing.
    expect(sites.filter((s) => s.key === undefined)).toEqual([]);

    const keys = sites.map((s) => s.key as string);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);

    // Pinned to the exact set, not merely "all distinct", so that ADDING a
    // client is a conscious decision that updates this test — the moment to
    // ask which connection string it is built on and whether that authority
    // belongs behind that key.
    expect([...keys].sort()).toEqual([
      'appClient',
      'identityBaseClient',
      'identityDb',
      'preauthClient',
    ]);
  });
});

describe('mustChangePassword has a production trigger', () => {
  it('is read off a resolved Identity AND branched on, not merely carried through', () => {
    // Deliberately narrower than a bare `grep "mustChangePassword"`, which
    // would also match: (a) prose comments mentioning the flag by name
    // (noisy, grows over time, tells you nothing about enforcement), and
    // (b) the pass-through in `resolveIdentity`'s own return statement
    // (`mustChangePassword: user.mustChangePassword`), which is exactly the
    // shape of the original bug — the value was read from the database and
    // handed back, but nothing consumed it. `if (identity.mustChangePassword`
    // requires BOTH a conditional AND a read off the resolved `Identity`
    // value (never a raw JWT token, which is what `proxy.ts`'s dead branch
    // read instead — `token?.mustChangePassword` does not match this
    // pattern, correctly, because that branch never actually enforced
    // anything once the claim left the token).
    const matches = execSync(
      `grep -rn "if (identity.mustChangePassword" app lib --include=*.ts --include=*.tsx || true`,
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    // Two enforcement points today: requireIdentity() (pages -> redirect to
    // /change-password) and requireIdentityForApi() (routes -> 403). Both
    // belong to lib/auth/identity.ts, the ADR-0002 choke point — never to
    // proxy.ts, which cannot read this flag fresh on every request (see
    // proxy.ts's own module doc for why that split is architectural).
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((line) => line.startsWith('lib/auth/identity.ts:'))).toBe(true);
  });
});
