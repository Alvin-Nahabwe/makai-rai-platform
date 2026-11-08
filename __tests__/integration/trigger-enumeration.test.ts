import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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

describe('the acceptance gate has its production triggers (FR-ACC-04, SRS 7.1.2 gate 3)', () => {
  /** The body of `export async function <name>(` in lib/auth/identity.ts, up to the closing brace at column 0. */
  function bodyOf(name: string): string {
    const src = readFileSync('lib/auth/identity.ts', 'utf8');
    const start = src.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    return src.slice(start, src.indexOf('\n}\n', start));
  }

  it('NFR-MNT-01 FR-ACC-04: missingAcceptances is read and branched on in both gates', () => {
    // As for mustChangePassword above: a read whose result is carried and never branched on is the
    // defect shape, so each gate must both call it for the resolved identity and act on a non-empty set.
    const page = bodyOf('requireIdentity');
    const api = bodyOf('requireIdentityForApi');
    // The rows behind missingAcceptances are read once per request (React cache() over rowsOf, lib/data/acceptances.ts).
    expect(readFileSync('lib/data/acceptances.ts', 'utf8')).toMatch(/const rowsOf = cache\(/);
    for (const body of [page, api]) {
      expect(body).toMatch(/const missing = await missingAcceptances\(identity\.userId\);/);
      expect(body).toMatch(/if \(missing\.length > 0/);
    }
    expect(page).toMatch(/redirect\(ACCEPTANCES_PATH\)/);
    expect(api).toMatch(/throw new AcceptancesRequiredError\(missing\)/);
  });

  it('FR-ACC-04 NFR-MNT-01: allowMissingAcceptances is named in code only by the S-05 and S-21 routes', () => {
    // The child gets NO_COLOR=1 and no FORCE_COLOR, and escape sequences are stripped (the rule above).
    const { FORCE_COLOR: _force, ...plainEnv } = process.env;
    // Every file that names the option, then only those that name it outside comments (K0b's stub
    // comments name it in prose): a call split over lines or options passed through a variable count.
    const named = execSync(`git grep -l -F allowMissingAcceptances -- app lib components || true`, { env: { ...plainEnv, NO_COLOR: '1' } })
      .toString().replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean);
    const files = named.filter((f) => f !== 'lib/auth/identity.ts' && namesOptionInCode(readFileSync(f, 'utf8'))).sort();
    // Route 37 (app/api/users/me/preferences/route.ts) joined this list when FUP filled it (contract
    // routes 35 to 39, gap G028).
    expect(files).toEqual(['app/api/acceptances/route.ts',
      'app/api/users/me/export/route.ts', 'app/api/users/me/password/route.ts',
      'app/api/users/me/preferences/route.ts', 'app/api/users/me/route.ts', 'app/api/users/me/sessions/route.ts']);
  });

  it('FR-ACC-04 NFR-MNT-01 (lint self-test): a call over several lines or a variable of options is found; a comment is not', () => {
    expect(namesOptionInCode('const identity = await requireIdentityForApi({\n  allowMissingAcceptances: true,\n});')).toBe(true);
    expect(namesOptionInCode('const opts = { allowMissingAcceptances: true };\nawait requireIdentityForApi(opts);')).toBe(true);
    expect(namesOptionInCode("const url = 'http://x'; requireIdentityForApi({ allowMissingAcceptances: true })")).toBe(true);
    expect(namesOptionInCode('// allowMissingAcceptances is passed by route 37 once FUP fills it\nthrow new NotImplementedError();')).toBe(false);
    expect(namesOptionInCode('/**\n * allowMissingAcceptances: true, per contract row 37\n */\nexport const GET = stub;')).toBe(false);
  });
});

/** Whether a source names allowMissingAcceptances outside its block and line comments (strings are code here). */
function namesOptionInCode(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  return code.includes('allowMissingAcceptances');
}

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
  it('NFR-MNT-01 FR-EVD-01: evidence:create is consulted by exactly the project upload route', () => {
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

describe('the evidence byte inspector (O-7) and its pre-buffer size gate have production callers', () => {
  it('NFR-MNT-01 FR-EVD-02: inspect() has exactly one production caller, createFileEvidence', () => {
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

    expect(hits.map((h) => h.split(':')[0])).toEqual(['lib/data/evidence.ts']);
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
  it('NFR-MNT-01 FR-EVD-02: the pre-buffer Content-Length gate on MAX_BYTES is in exactly the project upload route', () => {
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

    expect(hits.map((h) => h.split(':')[0])).toEqual(['app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts']);
  });
});

describe('the storage cap has its production caller (NFR-REL-09)', () => {
  it('NFR-MNT-01 NFR-REL-09: assertStorageAvailable is called by exactly lib/data/evidence.ts, so no document issue path can refuse for storage', () => {
    const hits = execSync(`grep -rn "assertStorageAvailable(" app lib --include=*.ts || true`)
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (!m) throw new Error(`grep -n output did not parse -- "${line}"`);
        const [, file, , content] = m;
        const trimmed = content.trim();
        return file !== 'lib/evidence/storageCap.ts' && !trimmed.startsWith('//') && !trimmed.startsWith('*');
      });
    expect(hits.map((h) => h.split(':')[0])).toEqual(['lib/data/evidence.ts']);
  });
});

describe('the findings service has its production triggers (FR-FND-01, NFR-MNT-01)', () => {
  // Read from disk with fs, no child process, so no colour setting can change what is compared.
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const FINDINGS = 'lib/data/findings.ts';
  const src = readFileSync(FINDINGS, 'utf8');

  /** Every top-level function of lib/data/findings.ts with its body (up to the closing brace at column 0). */
  const bodies = new Map<string, string>(
    [...src.matchAll(/^(?:export )?(?:async )?function (\w+)[\s\S]*?\n\}\n/gm)].map((m) => [m[1], m[0]]),
  );
  /** True when the function, or a function of the same file it calls, takes the per-finding lock. */
  function locks(name: string, seen = new Set<string>()): boolean {
    if (seen.has(name)) return false;
    seen.add(name);
    const body = bodies.get(name) ?? '';
    if (/\blockFinding\(/.test(body.replace(/^.*\n/, ''))) return true;
    return [...body.matchAll(/\b(\w+)\(/g)].some(([, called]) => called !== name && bodies.has(called) && locks(called, seen));
  }

  it('NFR-MNT-01 FR-FND-01: onShortfallSaved has exactly one production caller, lib/data/decisions.ts', () => {
    const callers = [...files('app'), ...files('lib')].filter((f) => f !== FINDINGS && /\bonShortfallSaved\(/.test(readFileSync(f, 'utf8')));
    expect(callers).toEqual(['lib/data/decisions.ts']);
  });

  it('NFR-MNT-01 SRS 5.3 item 11: every exported write of lib/data/findings.ts takes the per-finding lock', () => {
    const writes = ['onShortfallSaved', 'addMitigation', 'updateMitigation', 'acceptRisk', 'reopenFinding', 'withdrawFinding', 'closeByDecision'];
    // The list is the file's exported functions that insert, read from the file itself, so a new write cannot be missed.
    const exportedInserting = [...bodies.entries()]
      .filter(([, body]) => body.startsWith('export ') && /\.create(Many)?\(/.test([...body.matchAll(/\b(\w+)\(/g)].map(([, c]) => bodies.get(c) ?? '').join('\n') + body))
      .map(([name]) => name).sort();
    expect(exportedInserting).toEqual([...writes].sort());
    expect(writes.filter((w) => !locks(w))).toEqual([]);
  });

  it('NFR-MNT-01 (lint self-test): a write that skips the lock is found', () => {
    bodies.set('probeWrite', 'export async function probeWrite() {\n  await tx.finding.create({});\n}\n');
    try { expect(locks('probeWrite')).toBe(false); } finally { bodies.delete('probeWrite'); }
  });
});

describe('archivedAt has its production triggers (FR-PRJ-03, Review Focus 4)', () => {
  const code = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  const count = (f: string, re: RegExp) => (code(f).match(re) ?? []).length;
  // idempotentWrite( and the generic form idempotentWrite<View>( that seals.ts and reviews.ts write (REV-a RE-3).
  const WRITE_CALL = /\bidempotentWrite\s*(<[^>(]*>)?\(/g;
  const GATE_CALL = /\bassertProjectWritable\(/g;
  const RECEIPT_WRITE = /table: 'request_receipts'/g;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
  const allFiles = () => [...walk('app'), ...walk('lib')];

  it('FR-PRJ-03 RF-4: every idempotent write path reads the archived gate', () => {
    const writers = allFiles().filter((f) => f !== 'lib/data/idempotency.ts' && count(f, WRITE_CALL) > 0);
    expect(writers.length).toBeGreaterThan(0);
    // Receipt-mode calls (routes 21 to 29, owner answer A1) create, change or remove a project or a membership, not a
    // record of a project, so the record gate does not apply to them; the project edit route is pinned by the next case.
    for (const f of writers) {
      expect({ f, gated: count(f, GATE_CALL) >= count(f, WRITE_CALL) - count(f, RECEIPT_WRITE) }).toEqual({ f, gated: true });
    }
  });

  it('FR-PRJ-03 RF-4: only the project routes and the member service write in receipt mode, so a new receipt-mode writer must say whether it writes a record', () => {
    // A receipt-mode call is not counted against the gate (it creates or changes a project or a membership). A file that
    // joins the list must be added here on purpose: if it writes a record of a project it has to call the gate instead.
    const RECEIPT_MODE = [
      'app/api/v1/orgs/[slug]/projects/[id]/archive/route.ts', 'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
      'app/api/v1/orgs/[slug]/projects/[id]/unarchive/route.ts', 'app/api/v1/orgs/[slug]/projects/route.ts', 'lib/data/members.ts',
    ];
    expect(allFiles().filter((f) => f !== 'lib/data/idempotency.ts' && count(f, WRITE_CALL) > 0 && count(f, RECEIPT_WRITE) > 0).sort()).toEqual([...RECEIPT_MODE].sort());
  });

  it('FR-PRJ-03 RF-4: the seal writer, the review writer and the project edit route are among the gate callers', () => {
    const callers = allFiles().filter((f) => count(f, GATE_CALL) > 0 && f !== 'lib/data/projectGuard.ts');
    expect(callers).toEqual(expect.arrayContaining([
      'lib/data/seals.ts', 'lib/data/reviews.ts', 'lib/data/decisions.ts', 'lib/data/evidence.ts', 'lib/data/findings.ts',
      'lib/data/teamFindings.ts', 'app/api/v1/orgs/[slug]/projects/[id]/route.ts',
    ]));
  });

  it('FR-PRJ-03 RF-4 (lint self-test): a writer file with an unguarded record write is found', () => {
    const probe = "await idempotentWrite<View>(ctx, { table: 'findings' });";
    expect((probe.match(WRITE_CALL) ?? []).length).toBe(1);
    expect((probe.match(GATE_CALL) ?? []).length).toBe(0);
  });
});
