import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { NextRequest } from 'next/server';
import {
  testDb,
  resetDb,
  SEEDED_FRAMEWORK_VERSION_ID,
  withDriftedFrameworkContent,
} from '../helpers/db';
import type { OrgContext } from '../../lib/data/tenant';
import { respondToAssessment, completeAssessment } from '../../lib/data/assessments';
import { PATCH } from '../../app/api/v1/orgs/[slug]/assessments/[id]/route';
import { POST as completeRoute } from '../../app/api/v1/orgs/[slug]/assessments/[id]/complete/route';
import { POST as createAssessmentRoute } from '../../app/api/v1/orgs/[slug]/assessments/route';

/**
 * Fix round 1, Important finding 3: `respondToAssessment` (PATCH) and
 * `completeAssessment` (POST .../complete) used to each run their
 * read-then-write as TWO separate `withOrg` calls — two transactions, with
 * a window between them a concurrent request could land in (see both
 * functions' doc comments in lib/data/assessments.ts for the exact drift
 * scenario). The fix moves each into ONE `withOrg` call. This suite proves
 * that structurally and deterministically — no real concurrency/timing
 * dependency, which would be flaky — by counting `withOrg` invocations via
 * a wrapping mock that still runs the real implementation. One call per
 * operation is exactly the property "read and write share a transaction"
 * requires: two separate `withOrg` calls are, by construction, two
 * separate transactions.
 *
 * Non-vacuous, verified by hand while writing this fix (per AGENTS.md
 * TDD): temporarily reverting `lib/data/assessments.ts` to the pre-fix
 * shape (a `findUnique`-only `withOrg` call followed by a second,
 * independent `withOrg` call for the `update`) makes both counting
 * assertions below fail (2 !== 1); restoring the fix makes them pass.
 */

let withOrgCallCount = 0;

vi.mock('../../lib/data/tenant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/data/tenant')>();
  return {
    ...actual,
    withOrg: (...args: Parameters<typeof actual.withOrg>) => {
      withOrgCallCount++;
      return actual.withOrg(...args);
    },
  };
});

function ctx(orgId: string, role: OrgRole): OrgContext {
  return { orgId, role } as OrgContext;
}

async function seedAssessment(
  slug: string,
  mode: 'full' | 'quick',
  engineState: unknown,
  // Fix round 1 (D-165): optional, defaults to the seeded/matching version
  // so every EXISTING call site is unaffected. A caller passing a bogus
  // id gets an assessment `resolveFramework(...).matches` will report
  // `false` for -- the same `fv_bogus`-row technique
  // framework-hash.test.ts / evidence-upload.test.ts already use, not a
  // new fixture mechanism.
  frameworkVersionId: string = SEEDED_FRAMEWORK_VERSION_ID,
) {
  const user = await testDb.user.create({
    data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
  });
  const org = await testDb.organization.create({ data: { name: slug, slug } });
  const project = await testDb.project.create({
    data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
  });
  const assessment = await testDb.assessment.create({
    data: {
      orgId: org.id,
      projectId: project.id,
      userId: user.id,
      mode,
      frameworkVersionId,
      engineState: engineState as never,
    },
  });
  return { user, org, project, assessment };
}

/**
 * Fix round 1 (D-165). Registers ONE bogus `framework_versions` row this
 * whole file can pin assessments to, id/semver distinct from every OTHER
 * test file's own bogus row (framework-hash.test.ts's 'fv_bogus'/'9.9.9',
 * evidence-upload.test.ts's 'fv_bogus_task6', report-provenance.test.ts's
 * 'fv_bogus_task9'/'fv_bogus_task9_samelen') so no fixture state is shared
 * across files. `framework_versions` carries no RLS (Task 1), so this is
 * written on the identity connection like the migration's own seed row —
 * same pattern as every prior use of this technique.
 */
async function registerBogusFrameworkVersion(): Promise<string> {
  const id = 'fv_bogus_assessments_patch';
  await testDb.$executeRaw`
    INSERT INTO "framework_versions" ("id","semver","contentHash","publishedAt")
    VALUES (${id}, '9.9.9-assessments-patch', '0000000000000000000000000000000000000000000000000000000000000000', now())
    ON CONFLICT ("id") DO NOTHING`;
  return id;
}

describe('respondToAssessment (PATCH .../assessments/[id])', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('updates engineState on an in-progress assessment, in ONE withOrg call', async () => {
    const { org, assessment } = await seedAssessment('resp-a', 'quick', {
      mode: 'quick',
      quick: { responses: {} },
    });

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      { mode: 'quick', quick: { responses: { q1: 3 } } } as never,
    );

    expect(result.kind).toBe('updated');
    expect(withOrgCallCount).toBe(1); // was 2 before the fix — the check and the write were separate transactions
  });

  it('refuses to modify a completed assessment, without a second transaction', async () => {
    const { org, assessment } = await seedAssessment('resp-b', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 3 } },
    });
    await testDb.assessment.update({
      where: { id: assessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      { mode: 'quick', quick: { responses: { q1: 4 } } } as never,
    );

    expect(result.kind).toBe('completed');
    expect(withOrgCallCount).toBe(1); // the check that refuses the write is IN the same transaction, not a preceding one

    const stillStored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stillStored.engineState as { quick: { responses: Record<string, number> } }).quick.responses.q1).toBe(3);
  });

  it('returns not_found for an unknown id, in ONE withOrg call', async () => {
    const org = await testDb.organization.create({ data: { name: 'resp-c', slug: 'resp-c' } });
    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      '00000000-0000-0000-0000-000000000000',
      { mode: 'quick', quick: { responses: {} } } as never,
    );
    expect(result.kind).toBe('not_found');
    expect(withOrgCallCount).toBe(1);
  });
});

/**
 * Fix round 1 (D-165, coordinator-authorised scope extension to Plan 1c
 * Task 9 -- see task-9-report.md). Spec §4.1: "In-progress → stop
 * accepting answers. Continuing means one response set spanning two
 * versions of the same question — silent corruption no later check could
 * untangle." Task 6 discharged O-14's in-progress half only on the
 * EVIDENCE upload route (app/api/v1/orgs/[slug]/assessments/[id]/
 * evidence/route.ts, `kind: 'drifted'`); uploading an artifact is not
 * answering a question, and this is the path where the corruption the
 * spec actually describes would occur. Same non-vacuity bar as every
 * other O-14 fixture in this codebase: a NEW assessment pinned to a
 * `framework_versions` row whose `contentHash` cannot match deployed
 * content (never an existing assessment's pin mutated post-hoc — O-3's
 * write-once trigger rejects that, by design, and a test must not work
 * around a control this plan installs).
 */
describe('respondToAssessment -- drift check (O-14, in-progress half)', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('rejects an engineState update to an in-progress assessment pinned to a framework_versions row whose contentHash cannot match deployed content', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org, assessment } = await seedAssessment(
      'resp-drift-a',
      'quick',
      { mode: 'quick', quick: { responses: {} } },
      bogusId,
    );

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      { mode: 'quick', quick: { responses: { q1: 3 } } } as never,
    );

    expect(result.kind).toBe('drifted');
    // Requirement 1 (coordinator's fix-round instructions): the drift
    // check runs INSIDE the existing transaction, not a second one --
    // proven the same structural way every other case in this file
    // proves it, not by inference.
    expect(withOrgCallCount).toBe(1);

    // The write did not happen -- engineState is exactly what it was
    // seeded with, not the rejected update.
    const stillStored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stillStored.engineState as { quick: { responses: Record<string, number> } }).quick.responses).toEqual({});
  });

  it('still updates an in-progress assessment pinned to the CURRENT (matching) content -- the drift check is not a blanket regression', async () => {
    const { org, assessment } = await seedAssessment('resp-drift-b', 'quick', {
      mode: 'quick',
      quick: { responses: {} },
    });

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      { mode: 'quick', quick: { responses: { q1: 3 } } } as never,
    );

    expect(result.kind).toBe('updated');
  });

  it('rejects a drifted assessment distinctly from a completed one -- the two 409-shaped refusals never share a `kind`', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org: driftOrg, assessment: driftAssessment } = await seedAssessment(
      'resp-drift-c',
      'quick',
      { mode: 'quick', quick: { responses: {} } },
      bogusId,
    );
    const { org: completedOrg, assessment: completedAssessment } = await seedAssessment('resp-drift-d', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 3 } },
    });
    await testDb.assessment.update({
      where: { id: completedAssessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });

    const driftResult = await respondToAssessment(
      ctx(driftOrg.id, 'assessor'),
      driftAssessment.id,
      { mode: 'quick', quick: { responses: { q1: 3 } } } as never,
    );
    const completedResult = await respondToAssessment(
      ctx(completedOrg.id, 'assessor'),
      completedAssessment.id,
      { mode: 'quick', quick: { responses: { q1: 4 } } } as never,
    );

    expect(driftResult.kind).toBe('drifted');
    expect(completedResult.kind).toBe('completed');
    expect(driftResult.kind).not.toBe(completedResult.kind);
  });
});

let currentSession: { user: { id: string }; sessionEpoch: number; sessionIssuedAt: number } | null = null;

vi.mock('../../lib/auth', () => ({
  auth: () => Promise.resolve(currentSession),
}));

function sessionFor(userId: string): void {
  currentSession = { user: { id: userId }, sessionEpoch: 0, sessionIssuedAt: Math.floor(Date.now() / 1000) };
}

/**
 * HTTP-layer counterpart to the `respondToAssessment` drift tests above:
 * those prove the LIB function's own kind/transaction behaviour; this
 * proves the ROUTE actually maps `kind: 'drifted'` to a 409 with its OWN
 * distinct message -- a real, separate thing that could be wrong (wrong
 * status code, a forgotten case falling through to `NextResponse.json
 * (result.assessment)` with `assessment: undefined`, or a message
 * indistinguishable from the 'completed' 409) independent of whether the
 * lib function itself is correct. Task 6 named this exact failure mode by
 * name: its own drift 409 and completed-assessment 409 originally shared
 * one message, and deleting either guard left the whole suite green
 * because no assertion could tell which had fired.
 */
describe('PATCH .../assessments/[id] route -- drift response shape', () => {
  beforeEach(() => resetDb());

  function patchReq(slug: string, id: string, engineState: unknown) {
    const req = new NextRequest('http://localhost/probe', {
      method: 'PATCH',
      body: JSON.stringify({ engineState }),
      headers: { 'content-type': 'application/json' },
    });
    return PATCH(req, { params: Promise.resolve({ slug, id }) });
  }

  it('responds 409 with a message distinct from the completed-assessment 409, and names the reason as drift', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org, assessment, user } = await seedAssessment(
      'resp-drift-route-a',
      'quick',
      { mode: 'quick', quick: { responses: {} } },
      bogusId,
    );
    // Unlike the lib-level tests above (ctx() casts a plain object,
    // bypassing membership lookup entirely), the REAL route goes through
    // requireOrgContext, which resolves the caller's role from a real
    // Membership row.
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, { mode: 'quick', quick: { responses: { q1: 3 } } });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).not.toBe('Completed assessments cannot be modified');
    expect(body.error.toLowerCase()).toContain('drift');
  });

  it('the completed-assessment 409 keeps its own original message, unaffected by the new drift branch', async () => {
    const { org, assessment, user } = await seedAssessment('resp-drift-route-b', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 3 } },
    });
    await testDb.assessment.update({
      where: { id: assessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, { mode: 'quick', quick: { responses: { q1: 4 } } });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Completed assessments cannot be modified');
  });
});

describe('completeAssessment (POST .../assessments/[id]/complete)', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('completes a quick assessment from its CURRENT engineState, in ONE withOrg call', async () => {
    const { org, assessment } = await seedAssessment('comp-a', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 4, q2: 2 } },
    });

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.mode).toBe('quick');
      expect(result.assessment.status).toBe('completed');
    }
    expect(withOrgCallCount).toBe(1); // was 2 before the fix — the read and the write were separate transactions

    // The stored reportData is derived from exactly the engineState that
    // was current AT COMPLETION, inside the same transaction as the write
    // that set it — the drift finding 3 describes is a read and a write
    // from two different transactions disagreeing about what "current"
    // was.
    const stored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stored.reportData as { mode: string }).mode).toBe('quick');
  });

  it('is idempotent on an already-completed assessment, in ONE withOrg call', async () => {
    const { org, assessment } = await seedAssessment('comp-b', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 4 } },
    });
    await testDb.assessment.update({
      where: { id: assessment.id },
      data: { status: 'completed', overallScore: 90, completedAt: new Date() },
    });

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('already_completed');
    expect(withOrgCallCount).toBe(1);
  });

  it('returns not_found for an unknown id, in ONE withOrg call', async () => {
    const org = await testDb.organization.create({ data: { name: 'comp-c', slug: 'comp-c' } });
    const result = await completeAssessment(ctx(org.id, 'assessor'), '00000000-0000-0000-0000-000000000000');
    expect(result.kind).toBe('not_found');
    expect(withOrgCallCount).toBe(1);
  });
});

/**
 * Fix round 2 (Critical, coordinator-found and independently verified before
 * fixing): `completeAssessment` -- NOT `respondToAssessment` -- is the path
 * where O-14's in-progress corruption actually lands. `generateReportData`
 * (`lib/engine/AssessmentEngine.js:20-22`) and, via `questionBank`,
 * `getQuickScore` (`lib/engine/QuickAssessment.js:3`) both statically import
 * CURRENTLY DEPLOYED content files -- so completion always scores the stored
 * `engineState` against whatever is deployed NOW, never against the pin,
 * regardless of what `respondToAssessment` blocks during the in-progress
 * phase. Fix round 1 closing the PATCH path left this path completely open.
 *
 * The check is placed BEFORE the `mode === 'quick'` dispatch, unconditionally
 * -- one guard protects both branches, rather than two mode-specific copies
 * that could drift from each other. Because it runs before either branch,
 * BOTH fixtures below use a placeholder `engineState` (`{}` / `{ quick: {
 * responses: {} } }`) that would fail `canGenerateReport`/`no_responses` if
 * the function ever reached that far -- proving the drift check itself is
 * what stops it, not a downstream validation failure that happens to return
 * a different `kind`.
 */
describe('completeAssessment -- drift check (O-14, completion half)', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('rejects completing a QUICK assessment pinned to a framework_versions row whose contentHash cannot match deployed content', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org, assessment } = await seedAssessment(
      'comp-drift-a',
      'quick',
      { mode: 'quick', quick: { responses: { q1: 4 } } },
      bogusId,
    );

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('drifted');
    expect(withOrgCallCount).toBe(1);

    const stillStored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(stillStored.status).toBe('in_progress');
    expect(stillStored.reportData).toBeNull();
  });

  it('rejects completing a FULL assessment pinned to a framework_versions row whose contentHash cannot match deployed content -- before canGenerateReport ever runs', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    // Deliberately a placeholder, not a real stage-complete engineState:
    // canGenerateReport(state) would need state.stages['pre-processing']
    // etc. to exist and this would throw reading `.status` off `undefined`
    // if the drift check did NOT short-circuit first. That it does not
    // throw, and returns 'drifted' rather than a crash or 'no_stages', is
    // itself part of the proof the guard runs first.
    const { org, assessment } = await seedAssessment('comp-drift-b', 'full', {}, bogusId);

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('drifted');
    expect(withOrgCallCount).toBe(1);
  });

  it('still completes a quick assessment pinned to the CURRENT (matching) content -- the drift check is not a blanket regression', async () => {
    const { org, assessment } = await seedAssessment('comp-drift-c', 'quick', {
      mode: 'quick',
      quick: { responses: { q1: 4, q2: 2 } },
    });

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('completed');
  });
});

/**
 * HTTP-layer counterpart, same reasoning as the PATCH route's own drift
 * response-shape tests above: proves the ROUTE maps `kind: 'drifted'` to its
 * own distinct 409, not just that the lib function returns the right kind.
 * CORRECTED at the C6 whole-branch review, 2026-08-09. This paragraph read
 * "`complete/route.ts`'s `switch` has NO `default` case (unlike the
 * evidence route's exhaustiveness guard) -- an unhandled `kind` falls
 * through and returns nothing". That was stale WITHIN THE COMMIT THAT
 * ADDED IT: the same fix round added the `default` arm
 * (`const _exhaustive: never = result`, `complete/route.ts`), so the
 * comment described the route's pre-fix shape while sitting next to the
 * test written for its post-fix shape. What is still true, and is why this
 * block exists: a compile-time exhaustiveness guard proves every `kind` is
 * HANDLED, never that a given kind is mapped to the RIGHT status and a
 * distinguishable message -- which is what the test below pins, and what a
 * `default` arm cannot.
 */
describe('POST .../assessments/[id]/complete route -- drift response shape', () => {
  beforeEach(() => resetDb());

  function completeReq(slug: string, id: string) {
    const req = new NextRequest('http://localhost/probe', { method: 'POST' });
    return completeRoute(req, { params: Promise.resolve({ slug, id }) });
  }

  it('responds 409 with a message distinct from every other refusal, and names the reason as drift', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org, assessment, user } = await seedAssessment(
      'comp-drift-route-a',
      'quick',
      { mode: 'quick', quick: { responses: { q1: 4 } } },
      bogusId,
    );
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await completeReq(org.slug, assessment.id);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('drift');
  });
});

/**
 * C6 whole-branch review, F5 (MEDIUM). `POST .../assessments` resolved the
 * version to pin by SEMVER STRING ONLY (`getCurrentVersionId` ->
 * `resolvePublishedVersionId`, which filters `{ semver, status:
 * 'published' }`) and never compared the resolved row's `contentHash`
 * against the running bundle's. So when framework content is edited
 * WITHOUT a `meta.version` bump -- the exact drift condition the other
 * three O-14 guards exist for -- creation returned 201 and pinned the new
 * assessment to a version whose hash no longer described the deployed
 * content. The very first autosave then hit `respondToAssessment`'s
 * `if (!resolution.matches)` and 409'd forever: the user held an
 * assessment that could never be answered, with no in-product remedy
 * (D-167). Creation was outside `trigger-enumeration.test.ts`'s
 * three-site pin, which is why nothing caught it.
 *
 * FIXTURE. Drift is reproduced the way it would really happen: the
 * `framework_versions` row the DEPLOYED content resolves to (semver
 * `3.0.0` -> `fv_3_0_0`) gets a `contentHash` that is not the running
 * bundle's, which is precisely "someone edited the JSON and did not bump
 * the version". Restored in a `finally` -- `resetDb()` deliberately does
 * NOT truncate `framework_versions` (see `__tests__/helpers/db.ts`), so an
 * unrestored mutation would leak into every later test in the run.
 */
describe('POST .../assessments -- creation-time drift guard (C6 F5)', () => {
  beforeEach(() => resetDb());

  async function createReq(slug: string, projectId: string) {
    const req = new NextRequest('http://localhost/probe', {
      method: 'POST',
      body: JSON.stringify({ projectId, mode: 'full' }),
      headers: { 'content-type': 'application/json' },
    });
    return createAssessmentRoute(req, { params: Promise.resolve({ slug }) });
  }

  async function seedOrgWithOwner(slug: string) {
    const user = await testDb.user.create({
      data: { email: `${slug}@x.org`, name: slug, passwordHash: 'x' },
    });
    const org = await testDb.organization.create({ data: { name: slug, slug } });
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'owner' } });
    const project = await testDb.project.create({
      data: { orgId: org.id, name: `${slug} project`, createdById: user.id },
    });
    sessionFor(user.id);
    return { org, project };
  }

  it('creates an assessment (201) while the deployed content still matches the pinned row', async () => {
    const { org, project } = await seedOrgWithOwner('create-drift-ok');
    const res = await createReq(org.slug, project.id);
    expect(res.status).toBe(201);
  });

  /**
   * NON-VACUITY: the case above is the SAME request, same fixture, same
   * role, differing only in whether the deployed content matches. It
   * returns 201. So this test's 409 cannot come from a permission, a
   * missing project, or a malformed body -- only from the guard.
   */
  it('refuses with 409 rather than minting an assessment whose first autosave would 409 forever', async () => {
    const { org, project } = await seedOrgWithOwner('create-drift-blocked');
    const res = await withDriftedFrameworkContent(() => createReq(org.slug, project.id));

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('drift');
  });

  it('writes no assessment row at all when it refuses -- not a partial create', async () => {
    const { org, project } = await seedOrgWithOwner('create-drift-norow');
    await withDriftedFrameworkContent(() => createReq(org.slug, project.id));
    expect(await testDb.assessment.count({ where: { projectId: project.id } })).toBe(0);
  });
});
