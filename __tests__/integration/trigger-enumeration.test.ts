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

describe('evidence:read / evidence:create / evidence:delete have production enforcement points (O-10, O-17)', () => {
  // `lib/authz/policy.ts` DECLARES these three actions (the `Action` union
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
  function callers(action: string): string[] {
    return execSync(
      `grep -rnE "(requireOrgContext|requireOrgContextWithIdentity)\\(slug, '${action}'\\)" app lib --include=*.ts || true`,
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(':')[0])
      .sort();
  }

  it('evidence:read is consulted by both the list route and the single-item route', () => {
    expect(callers('evidence:read')).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
      'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts',
    ]);
  });

  it('evidence:create is consulted by exactly the upload route', () => {
    expect(callers('evidence:create')).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
    ]);
  });

  it('evidence:delete is consulted by exactly the single-item DELETE route', () => {
    expect(callers('evidence:delete')).toEqual([
      'app/api/v1/orgs/[slug]/evidence/[evidenceId]/route.ts',
    ]);
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
   * write, and counting it here would hide a regression in one of the three
   * real guards behind a call that never guarded anything (the same "read
   * vs. read-AND-branched-on" distinction the `mustChangePassword` test
   * above already draws for an unrelated flag).
   */
  it('gates respondToAssessment, completeAssessment, and the evidence upload route — and no others', () => {
    const hits = execSync(`grep -rn "if (!resolution.matches)" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .sort();

    expect(hits.map((h) => h.split(':')[0])).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
      'lib/data/assessments.ts',
      'lib/data/assessments.ts',
    ]);
  });
});

describe('assessments.frameworkVersionId application-level write-once backstop (O-3)', () => {
  /**
   * The DATABASE half of O-3 —
   * `trg_assessments_framework_version_write_once`
   * (prisma/migrations/20260807102031_framework_registry_and_pin/migration.sql:63-77)
   * — already has its own live, non-vacuous, fires-when-broken-proven test
   * (`framework-registry.test.ts`'s "trg_assessments_framework_version_write_once
   * (O-3)" describe block, added task-review fix round 3: the trigger was
   * dropped and the test was confirmed to go red, then restored). That test
   * IS this guard's "production trigger" proof in the sense every other
   * entry in this file uses the phrase — a DATABASE TRIGGER has no
   * application-level caller to lose; it fires unconditionally on any UPDATE
   * that touches the column, so a grep for "who calls it" would be vacuous
   * by construction (nothing ever calls a trigger; Postgres does).
   *
   * What CAN silently regress is the OTHER half: today nothing ever
   * attempts to update `frameworkVersionId` at all. `respondToAssessment`
   * and `completeAssessment` (lib/data/assessments.ts) are the only two
   * functions anywhere in the app with a `tx.assessment.update(` call, and
   * both write only `engineState`/`status`/`reportData`/`overallScore`/
   * `completedAt`. If a future change ever added `frameworkVersionId` to one
   * of those `data:` objects, the DB trigger would still reject it — but
   * only as an unhandled 500 at request time. This test catches the attempt
   * at the SOURCE, before it ships: the same "catch it earlier, in a source
   * grep rather than a runtime error" relationship every other backstop in
   * this file has to the failure it targets.
   */
  it('lib/data/assessments.ts — home of every tx.assessment.update( call — never references frameworkVersionId', () => {
    const updateSites = execSync(`grep -n "\\.assessment\\.update(" lib/data/assessments.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    // Non-vacuity: this test is watching a file that must actually HAVE
    // update call sites, or "never references frameworkVersionId" would be
    // trivially true of an empty or irrelevant file.
    expect(updateSites.length).toBe(3);

    const mentions = execSync(`grep -n "frameworkVersionId" lib/data/assessments.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(mentions).toEqual([]);
  });
});

describe('withDerivedEvidenceLevel has its documented four production call sites (O-20)', () => {
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
  it('is called from remediation GET, remediation PATCH, assessment-detail GET, and project-detail GET — and nowhere else', () => {
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
      'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts',
      'app/api/v1/orgs/[slug]/assessments/[id]/remediation/route.ts',
      'app/api/v1/orgs/[slug]/assessments/[id]/route.ts',
      'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
    ]);
  });
});

describe('the evidence byte inspector (O-7) and its pre-buffer size gate have production callers', () => {
  it('inspect() is called from exactly the upload route', () => {
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

    expect(hits.map((h) => h.split(':')[0])).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
    ]);
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
  it("MAX_BYTES gates the upload route's pre-buffer Content-Length check", () => {
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

    expect(hits.map((h) => h.split(':')[0])).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
    ]);
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
  it('is called from exactly the upload route, gating the questionId attach target', () => {
    const hits = execSync(`grep -rn "questionExistsInBank(" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('lib/data/evidence.ts:'));

    expect(hits.map((h) => h.split(':')[0])).toEqual([
      'app/api/v1/orgs/[slug]/assessments/[id]/evidence/route.ts',
    ]);
  });
});
