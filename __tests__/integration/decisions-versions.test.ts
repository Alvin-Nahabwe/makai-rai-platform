import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { ContentRef, SaveDecisionRequest } from '@/types/api';
import { requestDigest } from '@/lib/data/idempotency';
import { withOrg } from '@/lib/data/tenant';
import { currentDecisionRows, currentDecisions, saveDecision } from '@/lib/data/decisions';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { addDecision, addEvidence, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

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

/** Deletes the member's membership and records its removal, as MEM's removal does, through `testDb`. */
async function removeMember(f: OrgFixture, role: OrgRole): Promise<string> {
  const userId = f.members[role].userId;
  await testDb.membership.deleteMany({ where: { orgId: f.org.id, userId } });
  await testDb.$executeRaw`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action, "targetUserId")
    VALUES (gen_random_uuid()::text, ${f.org.id}, ${f.members.owner.userId}, 'owner', 'member_removed', ${userId})`;
  return userId;
}

/**
 * Inserts version 1 of the question with a received time the database clock would not give, through `testDb`, with the
 * received-time trigger disabled by name for that one insert; the trigger is found by its function body, so this does not
 * depend on its name, and its `tgenabled` mode is restored and checked.
 */
async function addFutureVersion1(f: OrgFixture, projectId: string, questionId: string, receivedAt: string): Promise<void> {
  const triggers = await testDb.$queryRaw<{ tgname: string; tgenabled: string }[]>`
    SELECT t.tgname, t.tgenabled::text AS tgenabled FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE t.tgrelid = 'decision_versions'::regclass AND p.prosrc LIKE '%clock_timestamp%'`;
  expect(triggers).toHaveLength(1);
  const [{ tgname, tgenabled }] = triggers;
  const restore = { A: 'ENABLE ALWAYS', R: 'ENABLE REPLICA', O: 'ENABLE', D: 'DISABLE' }[tgenabled];
  if (restore === undefined) throw new Error(`unknown tgenabled ${tgenabled}`);
  const name = `"${tgname.replace(/"/g, '""')}"`;
  await testDb.$executeRawUnsafe(`ALTER TABLE decision_versions DISABLE TRIGGER ${name}`);
  try {
    await testDb.decisionVersion.create({ data: {
      orgId: f.org.id, projectId, stage: 'pre-processing', questionId, contentVersionId: content.contentVersionId, versionNumber: 1,
      status: 'done', reason: 'From a host whose clock ran ahead', enteredById: f.members.assessor.userId, enteredByRole: 'assessor',
      receivedAt: new Date(receivedAt), requestId: randomUUID(), requestDigest: 'x'.repeat(64),
    } });
  } finally {
    await testDb.$executeRawUnsafe(`ALTER TABLE decision_versions ${restore} TRIGGER ${name}`);
  }
  const [after] = await testDb.$queryRaw<{ tgenabled: string }[]>`SELECT tgenabled::text AS tgenabled FROM pg_trigger WHERE tgrelid = 'decision_versions'::regclass AND tgname = ${tgname}`;
  expect(after.tgenabled).toBe(tgenabled);
}

describe('saveDecision: versions, base check and server-set fields', () => {
  it('FR-DEC-01: a save with all fields answers a new version whose fields equal the input', async () => {
    const ev = await addEvidence(fx, project.id, { kind: 'link', url: 'https://example.org/memo' });
    const b = body({ status: 'partly', reason: 'Memo covers accuracy only.', declaredDate: '2026-10', evidenceIds: [ev.id],
      decidedBy: { kind: 'outside_role', role: 'principal_investigator' } });
    const out = await save('assessor', b);
    expect(out.replayed).toBe(false);
    expect(out.value).toMatchObject({ versionNumber: 1, baseVersionNumber: null, status: 'partly', reason: b.reason, declaredDate: '2026-10',
      declaredPrecision: 'month', decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, evidence: [expect.objectContaining({ id: ev.id })] });
  });

  it('FR-DEC-01 FR-DEC-02: a former member is accepted as decider and marked "(former member)"', async () => {
    const former = await removeMember(fx, 'viewer');
    const out = await save('assessor', body({ decidedBy: { kind: 'member', userId: former } }));
    expect(out.value.decidedBy).toEqual({ kind: 'member', user: { userId: former, name: expect.any(String), formerMember: true } });
  });

  it('FR-DEC-03: three saves make versions 1, 2, 3; UPDATE and DELETE fail for makrai_app and makrai', async () => {
    const v1 = await save('assessor', body());
    const v2 = await save('assessor', body({ baseVersionNumber: 1, status: 'partly' }));
    const v3 = await save('assessor', body({ baseVersionNumber: 2, status: 'done', reason: 'Now in place.' }));
    expect([v1, v2, v3].map((o) => o.value.versionNumber)).toEqual([1, 2, 3]);
    await expect(withOrg(ctxFor(fx, 'owner'), (tx) => tx.$executeRaw`UPDATE decision_versions SET "versionNumber" = 9`)).rejects.toThrow();
    await expect(withOrg(ctxFor(fx, 'owner'), (tx) => tx.$executeRaw`DELETE FROM decision_versions`)).rejects.toThrow();
    await expect(testDb.$executeRaw`UPDATE decision_versions SET "versionNumber" = 9`).rejects.toThrow();
    await expect(testDb.$executeRaw`DELETE FROM decision_versions`).rejects.toThrow();
    expect(await countVersions()).toBe(3);
  });

  it('FR-DEC-05 NFR-INT-03: a save whose base is not current answers 409 with the current version', async () => {
    await save('assessor', body());
    await save('owner', body({ baseVersionNumber: 1, status: 'partly' }));
    const e = await save('assessor', body({ baseVersionNumber: 1, reason: 'Mine' })).catch((x) => x);
    expect(e).toMatchObject({ status: 409, code: 'base_version_moved', extra: { current: { versionNumber: 2, status: 'partly' } } });
    expect(await countVersions()).toBe(2);
  });

  it('FR-DEC-05: two saves on base 1 make version 2 and a 409 holding version 2; no version 3', async () => {
    await save('assessor', body());
    const outs = await Promise.allSettled([save('assessor', body({ baseVersionNumber: 1, reason: 'A' })), save('owner', body({ baseVersionNumber: 1, reason: 'B' }))]);
    const ok = outs.filter((o) => o.status === 'fulfilled');
    const no = outs.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(no).toHaveLength(1);
    expect(no[0].reason).toMatchObject({ code: 'base_version_moved', extra: { current: { versionNumber: 2 } } });
    expect(await countVersions()).toBe(2);
  });

  it('FR-DEC-05 NFR-INT-03: a save that loses the version number on the unique index answers 409 with the winner, not 500', async () => {
    // Deterministic form of the race: another transaction inserts version 2 and holds it uncommitted, so the save reads
    // version 1 as current, passes its base check, and its own insert of version 2 waits on the numbering index until the
    // other transaction commits, then fails with 23505. Only the unique-violation mapping can turn that into a 409.
    await save('assessor', body());
    let pending: Promise<unknown> | undefined;
    await testDb.$transaction(async (t) => {
      await t.decisionVersion.create({ data: {
        orgId: fx.org.id, projectId: project.id, stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.contentVersionId,
        versionNumber: 2, baseVersionNumber: 1, status: 'partly', reason: 'The winner', enteredById: fx.members.owner.userId, enteredByRole: 'owner',
        requestId: randomUUID(), requestDigest: 'w'.repeat(64),
      } });
      pending = save('assessor', body({ baseVersionNumber: 1, reason: 'The loser' })).catch((x) => x);
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await testDb.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the save never waited on the numbering index');
    }, { timeout: 15000 });
    expect(await pending).toMatchObject({ status: 409, code: 'base_version_moved', extra: { current: { versionNumber: 2, reason: 'The winner' } } });
    expect(await countVersions()).toBe(2);
  });

  it('FR-DEC-01: a save identical to version 2, date and content version included, is refused naming the form', async () => {
    await save('assessor', body());
    const b2 = body({ baseVersionNumber: 1, status: 'partly' });
    await save('assessor', b2);
    const e = await save('assessor', { ...b2, requestId: randomUUID(), baseVersionNumber: 2 }).catch((x) => x);
    expect(e).toMatchObject({ status: 422, extra: { fields: [{ field: 'form', message: 'This is the same as version 2. Change something before saving, or keep version 2.' }] } });
    await expect(save('assessor', { ...b2, requestId: randomUUID(), baseVersionNumber: 2, declaredDate: '2026-10-13' })).resolves.toMatchObject({ value: { versionNumber: 3 } });
  });

  it('FR-DEC-09 NFR-INT-04: entered by, its role and the received time ignore client values', async () => {
    const b = { ...body(), enteredById: fx.members.owner.userId, enteredByRole: 'owner', receivedAt: '2000-01-01T00:00:00.000Z' } as SaveDecisionRequest;
    const out = await save('assessor', b);
    const row = await testDb.$queryRaw<Array<{ enteredById: string; enteredByRole: string; skew: number }>>`
      SELECT "enteredById", "enteredByRole"::text AS "enteredByRole", abs(extract(epoch FROM (now() - "receivedAt"))) AS skew FROM decision_versions WHERE id = ${out.value.id}`;
    expect(row[0]).toMatchObject({ enteredById: fx.members.assessor.userId, enteredByRole: 'assessor' });
    expect(Number(row[0].skew)).toBeLessThan(5);
  });

  it('NFR-INT-04: a received time earlier than the previous version is accepted, not refused', async () => {
    await addFutureVersion1(fx, project.id, 'Q-PP-01', '2100-01-01T00:00:00Z');
    await expect(save('assessor', body({ baseVersionNumber: 1, status: 'partly' }))).resolves.toMatchObject({ value: { versionNumber: 2 } });
  });

  it("FR-DEC-02: the stored content version is the running one, not the body's", async () => {
    const out = await save('assessor', { ...body(), contentVersionId: 'fv_fixture_0_0_2' } as SaveDecisionRequest);
    expect(out.value.content).toEqual(content);
  });

  it('FR-DEC-03: after versions 1 (done), 2 (partly) and 3 (a withdrawal) the current version is 3 and version 4 on base 3 succeeds', async () => {
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.contentVersionId, status: 'done' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.contentVersionId, status: 'partly' });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.contentVersionId, status: 'withdrawn', withdrawalCode: 'duplicate' });
    const cur = await currentDecisions(ctxFor(fx, 'viewer'), project.id, 'pre-processing');
    expect(cur.get('Q-PP-01')).toMatchObject({ versionNumber: 3, status: 'withdrawn' });
    const rows = await withOrg(ctxFor(fx, 'viewer'), (tx) => currentDecisionRows(tx, project.id, 'pre-processing'));
    expect(rows.map((r) => [r.questionId, r.versionNumber, r.status])).toEqual([['Q-PP-01', 3, 'withdrawn']]);
    await expect(save('assessor', body({ baseVersionNumber: 3 }))).resolves.toMatchObject({ value: { versionNumber: 4 } });
  });

  it('NFR-SEC-11 (helper): hostile reason text round-trips unchanged', async () => {
    for (const s of HOSTILE_STRINGS) {
      const out = await save('assessor', body({ questionId: 'Q-PP-02', reason: s, baseVersionNumber: (await countVersions()) || null }));
      expect(out.value.reason).toBe(s);
    }
  });
});
