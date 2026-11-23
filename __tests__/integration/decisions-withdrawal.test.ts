import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { WithdrawalCode } from '@/types/record';
import type { ContentRef, SaveDecisionRequest, WithdrawDecisionRequest } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import { M11 } from '@/lib/decision/copy';
import { decisionHistory, saveDecision, withdrawDecision } from '@/lib/data/decisions';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let content: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  content = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const actor = (role: OrgRole) => ({ userId: fx.members[role].userId, role });
const body = (over: Partial<SaveDecisionRequest> = {}): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Fixture reason', decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...over,
});
const save = (role: OrgRole, b: SaveDecisionRequest) =>
  saveDecision(ctxFor(fx, role), actor(role), { ...b, projectId: project.id }, requestDigest({ path: { id: project.id }, body: b }));
const countVersions = () => testDb.decisionVersion.count({ where: { projectId: project.id } });
const wd = (role: OrgRole, over: Partial<WithdrawDecisionRequest> = {}) => {
  const b: WithdrawDecisionRequest = { requestId: randomUUID(), stage: 'pre-processing', baseVersionNumber: 2, withdrawalCode: 'entered_in_error', reason: 'Saved on the wrong question.', ...over };
  return withdrawDecision(ctxFor(fx, role), actor(role), { ...b, projectId: project.id, questionId: 'Q-PP-01' }, requestDigest({ path: { id: project.id, questionId: 'Q-PP-01' }, body: b }));
};

describe('withdrawDecision and decisionHistory (FR-DEC-04, FR-DEC-08)', () => {
  it('FR-DEC-08 FR-DEC-04: withdrawing version 2 makes version 3 withdrawn, and the history shows all three newest first', async () => {
    await save('assessor', body());
    await save('assessor', body({ baseVersionNumber: 1, status: 'not_yet', reasonCode: 'ny_planned_later' }));
    const out = await wd('assessor');
    expect(out.value).toMatchObject({ versionNumber: 3, status: 'withdrawn', withdrawalCode: 'entered_in_error', decidedBy: null, declaredDate: null });
    const h = await decisionHistory(ctxFor(fx, 'viewer'), project.id, 'Q-PP-01');
    expect(h.map((v) => [v.versionNumber, v.status])).toEqual([[3, 'withdrawn'], [2, 'not_yet'], [1, 'done']]);
    expect(h[1]).toMatchObject({ reasonCode: 'ny_planned_later', enteredBy: { userId: fx.members.assessor.userId }, enteredByRole: 'assessor',
      content: content, receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) });
  });

  it("FR-DEC-08: an assessor cannot withdraw another member's entry; an owner can", async () => {
    await save('owner', body());
    await save('owner', body({ baseVersionNumber: 1, status: 'partly' }));
    await expect(wd('assessor')).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(await countVersions()).toBe(2);
    await expect(wd('owner')).resolves.toMatchObject({ value: { versionNumber: 3 } });
  });

  it('FR-DEC-08 UX-29: a withdrawal needs a withdrawal code and a reason; a withdrawal cannot be withdrawn', async () => {
    await save('assessor', body());
    await save('assessor', body({ baseVersionNumber: 1, status: 'partly' }));
    await expect(wd('assessor', { reason: '' })).rejects.toMatchObject({ extra: { fields: [{ field: 'reason' }] } });
    await expect(wd('assessor', { withdrawalCode: 'oops' as WithdrawalCode })).rejects.toMatchObject({ extra: { fields: [{ field: 'withdrawalCode' }] } });
    await wd('assessor');
    await expect(wd('assessor', { baseVersionNumber: 3 })).rejects.toMatchObject({ extra: { fields: [{ field: 'baseVersionNumber' }] } });
    await expect(wd('assessor', { baseVersionNumber: 2 })).rejects.toMatchObject({ code: 'base_version_moved' });
    expect(await countVersions()).toBe(3);
  });

  it('answer cost: withdrawal with an empty reason is still refused with M11.reasonMissing', async () => {
    await save('assessor', body());
    await save('assessor', body({ baseVersionNumber: 1, status: 'partly' }));
    await expect(wd('assessor', { reason: '' })).rejects.toMatchObject({ extra: { fields: [{ field: 'reason', message: M11.reasonMissing }] } });
    await expect(wd('assessor', { reason: '   ' })).rejects.toMatchObject({ extra: { fields: [{ field: 'reason', message: M11.reasonMissing }] } });
    expect(await countVersions()).toBe(2);
  });

  it('FR-DEC-05 FR-DEC-08: a withdrawal that loses the version number on the unique index answers 409 with the winner, not 500', async () => {
    // As decisions-versions.test.ts's race: another transaction holds version 3 uncommitted, so the withdrawal reads version
    // 2 as current, passes its checks, and its insert waits on the numbering index, then fails with 23505.
    await save('assessor', body());
    await save('assessor', body({ baseVersionNumber: 1, status: 'partly' }));
    let pending: Promise<unknown> | undefined;
    await testDb.$transaction(async (t) => {
      await t.decisionVersion.create({ data: {
        orgId: fx.org.id, projectId: project.id, stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.contentVersionId,
        versionNumber: 3, baseVersionNumber: 2, status: 'done', reason: 'The winner', enteredById: fx.members.owner.userId, enteredByRole: 'owner',
        requestId: randomUUID(), requestDigest: 'w'.repeat(64),
      } });
      pending = wd('assessor').catch((x) => x);
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await testDb.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the withdrawal never waited on the numbering index');
    }, { timeout: 15000 });
    expect(await pending).toMatchObject({ status: 409, code: 'base_version_moved', extra: { current: { versionNumber: 3, reason: 'The winner' } } });
    expect(await countVersions()).toBe(3);
  });

  it('FR-AUTHZ-01: called without the route gate, the services still refuse a reviewer and a viewer and write nothing', async () => {
    await save('assessor', body());
    for (const role of ['reviewer', 'viewer'] as const) {
      await expect(save(role, body({ baseVersionNumber: 1, status: 'partly' }))).rejects.toMatchObject({ name: 'ForbiddenError' });
      await expect(wd(role, { baseVersionNumber: 1 })).rejects.toMatchObject({ name: 'ForbiddenError' });
    }
    expect(await countVersions()).toBe(1);
  });
});
