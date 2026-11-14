import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { AddMitigationRequest, MitigationVersionView, UpdateMitigationRequest } from '@/types/api';
import type { WriteOutcome } from '@/types/record';
import { requestDigest } from '@/lib/data/idempotency';
import type { OrgContext } from '@/lib/data/tenant';
import { addMitigation, findingDetail, mitigationOwnerCandidates, updateMitigation } from '@/lib/data/findings';
import { toResponse } from '@/lib/http/toResponse';
import { resetDb, testDb } from '../helpers/db';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { addEvidence, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { FINDINGS_COPY } from '@/lib/findings/copy';

let fx: OrgFixture;
let p: { id: string };
let f: { id: string };
let ctx: OrgContext;
let ev: { id: string };

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  p = await addProject(fx);
  f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  ctx = ctxFor(fx, 'assessor');
  ev = await addEvidence(fx, p.id, { kind: 'file' });
});

const actor = (role: OrgRole = 'assessor') => ({ userId: fx.members[role].userId, role });
const ADD = (): AddMitigationRequest => ({
  requestId: randomUUID(), what: 'Relabel the minority class', ownerUserId: fx.members.assessor.userId, dueDate: '2026-11-10',
  status: 'planned', followsControl: null, closureNote: null, cancelReason: null, evidenceIds: [],
});
type M = WriteOutcome<MitigationVersionView>;
function add(over: Partial<AddMitigationRequest>, at: { projectId?: string; findingId?: string; role?: OrgRole } = {}): Promise<M> {
  const body = { ...ADD(), ...over };
  const path = { id: at.projectId ?? p.id, findingId: at.findingId ?? f.id };
  return addMitigation(ctxFor(fx, at.role ?? 'assessor'), actor(at.role), { ...body, projectId: path.id, findingId: path.findingId },
    requestDigest({ path, body }));
}
function update(m: Pick<M, 'value'> | { value: { mitigationId: string } }, over: Partial<UpdateMitigationRequest>, findingId = f.id): Promise<M> {
  const body: UpdateMitigationRequest = { ...ADD(), baseVersionNumber: 1, changeNote: null, ...over };
  const path = { id: p.id, findingId, mitigationId: m.value.mitigationId };
  return updateMitigation(ctx, actor(), { ...body, projectId: p.id, findingId, mitigationId: m.value.mitigationId }, requestDigest({ path, body }));
}
const versions = async (mitigationId: string) =>
  (await testDb.mitigationVersion.findMany({ where: { mitigationId }, orderBy: { versionNumber: 'asc' } })).map((v) => v.versionNumber);
const toVersion2 = async () => { const m = await add({}); await update(m, { baseVersionNumber: 1, status: 'in_progress' }); return m; };
const closeByMitigation = (finding: { id: string }) => addMitigationVersion(fx, finding.id, { status: 'done', owner: 'assessor', dueDate: '2026-11-10' });
/** The HTTP answer a route would give for the refusal (NotFoundError and ForbiddenError carry no status of their own). */
const answer = async (pr: Promise<unknown>) => {
  try { await pr; } catch (e) { const r = toResponse(e); return { status: r.status, ...(await r.json()) }; }
  throw new Error('expected a refusal');
};

/** Deletes the member's membership and records its removal, as MEM's removal does, through `testDb`. */
async function removedMemberOf(role: OrgRole): Promise<string> {
  const extra = await buildOrg();
  const userId = extra.members[role].userId;
  await testDb.membership.create({ data: { orgId: fx.org.id, userId, role } });
  await testDb.membership.deleteMany({ where: { orgId: fx.org.id, userId } });
  await testDb.$executeRaw`INSERT INTO organisation_events (id, "orgId", "actorId", "actorRole", action, "targetUserId")
    VALUES (gen_random_uuid()::text, ${fx.org.id}, ${fx.members.owner.userId}, 'owner', 'member_removed', ${userId})`;
  return userId;
}

describe('addMitigation, updateMitigation and mitigationOwnerCandidates (FR-FND-03, FR-FND-04)', () => {
  it('FR-FND-03 UX-16: a viewer, a former member or a stranger as owner answers 422 "Choose an owner."', async () => {
    const removedMember = await removedMemberOf('assessor');
    const stranger = (await buildOrg()).members.owner.userId;
    for (const owner of [fx.members.viewer.userId, fx.members.reviewer.userId, removedMember, stranger, 'no-such-user'])
      await expect(add({ ownerUserId: owner })).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId }] } });
    expect(await testDb.mitigationVersion.count()).toBe(0);
  });

  it('FR-FND-03 UX-16: a suspended member cannot own a mitigation', async () => {
    await testDb.membership.update({ where: { orgId_userId: { orgId: fx.org.id, userId: fx.members.admin.userId } }, data: { status: 'suspended' } });
    await expect(add({ ownerUserId: fx.members.admin.userId })).rejects.toMatchObject({ status: 422 });
  });

  it('UX-16: the owner list holds owners, admins and assessors only, by name', async () => {
    const owners = await mitigationOwnerCandidates(ctx);
    expect(owners.map((u) => u.userId).sort()).toEqual([fx.members.owner.userId, fx.members.admin.userId, fx.members.assessor.userId].sort());
    expect(owners.map((u) => u.name)).toEqual([...owners.map((u) => u.name)].sort((a, b) => a.localeCompare(b)));
    expect(owners.every((u) => u.formerMember === false)).toBe(true);
  });

  it('FR-FND-03: version 1 answers the view, numbered 1 with no base, kind action, with the next findingSeq', async () => {
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'admin', dueDate: '2026-12-01' });   // findingSeq 1
    const m = await add({});
    expect(m.replayed).toBe(false);
    expect(m.value).toMatchObject({
      findingId: f.id, versionNumber: 1, baseVersionNumber: null, kind: 'action', status: 'planned', what: 'Relabel the minority class',
      owner: { userId: fx.members.assessor.userId, formerMember: false }, dueDate: '2026-11-10', findingSeq: 2, changeNote: null,
      closureDecisionVersionId: null, evidence: [], erasedFields: [],
    });
  });

  it('FR-FND-03: two status changes make three versions', async () => {
    const v1 = await add({ status: 'planned' }); await update(v1, { baseVersionNumber: 1, status: 'in_progress' });
    await update(v1, { baseVersionNumber: 2, status: 'in_progress', what: 'Relabel' });
    expect(await versions(v1.value.mitigationId)).toEqual([1, 2, 3]);
  });

  it('FR-FND-03: two updates based on version 2: one creates version 3, the other answers 409 with version 3', async () => {
    for (let i = 0; i < 10; i++) {
      const m = await toVersion2();
      const r = await Promise.allSettled([update(m, { baseVersionNumber: 2, status: 'in_progress', what: 'A' }), update(m, { baseVersionNumber: 2, status: 'in_progress', what: 'B' })]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ status: 409, code: 'base_version_moved', extra: { current: { versionNumber: 3 } } });
      expect(await versions(m.value.mitigationId)).toEqual([1, 2, 3]);
    }
  });

  it('FR-FND-03: moving the due date later without a change note answers 422; earlier needs none', async () => {
    const m = await add({ dueDate: '2026-11-10' });
    await expect(update(m, { baseVersionNumber: 1, dueDate: '2026-11-20', changeNote: null })).rejects.toMatchObject({
      status: 422, extra: { fields: [{ field: 'changeNote', message: 'Say why the date changed.' }] } });
    await expect(update(m, { baseVersionNumber: 1, dueDate: '2026-11-05', changeNote: null })).resolves.toMatchObject({ replayed: false });
    const later = await update(m, { baseVersionNumber: 2, dueDate: '2026-12-05', changeNote: 'Labeller unavailable' });
    expect(later.value).toMatchObject({ versionNumber: 3, dueDate: '2026-12-05', changeNote: 'Labeller unavailable', baseVersionNumber: 2 });
  });

  it('FR-FND-03: cancelling without a reason answers 422, and a cancelled mitigation cannot change again', async () => {
    const m = await add({});
    await expect(update(m, { baseVersionNumber: 1, status: 'cancelled', cancelReason: null })).rejects.toMatchObject({ status: 422 });
    await update(m, { baseVersionNumber: 1, status: 'cancelled', cancelReason: 'Out of scope' });
    await expect(update(m, { baseVersionNumber: 2, status: 'planned' })).rejects.toMatchObject({
      status: 422, extra: { fields: [{ field: 'status', message: 'A cancelled mitigation cannot be changed.' }] } });
  });

  it('FR-FND-03: adding a mitigation to a closed finding answers 409, naming who closed it and when', async () => {
    await closeByMitigation(f);
    await expect(add({})).rejects.toMatchObject({ status: 409, code: 'finding_not_open',
      extra: { current: { state: 'closed_mitigation', by: { userId: fx.members.assessor.userId }, at: expect.any(String) } } });
    const m = await testDb.mitigationVersion.findFirstOrThrow({ where: { findingId: f.id } });
    await expect(update({ value: { mitigationId: m.mitigationId } }, { baseVersionNumber: 1 })).rejects.toMatchObject({ status: 409, code: 'finding_not_open' });
  });

  it('FR-FND-04: done with no evidence and no note answers 422; with a note it saves and the note is kept', async () => {
    await expect(add({ status: 'done', evidenceIds: [], closureNote: null })).rejects.toMatchObject({
      status: 422, extra: { fields: [{ field: 'closureNote', message: FINDINGS_COPY.fields.closureNote }] } });
    expect((await add({ status: 'done', evidenceIds: [], closureNote: 'Deployment stopped' })).value).toMatchObject({ status: 'done', closureNote: 'Deployment stopped', evidence: [] });
  });

  it('FR-FND-04: done with one evidence item closes the finding; evidence of another project answers 422', async () => {
    const evOfOtherProject = await addEvidence(fx, (await addProject(fx)).id, { kind: 'file' });
    await expect(add({ status: 'done', evidenceIds: [evOfOtherProject.id] })).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'evidenceIds' }] } });
    const done = await add({ status: 'done', evidenceIds: [ev.id] });
    expect(done.value.evidence.map((e) => e.id)).toEqual([ev.id]);
    expect((await findingDetail(ctx, p.id, f.id)).state).toBe('closed_mitigation');
  });

  it('NFR-SEC-02: a finding of another project or organisation answers 404 and a mitigation of another finding 404', async () => {
    const otherProject = await addProject(fx);
    expect(await answer(add({}, { projectId: otherProject.id }))).toMatchObject({ status: 404, code: 'not_found' });
    const other = await buildOrg(); const op = await addProject(other);
    const of = await addFinding(other, op.id, { stage: 'pre-processing', source: 'team' });
    expect(await answer(add({}, { projectId: op.id, findingId: of.id }))).toMatchObject({ status: 404 });
    expect(await answer(add({}, { findingId: of.id }))).toMatchObject({ status: 404 });
    const g = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const mitigationOfOtherFinding = (await addMitigationVersion(fx, g.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-10' })).mitigationId;
    expect(await answer(update({ value: { mitigationId: mitigationOfOtherFinding } }, { baseVersionNumber: 1 }))).toMatchObject({ status: 404 });
    expect(await testDb.mitigationVersion.count({ where: { findingId: f.id } })).toBe(0);
  });

  it('FR-AUTHZ-01: the service refuses a role without mitigation:write', async () => {
    for (const role of ['reviewer', 'viewer'] as const) expect(await answer(add({}, { role }))).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('FR-ORG-09 FR-DEC-09: entered by, role at the time and received time come from the session and the database', async () => {
    const m = (await add({ enteredById: 'forged', enteredByRole: 'owner', receivedAt: '2000-01-01T00:00:00Z' } as never)).value;
    expect(m).toMatchObject({ enteredBy: { userId: fx.members.assessor.userId }, enteredByRole: 'assessor' });
    expect(new Date(m.receivedAt).getUTCFullYear()).toBe(2026);
  });

  it('FR-DEC-07 NFR-INT-02: the same request replays the first version; another body under the id answers 409 request_id_reused', async () => {
    const body = ADD(); const path = { id: p.id, findingId: f.id };
    const call = (b: AddMitigationRequest) => addMitigation(ctx, actor(), { ...b, projectId: p.id, findingId: f.id }, requestDigest({ path, body: b }));
    const first = await call(body); const again = await call(body);
    expect(again).toMatchObject({ replayed: true, value: { id: first.value.id } });
    await expect(call({ ...body, what: 'Another' })).rejects.toMatchObject({ status: 409, code: 'request_id_reused' });
    expect(await testDb.mitigationVersion.count()).toBe(1);
  });

  it('NFR-OBS-01 NFR-PRIV-03: a done version that closes the finding logs FINDING_CLOSED once with ids and no text', async () => {
    const { lines } = await captureLogs(async () => {
      await add({ status: 'planned', what: markerFor('what', 1) });
      await add({ status: 'done', evidenceIds: [], closureNote: markerFor('closureNote', 2) }, { role: 'assessor' });
    });
    expect(lines.filter((l) => l.includes('FINDING_CLOSED'))).toHaveLength(0);   // a planned mitigation keeps it open
    const open = await testDb.mitigationVersion.findFirstOrThrow({ where: { findingId: f.id, status: 'planned' } });
    const { lines: closing } = await captureLogs(() => update({ value: { mitigationId: open.mitigationId } },
      { baseVersionNumber: 1, status: 'done', evidenceIds: [ev.id], what: markerFor('what', 3) }));
    expect(closing.filter((l) => l.includes('FINDING_CLOSED'))).toHaveLength(1);
    expect(closing.find((l) => l.includes('FINDING_CLOSED'))).toContain(f.id);
    expect(scanLines([...lines, ...closing], { markers: true, emails: true })).toEqual([]);
  });

  it('FR-FND-03: followsControl null needs no content; an unknown control id answers 422', async () => {
    await expect(add({ followsControl: 'NO-SUCH-CONTROL' })).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'followsControl' }] } });
  });

  it('FR-FND-03 F12: a padded text is stored trimmed, as the length it was checked at; a NUL owner id answers 422, not 500', async () => {
    const m = await add({ what: 'x'.repeat(3990) + ' '.repeat(1010) });
    expect((await testDb.mitigationVersion.findUniqueOrThrow({ where: { id: m.value.id } })).what).toHaveLength(3990);
    await expect(add({ ownerUserId: 'a\u0000b' })).rejects.toMatchObject({ status: 422, extra: { fields: [{ field: 'ownerUserId', message: FINDINGS_COPY.fields.ownerUserId }] } });
  });
});
