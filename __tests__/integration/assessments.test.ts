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
import {
  createAssessment,
  setResponse,
  completeStage,
  SCORING_VERSION,
} from '../../lib/engine/AssessmentEngine.js';
import type { EngineState } from '../../types/domain';
import { logSecurityEvent } from '../../lib/security-logger';

// Same wrapping (not stubbing) pattern as
// __tests__/integration/evidence-download.test.ts:10-17, and for the same
// reason: every OTHER call in this file must still log for real, so the
// mock delegates to the actual implementation and exists only so the two
// new INPUT_VALIDATION_FAILURE call sites can be asserted. Without this,
// deleting either `logSecurityEvent` call left the suite green -- the gap
// the silent-failure review found (F-5).
vi.mock('../../lib/security-logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/security-logger')>();
  return { ...actual, logSecurityEvent: vi.fn(actual.logSecurityEvent) };
});

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
  // Task 1 (2026-08-26): `mode` was the second positional parameter here.
  // Quick Check's data-layer branch is gone (`lib/data/assessments.ts`), so
  // every caller now seeds a real `{ stages: … }` engine state -- built via
  // the engine's own `createAssessment`/`setResponse`/`completeStage`
  // rather than hand-written JSON, the same convention
  // `report-provenance.test.ts` already uses. The `mode` COLUMN still
  // exists (dropped in Task 3) and defaults to `'full'` in the schema, so
  // omitting it here is sufficient -- no column-level change happens in
  // this task.
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
    const { org, assessment } = await seedAssessment('resp-a', createAssessment());

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 3) as never,
    );

    expect(result.kind).toBe('updated');
    expect(withOrgCallCount).toBe(1); // was 2 before the fix — the check and the write were separate transactions
  });

  it('refuses to modify a completed assessment, without a second transaction', async () => {
    const seededState = setResponse(createAssessment(), 'pre-processing', 'q1', 3);
    const { org, assessment } = await seedAssessment('resp-b', seededState);
    await testDb.assessment.update({
      where: { id: assessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      setResponse(seededState, 'pre-processing', 'q1', 4) as never,
    );

    expect(result.kind).toBe('completed');
    expect(withOrgCallCount).toBe(1); // the check that refuses the write is IN the same transaction, not a preceding one

    const stillStored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(
      (stillStored.engineState as unknown as EngineState).stages['pre-processing'].responses.q1,
    ).toBe(3);
  });

  it('returns not_found for an unknown id, in ONE withOrg call', async () => {
    const org = await testDb.organization.create({ data: { name: 'resp-c', slug: 'resp-c' } });
    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      '00000000-0000-0000-0000-000000000000',
      createAssessment() as never,
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
    const { org, assessment } = await seedAssessment('resp-drift-a', createAssessment(), bogusId);

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 3) as never,
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
    expect(
      (stillStored.engineState as unknown as EngineState).stages['pre-processing'].responses,
    ).toEqual({});
  });

  it('still updates an in-progress assessment pinned to the CURRENT (matching) content -- the drift check is not a blanket regression', async () => {
    const { org, assessment } = await seedAssessment('resp-drift-b', createAssessment());

    const result = await respondToAssessment(
      ctx(org.id, 'assessor'),
      assessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 3) as never,
    );

    expect(result.kind).toBe('updated');
  });

  it('rejects a drifted assessment distinctly from a completed one -- the two 409-shaped refusals never share a `kind`', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org: driftOrg, assessment: driftAssessment } = await seedAssessment(
      'resp-drift-c',
      createAssessment(),
      bogusId,
    );
    const { org: completedOrg, assessment: completedAssessment } = await seedAssessment(
      'resp-drift-d',
      setResponse(createAssessment(), 'pre-processing', 'q1', 3),
    );
    await testDb.assessment.update({
      where: { id: completedAssessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });

    const driftResult = await respondToAssessment(
      ctx(driftOrg.id, 'assessor'),
      driftAssessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 3) as never,
    );
    const completedResult = await respondToAssessment(
      ctx(completedOrg.id, 'assessor'),
      completedAssessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 4) as never,
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
      createAssessment(),
      bogusId,
    );
    // Unlike the lib-level tests above (ctx() casts a plain object,
    // bypassing membership lookup entirely), the REAL route goes through
    // requireOrgContext, which resolves the caller's role from a real
    // Membership row.
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(
      org.slug,
      assessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 3),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).not.toBe('Completed assessments cannot be modified');
    expect(body.error.toLowerCase()).toContain('drift');
  });

  it('the completed-assessment 409 keeps its own original message, unaffected by the new drift branch', async () => {
    const seededState = setResponse(createAssessment(), 'pre-processing', 'q1', 3);
    const { org, assessment, user } = await seedAssessment('resp-drift-route-b', seededState);
    await testDb.assessment.update({
      where: { id: assessment.id },
      data: { status: 'completed', overallScore: 80, completedAt: new Date() },
    });
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(
      org.slug,
      assessment.id,
      setResponse(seededState, 'pre-processing', 'q1', 4),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Completed assessments cannot be modified');
  });
});

/**
 * The INGRESS half of the malformed-`.stages` fix, and the half the
 * `completeAssessment` tests below cannot reach.
 *
 * Those tests seed a bad state directly into the row and prove the
 * CONSUMER fails closed. This one proves the bad state never gets stored
 * in the first place: the PATCH route's body guard only ever asked whether
 * `engineState.stages` was truthy, so `{ stages: {} }` passed it, was
 * persisted verbatim by `respondToAssessment` (which treats `engineState`
 * as an opaque blob and never inspects its shape), and bricked every
 * subsequent completion attempt on that assessment with an uncaught 500.
 *
 * Both halves are required and neither substitutes for the other: the
 * ingress guard cannot heal rows already written, and the consumer guard
 * cannot stop a corrupt state from replacing a good one.
 *
 * The write assertion is the load-bearing one. A 400 alone would still
 * pass if the route rejected the response AFTER performing the update.
 */
describe('PATCH .../assessments/[id] route -- malformed engineState is refused at ingress', () => {
  beforeEach(() => resetDb());

  // `rawBody` is the escape hatch for the two malformed-BODY cases, which
  // cannot be expressed as an `engineState` value: they need the request to
  // carry something `JSON.stringify({ engineState })` can never produce.
  function patchReq(slug: string, id: string, engineState: unknown, rawBody?: string) {
    const req = new NextRequest('http://localhost/probe', {
      method: 'PATCH',
      body: rawBody ?? JSON.stringify({ engineState }),
      headers: { 'content-type': 'application/json' },
    });
    return PATCH(req, { params: Promise.resolve({ slug, id }) });
  }

  it('responds 400 and writes nothing when stages is present but empty', async () => {
    const goodState = setResponse(createAssessment(), 'pre-processing', 'q1', 3);
    const { org, assessment, user } = await seedAssessment('patch-malformed-a', goodState);
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, { stages: {} });

    expect(res.status).toBe(400);
    const stored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stored.engineState as unknown as EngineState).stages).toHaveProperty('post-processing');
  });

  it('responds 400 and writes nothing when a completed stage has no siblings', async () => {
    const goodState = setResponse(createAssessment(), 'pre-processing', 'q1', 3);
    const { org, assessment, user } = await seedAssessment('patch-malformed-b', goodState);
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, {
      stages: { 'pre-processing': { status: 'completed' } },
    });

    expect(res.status).toBe(400);
    const stored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stored.engineState as unknown as EngineState).stages).toHaveProperty('post-processing');
  });

  it('still accepts a well-formed engineState -- the guard is not a blanket refusal', async () => {
    const { org, assessment, user } = await seedAssessment('patch-malformed-c', createAssessment());
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(
      org.slug,
      assessment.id,
      setResponse(createAssessment(), 'pre-processing', 'q1', 4),
    );

    expect(res.status).toBe(200);
  });

  /**
   * The refusal must be AUDITABLE, not merely correct. Without this
   * assertion, deleting the `logSecurityEvent` call left the suite green
   * (silent-failure review, F-5) -- and an unlogged refusal is half of the
   * problem this change exists to fix: the original defect was an
   * uncaught, UNLOGGED 500, and swapping it for a clean but equally
   * invisible 400 would only have improved the status code.
   *
   * The payload assertion is deliberate too: `details` must carry a reason
   * CODE and never the rejected body. This is an untrusted request payload
   * and the audit log is the one place it would otherwise be echoed
   * verbatim.
   */
  it('logs an INPUT_VALIDATION_FAILURE naming the reason, without echoing the rejected payload', async () => {
    const { org, assessment, user } = await seedAssessment('patch-malformed-d', createAssessment());
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);
    vi.mocked(logSecurityEvent).mockClear();

    await patchReq(org.slug, assessment.id, { stages: {} });

    const call = vi.mocked(logSecurityEvent).mock.calls.find(
      ([event]) => event === 'INPUT_VALIDATION_FAILURE',
    );
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('warn');
    expect(call?.[2]?.details).toMatchObject({
      route: 'assessment:respond',
      reason: 'malformed_engine_state',
    });
    expect(JSON.stringify(call?.[2]?.details)).not.toContain('stages');
  });

  /**
   * The two inputs one character away from the guarded ones, which used to
   * produce the very failure this change removes: a body of literal `null`
   * parses fine and then throws `TypeError` on the destructure, and a
   * non-JSON body throws `SyntaxError` out of `req.json()`. Both landed in
   * the handler's `catch`, where `toResponse` rethrows anything that is not
   * one of its four auth error types -- by design -- giving an uncaught,
   * unlogged 500. Found by the silent-failure review OF the guard rather
   * than by the guard (F-7).
   */
  it('responds 400, not 500, for a JSON body of literal null', async () => {
    const { org, assessment, user } = await seedAssessment('patch-malformed-e', createAssessment());
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, undefined, 'null');

    expect(res.status).toBe(400);
  });

  it('responds 400, not 500, for a body that is not JSON at all', async () => {
    const { org, assessment, user } = await seedAssessment('patch-malformed-f', createAssessment());
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await patchReq(org.slug, assessment.id, undefined, 'not json at all');

    expect(res.status).toBe(400);
  });
});

describe('completeAssessment (POST .../assessments/[id]/complete)', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('completes an assessment from its CURRENT engineState, in ONE withOrg call', async () => {
    const seededState = completeStage(
      setResponse(createAssessment(), 'pre-processing', 'q1', 4),
      'pre-processing',
      { skipValidation: true },
    );
    const { org, assessment } = await seedAssessment('comp-a', seededState);

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.assessment.status).toBe('completed');
    }
    expect(withOrgCallCount).toBe(1); // was 2 before the fix — the read and the write were separate transactions

    // The stored reportData is derived from exactly the engineState that
    // was current AT COMPLETION, inside the same transaction as the write
    // that set it — the drift finding 3 describes is a read and a write
    // from two different transactions disagreeing about what "current"
    // was. `completedStages` reflects the one stage this fixture actually
    // completed, not an empty/default report.
    const stored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect((stored.reportData as { completedStages: string[] }).completedStages).toEqual([
      'pre-processing',
    ]);
  });

  it('is idempotent on an already-completed assessment, in ONE withOrg call', async () => {
    const seededState = setResponse(createAssessment(), 'pre-processing', 'q1', 4);
    const { org, assessment } = await seedAssessment('comp-b', seededState);
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

  /**
   * Fix round 1 (Critical, coordinator-found, 2026-08-26): Task 1 deleted
   * `completeAssessment`'s retired quick-mode scoring branch, which used to
   * return early for an engineState carrying no `.stages` at all. Removing
   * it unmasked that `canGenerateReport` (lib/engine/AssessmentEngine.js)
   * was never actually safe against a `state` lacking `.stages` -- it
   * wasn't specific to that branch: ANY malformed engineState reaching this path
   * throws `TypeError: Cannot read properties of undefined (reading
   * '<stage>')` instead of letting the existing `no_stages` -> 400 guard
   * (complete/route.ts) fire. Proven live in permission-matrix.test.ts,
   * whose `completeAssessment` fixture happened to carry exactly this
   * shape. This test pins the OUTCOME through the real call path
   * (`completeAssessment`, not a bare `canGenerateReport({})` unit check,
   * which would prove the guard function but not the behaviour that
     * matters here) -- fails closed, never a crash, and never a silently-empty
   * but "successful" report.
   *
   * The refusal KIND changed after this comment was first written: the
   * narrative above describes the pre-fix world, where the only available
   * fail-closed branch was `no_stages`. A state with no `.stages` at all is
   * corrupt rather than merely unfinished, so it now takes the
   * `malformed_state` branch, and the `no_stages` branch keeps its own
   * assertion further down.
   */
  it('returns malformed_state rather than crashing when engineState lacks `.stages` entirely', async () => {
    const { org, assessment } = await seedAssessment('comp-malformed', {});

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('malformed_state');
  });

  /**
   * The case the guard above explicitly scoped OUT, now scoped in.
   *
   * `.stages` PRESENT but not carrying a well-formed entry per stage passes
   * every check that existed before this test: the PATCH route's own
   * `!engineState.stages` body guard (an empty object is truthy, so the
   * state is PERSISTED), and then `canGenerateReport`'s `!state?.stages`
   * (truthy again). The crash therefore lands one REQUEST later than the
   * one that supplied the bad payload -- PATCH stores it, a subsequent
   * POST .../complete detonates it -- which is why the fix cannot live in
   * `canGenerateReport` alone.
   *
   * The second case below is the one an optional-chain patch
   * (`state.stages[stage]?.status`) would NOT have fixed -- see
   * `canGenerateReport`'s own doc comment in lib/engine/AssessmentEngine.js,
   * which owns that measurement because it is that function's history.
   *
   * Asserted through `completeAssessment` rather than as a bare
   * `canGenerateReport` unit check, for the reason the sibling case above
   * states.
   */
  it('returns malformed_state rather than crashing when stages is present but empty', async () => {
    const { org, assessment } = await seedAssessment('comp-malformed-empty', { stages: {} });

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('malformed_state');
  });

  it('returns malformed_state rather than crashing when a completed stage has no siblings', async () => {
    const { org, assessment } = await seedAssessment('comp-malformed-partial', {
      stages: { 'pre-processing': { status: 'completed' } },
    });

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('malformed_state');
  });

  /**
   * The other half of the guard above, and the reason it is a SEPARATE
   * refusal kind rather than a widening of `no_stages`.
   *
   * Before this change `no_stages` had exactly ONE positive assertion in
   * the whole suite -- the `engineState lacks .stages entirely` case above,
   * which this task moves to `malformed_state`. Widening the structural
   * guard without this test would have left `no_stages` with no assertion
   * at all: deleting its branch would keep the suite green, and the two
   * refusals ("your state is corrupt" and "you have not finished a stage
   * yet") would be free to collapse into one message unnoticed -- the
   * exact failure Task 6 named when its drift 409 and completed 409 shared
   * wording.
   *
   * A WELL-FORMED state with nothing completed must still take the
   * `no_stages` branch, which is the user-actionable one.
   */
  it('still returns no_stages -- not malformed_state -- for a well-formed state with no completed stage', async () => {
    const { org, assessment } = await seedAssessment('comp-wellformed-incomplete', createAssessment());

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('no_stages');
  });
});

/**
 * Task 6 (maturity-band-reanchor). `Assessment.scoringVersion` is
 * denormalised out of `reportData.scoringVersion` at completion so list
 * surfaces (project list, dashboard, compare) can read the methodology a
 * report was scored under without loading the whole JSONB blob -- Task 7
 * uses it to decide whether a report may carry a verdict label at all.
 *
 * Both writes below go through the SAME `data:` object as
 * `overallScore`/`reportData` (`lib/data/assessments.ts`'s sole remaining
 * `tx.assessment.update(` inside `completeAssessment` -- `respondToAssessment`'s
 * own `tx.assessment.update(` writes only `engineState` and never touches
 * this column), so the row and the cached blob cannot disagree by
 * construction: both are read off the one `reportData` object
 * `generateReportData` returns.
 *
 * The write-once trigger (`trg_assessments_scoring_version_write_once`,
 * migration `20260826150000_add_assessment_scoring_version`) is modelled on
 * `trg_assessments_framework_version_write_once` but with a WHEN clause that
 * must differ in one way: this column starts NULL and is written once AT
 * completion, so NULL -> value must be ALLOWED and only value -> different
 * value rejected. The first test below proves the allowed direction (a
 * completing assessment can still be completed at all); the second proves
 * the DB, not just application code, refuses the disallowed direction --
 * exercised directly against `testDb` so a regression that let application
 * code bypass the trigger would still be caught.
 */
describe('completeAssessment -- scoringVersion write-once (Task 6)', () => {
  beforeEach(() => resetDb());

  it('records the scoring version on the row, matching the cached blob', async () => {
    const seededState = completeStage(
      setResponse(createAssessment(), 'pre-processing', 'q1', 4),
      'pre-processing',
      { skipValidation: true },
    );
    const { org, assessment } = await seedAssessment('sv-a', seededState);

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);
    expect(result.kind).toBe('completed');

    const row = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    const blob = row.reportData as { scoringVersion?: string };
    expect(row.scoringVersion).toBe(SCORING_VERSION);
    expect(row.scoringVersion).toBe(blob.scoringVersion);
  });

  it('refuses to change a recorded scoring version', async () => {
    const seededState = completeStage(
      setResponse(createAssessment(), 'pre-processing', 'q1', 4),
      'pre-processing',
      { skipValidation: true },
    );
    const { org, assessment } = await seedAssessment('sv-b', seededState);
    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);
    expect(result.kind).toBe('completed');

    await expect(
      testDb.assessment.update({
        where: { id: assessment.id },
        data: { scoringVersion: '9.9.9' },
      }),
    ).rejects.toThrow(/write-once/);
  });
});

/**
 * Fix round 2 (Critical, coordinator-found and independently verified before
 * fixing): `completeAssessment` -- NOT `respondToAssessment` -- is the path
 * where O-14's in-progress corruption actually lands. `generateReportData`
 * (`lib/engine/AssessmentEngine.js:20-22`) statically imports CURRENTLY
 * DEPLOYED content files -- so completion always scores the stored
 * `engineState` against whatever is deployed NOW, never against the pin,
 * regardless of what `respondToAssessment` blocks during the in-progress
 * phase. Fix round 1 closing the PATCH path left this path completely open.
 *
 * The check is placed BEFORE the scoring dispatch below, unconditionally.
 * Task 1 (2026-08-26) removed the second (quick-mode) scoring branch this
 * guard used to sit in front of -- see `lib/data/assessments.ts` -- so a
 * single fixture shape now proves the ordering: the case below still uses a
 * placeholder `engineState` (`{}`) that would throw reading `.status` off
 * `undefined` if the drift check did NOT short-circuit before
 * `canGenerateReport` ever runs. The first case, using a REAL
 * `createAssessment()` state instead, shows the ordering matters even for a
 * realistic in-progress assessment (canGenerateReport would return `false`,
 * not throw, so a regression there would still be caught by the differing
 * `kind`, just without a crash).
 */
describe('completeAssessment -- drift check (O-14, completion half)', () => {
  beforeEach(() => {
    withOrgCallCount = 0;
    return resetDb();
  });

  it('rejects completing an in-progress assessment pinned to a framework_versions row whose contentHash cannot match deployed content', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    const { org, assessment } = await seedAssessment('comp-drift-a', createAssessment(), bogusId);

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('drifted');
    expect(withOrgCallCount).toBe(1);

    const stillStored = await testDb.assessment.findUniqueOrThrow({ where: { id: assessment.id } });
    expect(stillStored.status).toBe('in_progress');
    expect(stillStored.reportData).toBeNull();
  });

  it('rejects completing an assessment pinned to a framework_versions row whose contentHash cannot match deployed content -- before canGenerateReport ever runs', async () => {
    const bogusId = await registerBogusFrameworkVersion();
    // Deliberately a placeholder, not a real stage-complete engineState:
    // canGenerateReport(state) would need state.stages['pre-processing']
    // etc. to exist and this would throw reading `.status` off `undefined`
    // if the drift check did NOT short-circuit first. That it does not
    // throw, and returns 'drifted' rather than a crash or 'no_stages', is
    // itself part of the proof the guard runs first.
    const { org, assessment } = await seedAssessment('comp-drift-b', {}, bogusId);

    const result = await completeAssessment(ctx(org.id, 'assessor'), assessment.id);

    expect(result.kind).toBe('drifted');
    expect(withOrgCallCount).toBe(1);
  });

  it('still completes an assessment pinned to the CURRENT (matching) content -- the drift check is not a blanket regression', async () => {
    const seededState = completeStage(
      setResponse(setResponse(createAssessment(), 'pre-processing', 'q1', 4), 'pre-processing', 'q2', 2),
      'pre-processing',
      { skipValidation: true },
    );
    const { org, assessment } = await seedAssessment('comp-drift-c', seededState);

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
      createAssessment(),
      bogusId,
    );
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await completeReq(org.slug, assessment.id);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.toLowerCase()).toContain('drift');
  });

  /**
   * The HTTP shape of `malformed_state`. The lib-level tests above prove
   * `completeAssessment` returns the right KIND; this proves the route maps
   * it to a 400 carrying its OWN message and an audit record -- three
   * separate things, none of which the kind assertion can witness, and all
   * three previously asserted by nothing (code-review lens; silent-failure
   * F-5).
   *
   * The `not.toBe` against the `no_stages` string is the load-bearing
   * assertion, and it is the reason this branch exists as a distinct kind
   * at all. Task 6 established the rule the hard way: when its drift 409
   * and its completed 409 shared one message, deleting either guard left
   * the suite green because no assertion could tell which had fired. Here
   * the two 400s are the pair at risk.
   */
  it('responds 400 for a malformed stored state, with its own message and an audit record', async () => {
    const { org, assessment, user } = await seedAssessment('comp-malformed-route', { stages: {} });
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);
    vi.mocked(logSecurityEvent).mockClear();

    const res = await completeReq(org.slug, assessment.id);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).not.toBe(
      'Complete at least one lifecycle stage before finishing the assessment',
    );
    expect(body.error.toLowerCase()).toContain('not readable');

    const call = vi.mocked(logSecurityEvent).mock.calls.find(
      ([event]) => event === 'INPUT_VALIDATION_FAILURE',
    );
    expect(call?.[2]?.details).toMatchObject({
      route: 'assessment:complete',
      reason: 'malformed_engine_state',
    });
  });

  /**
   * The message must not name a recovery the product cannot perform.
   * Its first draft said "save your answers again to rebuild it", which the
   * PATCH ingress guard added in the SAME change refuses -- a corrupt state
   * re-saved is exactly what that guard rejects, and `autoSave` does not
   * read the status, so the user would not even be told it failed
   * (code-review lens, high). Pinned so the false advice cannot come back.
   */
  it('does not tell the user to re-save, which the ingress guard would refuse', async () => {
    const { org, assessment, user } = await seedAssessment('comp-malformed-advice', { stages: {} });
    await testDb.membership.create({ data: { orgId: org.id, userId: user.id, role: 'assessor' } });
    sessionFor(user.id);

    const res = await completeReq(org.slug, assessment.id);
    const body = await res.json();

    // Targeted at the ADVICE, not at the word. A bare `not.toContain('save')`
    // is wrong here and was caught by this test failing on its first run:
    // the message legitimately says "saved state" when describing what is
    // broken. What must never come back is an instruction to save again.
    expect(body.error).not.toMatch(/re-?sav|sav\w*\b[^.]*\bagain/i);
    // And the message must still name the recovery that DOES work, or it
    // has been trimmed into uselessness rather than into honesty.
    expect(body.error.toLowerCase()).toContain('new assessment');
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
      body: JSON.stringify({ projectId }),
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
