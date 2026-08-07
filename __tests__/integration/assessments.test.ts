import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb, SEEDED_FRAMEWORK_VERSION_ID } from '../helpers/db';
import type { OrgContext } from '../../lib/data/tenant';
import { respondToAssessment, completeAssessment } from '../../lib/data/assessments';

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

async function seedAssessment(slug: string, mode: 'full' | 'quick', engineState: unknown) {
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
      frameworkVersionId: SEEDED_FRAMEWORK_VERSION_ID,
      engineState: engineState as never,
    },
  });
  return { user, org, project, assessment };
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
