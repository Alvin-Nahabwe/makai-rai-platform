import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PENDING_ROUTES } from '../../lib/authz/routeActions';

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
 * `identityBaseClient` and `preauthClient` are built on `IDENTITY_DATABASE_URL`
 * (`makrai_identity`, ADR-0009: no tenant record table, but every organisation,
 * membership and invitation unscoped). A key collision would substitute one for
 * the other, and `requireDatabaseUrl('APP_DATABASE_URL')` would never run.
 * `assertUnprivilegedRole` (`lib/data/connection.ts`, run by `withOrg` and at
 * server start) refuses a superuser or BYPASSRLS role on either lane, but both
 * lanes are unprivileged, so it cannot tell them apart; this is a latent trap
 * rather than a live hole — which is exactly the kind of thing that should be
 * held by a generated check instead of by whoever next adds a caller
 * remembering it. The second test below pins which URL each key is built on.
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
      // v0.6.0 (lib/data/identityClient.ts): the identity lane for the definer wrappers,
      // the reminder reads and ORG's administrator reads, importable from three files only.
      'identityLaneClient',
      'preauthClient',
    ]);
  });

  /**
   * ADR-0009 moved two of these keys off the owner's `DATABASE_URL`. Pinned per key,
   * generated from each call site's own `create` function, so pointing a client at a
   * different lane — or back at the owner — is a change this test makes someone see.
   * `identityDb` has no URL of its own: it is built over `identityBaseClient`.
   */
  it('builds each key on the URL its lane is meant to use', () => {
    const files = execSync(`grep -rl "hmrSingleton(['\\"]" app lib --include=*.ts --include=*.tsx || true`)
      .toString().trim().split('\n').filter(Boolean);
    const urlsByKey: Record<string, string[]> = {};
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/hmrSingleton\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const [, key, createFn] = m;
        // The create function's body: from its declaration to the first line that is
        // a lone closing brace at column 0.
        const body = new RegExp(`function ${createFn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1];
        expect(body, `${file}: cannot find the body of ${createFn} for key ${key}`).toBeDefined();
        urlsByKey[key] = [...(body as string).matchAll(/requireDatabaseUrl\(\s*['"]([A-Z_]+)['"]/g)].map((u) => u[1]);
      }
    }
    expect(urlsByKey).toEqual({
      appClient: ['APP_DATABASE_URL'],
      identityBaseClient: ['IDENTITY_DATABASE_URL'],
      identityDb: [],
      identityLaneClient: ['IDENTITY_DATABASE_URL'],
      preauthClient: ['IDENTITY_DATABASE_URL'],
    });
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

/**
 * Task 11 (O-11), Plan 1c's own backstop task. The six describe blocks below
 * follow from the SAME failure this file's header names — a control fully
 * built, correctly typed, exported, and reachable from nowhere — transplanted
 * onto the evidence feature Tasks 1-10 shipped. Enumerated fresh from this
 * task's own reading of the tree (task-11-brief.md names five candidates as a
 * starting point, not a final list — task-11-report.md records what was
 * added, what was considered and left out, and why).
 *
 * Each entry answers this file's own question for the guard it names: does
 * this have a production caller, and would this test notice if it lost one?
 * Each was proven non-vacuous per the standard this phase settled on
 * (task-11-report.md): the production caller removed, the specific entry
 * confirmed red, restored, confirmed green.
 */

describe('record:read and evidence:create have production enforcement points (O-10, O-17)', () => {
  // `lib/authz/policy.ts` DECLARES these two actions (the `Action` union
  // and `GRANTS`) and `lib/authz/routeActions.ts` MAPS each route to one of
  // them — both are already exhaustively tested elsewhere
  // (`__tests__/authz/policy.test.ts`'s full role x action matrix;
  // `port-completeness.test.ts`'s "every route declares an action" check).
  // NEITHER proves a route HANDLER actually calls
  // `requireOrgContext`/`requireOrgContextWithIdentity` with the action
  // `ROUTE_ACTIONS` says it should — that is a third, independent fact, and
  // it is exactly the fact `bumpSessionEpoch`'s own absence (above) proves
  // can go missing silently while every declarative layer still looks
  // complete.
  //
  // `(requireOrgContext|requireOrgContextWithIdentity)\(slug, 'evidence:read'\)`
  // matches only the route-level gate this describe block is about — the
  // ONE call shape `ROUTE_ACTIONS` (lib/authz/routeActions.ts) claims every
  // org-scoped route makes. A first draft used the looser `, 'evidence:read')`
  // (comma, space, quoted action, close-paren) and it double-counted: Task
  // 11's own `orgContextsForUser` (lib/auth/context.ts, added by this same
  // task for O-12) legitimately calls `can(m.role, 'evidence:read')` — a
  // REAL, but DIFFERENT, consultation of the same action (a defense-in-depth
  // filter over a cross-org read, not the route gate `ROUTE_ACTIONS` maps —
  // see that function's own doc comment) — and its own doc comment happens
  // to quote that exact call shape a second time in prose. Both are correct
  // code; the looser pattern was simply answering a broader question than
  // this describe block's own header claims to answer. Caught by running
  // `npx vitest run` over the WHOLE suite, not just this file, after O-12 was
  // implemented — exactly the reason this file's tests get re-run against the
  // full tree rather than trusted from when they were first written.
  // The child gets NO_COLOR=1 and no FORCE_COLOR, and escape sequences are stripped, so a colour setting in
  // the environment cannot change the file names compared below (round 13, R13-2).
  const { FORCE_COLOR: _forceColour, ...plainEnv } = process.env;
  function callers(action: string): string[] {
    return execSync(
      `grep -rnE "(requireOrgContext|requireOrgContextWithIdentity)\\(slug, '${action}'\\)" app lib --include=*.ts || true`,
      { env: { ...plainEnv, NO_COLOR: '1' } },
    )
      .toString()
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(':')[0])
      .sort();
  }

  // v0.6.0: FR-AUTHZ-02 deleted `evidence:read` (replaced by `record:read`) and `evidence:delete` (the DELETE
  // method is a 404 handler, REMOVED_METHODS), so neither is an Action any more and the type checker refuses a
  // gate that names one; __tests__/authz/dead-actions.test.ts holds every source file to that. `evidence:create`
  // stays, consulted by the project upload route (EVD fills it).
  it('evidence:create is consulted by the project upload route', () => {
    expect(callers('evidence:create')).toEqual(['app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts']);
  });

  it('record:read is consulted by the single-item evidence route', () => {
    expect(callers('record:read')).toContain('app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts');
  });
});

describe('assertSameOrigin has a production caller in every write route (NFR-SEC-08)', () => {
  // The cross-origin check is a guard no handler is forced to call: a write route that forgets it still
  // type-checks and answers. Enumerated from disk: every route file still in PENDING_ROUTES that exports a
  // write handler must call it (a producer keeps the call when it fills the body), and at least one
  // production file calls it at all.
  // The child gets NO_COLOR=1 and no FORCE_COLOR, and escape sequences are stripped, so a colour setting in the
  // environment cannot change the file names compared below.
  const { FORCE_COLOR: _force, ...plainEnv } = process.env;
  const callingFiles = execSync(`grep -rlE "assertSameOrigin\\(" app --include=*.ts || true`, { env: { ...plainEnv, NO_COLOR: '1' } })
    .toString().replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean);

  it('some production route calls assertSameOrigin', () => {
    expect(callingFiles.length).toBeGreaterThan(0);
  });

  it('every pending route with a write handler calls it', () => {
    const missing = PENDING_ROUTES.filter((f) =>
      /export async function (POST|PATCH|DELETE|PUT)\b/.test(readFileSync(f, 'utf8')) && !callingFiles.includes(f));
    expect(missing).toEqual([]);
  });
});

describe('O-14 drift check (resolveFramework(...).matches) has its production triggers', () => {
  /**
   * `completeAssessment` shipped WITHOUT this check in fix round 1 (D-165,
   * task-9-report.md) — a Critical, coordinator-found gap caught only by a
   * human re-review of a diff, not by any mechanical check; the original
   * scoping enumerated `respondToAssessment` alone and missed its sibling
   * write path entirely. This is that mechanical check: it enumerates, from
   * disk, every production site that reads `resolveFramework(...).matches`
   * AND branches on it, and pins the exact set — so a refactor that silently
   * drops the check from any ONE of the three (e.g. consolidating
   * `respondToAssessment`/`completeAssessment` and keeping only one copy)
   * fails a test instead of reproducing exactly the gap fix round 2 closed.
   *
   * `if (!resolution.matches)` is deliberately narrower than a bare
   * `resolveFramework(` grep, which would also match
   * `assessments/[id]/route.ts`'s GET handler — that call reads `.matches`
   * only to DISPLAY it in the report's provenance line, never to reject a
   * write, and counting it here would hide a regression in one of the four
   * real guards behind a call that never guarded anything (the same "read
   * vs. read-AND-branched-on" distinction the `mustChangePassword` test
   * above already draws for an unrelated flag).
   *
   * C6 whole-branch review, F5 — THE FOURTH SITE, and the reason this
   * comment's own reasoning was not enough. Every entry here was derived
   * from one lens: "which functions WRITE to an existing assessment?"
   * `POST .../assessments` writes the assessment INTO existence, so it was
   * outside that lens and outside this pin — and it duly shipped without a
   * drift check, resolving a version to pin by semver string alone. This
   * is exactly AGENTS.md §3's decomposition rule (generate the list again
   * from a different property; vary the ROOT, not only the predicate): the
   * second property is "which routes cause an assessment row to carry a
   * `frameworkVersionId`", and it reaches the create route that the first
   * one structurally could not. `resolveCurrentFramework` was given the
   * same `FrameworkResolution` return shape as `resolveFramework`
   * specifically so the new site would be visible to this grep rather than
   * needing a second, separately-maintained one.
   *
   * NOTE, found by this very fix: the grep is over SOURCE TEXT, so a
   * COMMENT quoting the guard line verbatim counts as a hit. Two doc
   * comments written alongside the fourth site did exactly that and turned
   * this expectation into six entries. Deliberately NOT "solved" by
   * teaching the grep to skip comment lines -- that is a second thing to
   * maintain, and this failure mode is loud, immediate and self-explaining
   * (the actual-vs-expected diff names the offending file). If you need to
   * quote the idiom in prose, write it without the `if (` prefix.
   */
  it('gates no site now that the assessment write paths and the upload route are removed — and no others', () => {
    const hits = execSync(`grep -rn "if (!resolution.matches)" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();

    // The four sites this pin used to list (respondToAssessment,
    // completeAssessment, the evidence upload route, assessment creation) are
    // deleted. A new site that branches on drift has to be declared here.
    expect(hits.map((h) => h.split(':')[0])).toEqual([]);
  });
});

describe('withDerivedEvidenceLevel has its documented production call site (O-20)', () => {
  /**
   * `lib/data/evidence.ts`'s own doc comment on this function asserts
   * "Every one of the four JSON-API routes that serialize a RemediationItem
   * ... routes through this" — a prose claim of exactly the shape AGENTS.md
   * §3 warns is a latent defect once nothing regenerates it. Pinned here
   * mechanically instead of trusted: a future route added under D-164's own
   * warning (a FIFTH direct RemediationItem query, wired to
   * `EVIDENCE_COUNT_INCLUDE` but never plumbed through this function) would
   * ship a RemediationItem whose `evidenceLevel` silently exposes the raw
   * `_count` shape instead of the derived enum, or omits the field entirely —
   * exactly the "same item, different evidenceLevel depending on which
   * endpoint served it" defect O-20 exists to close.
   */
  it('is called from project-detail GET only — the remediation and assessment-detail routes were removed', () => {
    const hits = execSync(
      `grep -rn "withDerivedEvidenceLevel" app lib --include=*.ts --include=*.tsx || true`,
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);

    const parsed = hits.map((line) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) throw new Error(`grep -n output did not parse as file:line:content -- "${line}"`);
      return { file: m[1], content: m[3] };
    });

    // The definition file names itself in its own export line and its own
    // doc comment; import statements name it without invoking it. A real
    // call site is what remains — either a direct call or a bare reference
    // passed to `.map(...)`.
    const callSites = parsed.filter(({ file, content }) => {
      const trimmed = content.trim();
      if (file === 'lib/data/evidence.ts') return false;
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
      if (trimmed.startsWith('import')) return false;
      return true;
    });

    // Non-vacuity: the filter must actually discriminate SOMETHING (the
    // three import lines and the definition file's own two self-mentions),
    // not merely echo its input back unfiltered.
    expect(parsed.length).toBeGreaterThan(callSites.length);

    expect(callSites.map((c) => c.file).sort()).toEqual([
      'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
    ]);
  });
});

describe('the evidence byte inspector (O-7) and its pre-buffer size gate have production callers', () => {
  it('inspect() has no caller until the project upload route exists (the assessment upload route was removed)', () => {
    const hits = execSync(`grep -rn "inspect(" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) throw new Error(`grep -n output did not parse -- "${line}"`);
        const [, file, , content] = m;
        const trimmed = content.trim();
        return file !== 'lib/evidence/inspect.ts' && !trimmed.startsWith('//') && !trimmed.startsWith('*');
      });

    // The EVD unit adds the project upload route and lists it here.
    expect(hits.map((h) => h.split(':')[0])).toEqual([]);
  });

  /**
   * `inspect()`'s own `MAX_BYTES` check (lib/evidence/inspect.ts) only ever
   * runs AFTER the body is fully buffered — a size LIMIT, not a DoS control,
   * by that file's own module doc. The upload route's SEPARATE, EARLIER
   * Content-Length check is what that doc calls "responsible for gating size
   * before buffering" — a second, independent guard, not a duplicate of the
   * first (D-152). Pinned separately so a refactor that deleted the
   * pre-buffer gate (leaving only `inspect()`'s post-buffer one — still
   * correct for REJECTING an oversized file, but no longer correct for
   * avoiding the allocation in the first place) fails HERE rather than
   * nowhere.
   */
  it("MAX_BYTES has no pre-buffer Content-Length gate until the project upload route exists", () => {
    const hits = execSync(`grep -rn "> MAX_BYTES" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) throw new Error(`grep -n output did not parse -- "${line}"`);
        const [, file, , content] = m;
        const trimmed = content.trim();
        return file !== 'lib/evidence/inspect.ts' && !trimmed.startsWith('//') && !trimmed.startsWith('*');
      });

    // The EVD unit adds the project upload route and lists it here.
    expect(hits.map((h) => h.split(':')[0])).toEqual([]);
  });
});

describe('questionExistsInBank (O-22) has a production caller', () => {
  /**
   * Own addition beyond task-11-brief.md's five-item starting list
   * (task-11-report.md explains why): structurally identical to `inspect()`
   * above — a pure, exported, single-call-site guard whose removal would be
   * SILENT rather than loud. O-2's database CHECK proves exactly one attach
   * target is ever stored; it says nothing about whether a `questionId`
   * target actually exists in the pinned framework's bank. Losing this call
   * would not break a single existing upload — it would just stop rejecting
   * a garbage `questionId`, exactly the "still looks like it works" shape
   * every other entry in this file targets.
   */
  it('has no caller until the project upload route exists (the assessment upload route was removed)', () => {
    const hits = execSync(`grep -rn "questionExistsInBank(" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('lib/data/evidence.ts:'));

    // The EVD unit adds the project upload route and lists it here.
    expect(hits.map((h) => h.split(':')[0])).toEqual([]);
  });
});
