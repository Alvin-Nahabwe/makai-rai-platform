import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hash } from 'bcryptjs';
import { NextRequest } from 'next/server';
import { clearSession, sessionFor } from '../helpers/authSession';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { addDecision, addFinding, addMitigationVersion, addProject, buildOrg, buildPlatformAdmin, ctxFor, type FixtureMember, type OrgFixture } from '../helpers/recordFixture';
import { DELETE } from '../../app/api/users/me/route';
import { deleteAccount } from '../../lib/data/export';
import { authorizeCredentials } from '../../lib/auth/credentials';
import { withOrg } from '../../lib/data/tenant';
import { userRefs } from '../../lib/data/views';
import * as identityReads from '../../lib/data/identityReads';

/**
 * Route 39 and deleteAccount (00-contract.md, Routes row 39, Services lib/data/export.ts; FR-EXP-03,
 * FR-EXP-04, FR-ORG-09). A person deletes their account after re-entering the password and typing the
 * phrase; the last owner with an active account of an organisation is refused, naming it (M-38).
 */

const PHRASE = 'DELETE MY ACCOUNT';
const m38 = (org: string) => `You are the only owner of ${org} with an active account. Make someone else an owner first, then delete your account.`;
let contentVersionId: string;

function req(body: unknown, origin?: string): NextRequest {
  return new NextRequest('http://localhost/api/users/me', {
    method: 'DELETE',
    headers: { host: 'localhost', 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}
async function deleteAs(m: FixtureMember, body: unknown = { password: m.password, phrase: PHRASE }): Promise<Response> {
  sessionFor(m.userId);
  return DELETE(req(body));
}
/** An account and an active membership of `fx` as `role`, written through testDb. */
async function extraMember(fx: OrgFixture, role: 'owner' | 'viewer', a: { isActive?: boolean } = {}): Promise<FixtureMember> {
  const password = 'FixturePass123!';
  const email = `extra-${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
  const user = await testDb.user.create({ data: { email, name: `Extra ${role}`, passwordHash: await hash(password, 4), isActive: a.isActive ?? true } });
  await testDb.membership.create({ data: { orgId: fx.org.id, userId: user.id, role } });
  return { userId: user.id, email, name: `Extra ${role}`, password, role, orgId: fx.org.id, orgSlug: fx.org.slug };
}
/** consent_records' update and delete counters, flushed first so this backend's own counts are visible. */
async function consentTableStats(): Promise<{ upd: bigint; del: bigint }> {
  await testDb.$executeRaw`SELECT pg_stat_force_next_flush()`;
  const [row] = await testDb.$queryRaw<{ upd: bigint; del: bigint }[]>`
    SELECT n_tup_upd AS upd, n_tup_del AS del FROM pg_stat_user_tables WHERE relname = 'consent_records'`;
  return row;
}

beforeAll(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
});
beforeEach(() => clearSession());
afterEach(() => vi.restoreAllMocks());

describe('route 39, DELETE /api/users/me', () => {
  it('FR-EXP-03 M-38: a last owner gets 409 naming the organisation', async () => {
    const fx = await buildOrg({ label: 'delowner' });
    const r = await deleteAs(fx.members.owner);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'last_active_owner', organisation: fx.org.name, error: m38(fx.org.name) });
    expect(await testDb.membership.count({ where: { userId: fx.members.owner.userId } })).toBe(1);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: fx.members.owner.userId } })).isActive).toBe(true);
  });

  it('FR-EXP-03: an owner whose co-owner is deactivated gets 409 naming the organisation', async () => {
    const fx = await buildOrg({ label: 'deldeact' });
    await extraMember(fx, 'owner', { isActive: false });
    const r = await deleteAs(fx.members.owner);
    expect([r.status, (await r.json()).organisation]).toEqual([409, fx.org.name]);
  });

  it('FR-EXP-03: an owner with an active co-owner can delete, and the organisation keeps one owner', async () => {
    const fx = await buildOrg({ label: 'delcoown' });
    const other = await extraMember(fx, 'owner');
    expect((await deleteAs(fx.members.owner)).status).toBe(204);
    expect(await testDb.membership.findMany({ where: { orgId: fx.org.id, role: 'owner' }, select: { userId: true } })).toEqual([{ userId: other.userId }]);
  });

  it('FR-EXP-03: two co-owners deleting at once leave one owner', async () => {
    const fx = await buildOrg({ label: 'delrace' });
    const other = await extraMember(fx, 'owner');
    // Both pass phase 1 (each sees the other's active account), as when the two requests arrive together:
    // only phase 2's locked re-count can then keep one owner.
    vi.spyOn(identityReads, 'lastActiveOwnerOf').mockResolvedValue([]);
    const results = await Promise.allSettled([
      deleteAccount(fx.members.owner.userId, { password: fx.members.owner.password, phrase: PHRASE }),
      deleteAccount(other.userId, { password: other.password, phrase: PHRASE }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409, code: 'last_active_owner', extra: { organisation: fx.org.name } });
    expect(await testDb.membership.count({ where: { orgId: fx.org.id, role: 'owner' } })).toBe(1);
  });

  it('FR-EXP-03 UX-29: a wrong password or phrase answers 422 with the S-21 texts and deletes nothing', async () => {
    const fx = await buildOrg({ label: 'del422' });
    const assessor = fx.members.assessor;
    const bad = await deleteAs(assessor, { password: 'wrong', phrase: PHRASE });
    expect([bad.status, (await bad.json()).fields[0]]).toEqual([422, { field: 'password', message: 'The password is not right.' }]);
    const phrase = await deleteAs(assessor, { password: assessor.password, phrase: 'delete my account' });
    expect([phrase.status, (await phrase.json()).fields[0]]).toEqual([422, { field: 'phrase', message: 'Type DELETE MY ACCOUNT exactly.' }]);
    for (const body of [{}, { password: 1, phrase: PHRASE }, { password: assessor.password }, 'DELETE MY ACCOUNT']) {
      expect((await deleteAs(assessor, body)).status).toBe(422);
    }
    expect(await testDb.membership.count({ where: { userId: assessor.userId } })).toBe(1);
    expect((await testDb.user.findUniqueOrThrow({ where: { id: assessor.userId } })).isActive).toBe(true);
  });

  it('FR-EXP-03: after deletion the assessor cannot sign in, has no membership, shows as Deleted user, and every session ends', async () => {
    const fx = await buildOrg({ label: 'deldone' });
    const assessor = fx.members.assessor;
    const projectId = (await addProject(fx)).id;
    const q = { stage: 'pre-processing' as const, questionId: FIXTURE_QUESTION_IDS[0], contentVersionId };
    const decision = await addDecision(fx, projectId, { ...q, status: 'partly', by: 'assessor' });
    const finding = await addFinding(fx, projectId, { stage: q.stage, source: 'shortfall', questionId: q.questionId, decisionVersionId: decision.id });
    await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: new Date().toISOString().slice(0, 10) });
    const epochBefore = (await testDb.user.findUniqueOrThrow({ where: { id: assessor.userId } })).sessionEpoch;

    expect((await deleteAs(assessor)).status).toBe(204);
    expect(await authorizeCredentials({ email: assessor.email, password: assessor.password },
      new Request('http://localhost/api/auth/callback/credentials', { method: 'POST' }))).toBeNull();
    expect(await testDb.membership.count({ where: { userId: assessor.userId } })).toBe(0);
    expect((await withOrg(ctxFor(fx, 'admin'), (tx) => userRefs(tx, [assessor.userId]))).get(assessor.userId)).toMatchObject({ name: 'Deleted user', formerMember: true });
    const after = await testDb.user.findUniqueOrThrow({ where: { id: assessor.userId } });
    expect([after.sessionEpoch, after.isActive, after.email === assessor.email]).toEqual([epochBefore + 1, false, false]);
    // The records stay, attributed to the scrubbed account (FR-EXP-03 "keep the records they entered").
    expect(await testDb.decisionVersion.count({ where: { id: decision.id, enteredById: assessor.userId } })).toBe(1);
    // FR-EXP-03 "stop reminders": the runReminders(dueDayAt0700EAT) assertion is added when unit/fup merges
    // (EXP.md Stop and report 6); it is not part of this commit.
  });

  it('FR-EXP-03 FR-ORG-09: deletion writes one member_left row per organisation', async () => {
    const fx = await buildOrg({ label: 'delone' });
    const second = await buildOrg({ label: 'deltwo' });
    const assessor = fx.members.assessor;
    await testDb.membership.create({ data: { orgId: second.org.id, userId: assessor.userId, role: 'viewer' } });
    expect((await deleteAs(assessor)).status).toBe(204);
    const rows = await testDb.organisationEvent.findMany({ where: { targetUserId: assessor.userId }, orderBy: { orgId: 'asc' } });
    expect(rows.map((r) => [r.orgId, r.action, r.actorId, r.actorRole]).sort()).toEqual([
      [fx.org.id, 'member_left', assessor.userId, 'assessor'], [second.org.id, 'member_left', assessor.userId, 'viewer'],
    ].sort());
  });

  it('FR-EXP-04: acceptance rows survive deletion unchanged and the deletion issued no UPDATE or DELETE on consent_records', async () => {
    const fx = await buildOrg({ label: 'delacc' });
    const assessor = fx.members.assessor;
    const before = await testDb.consentRecord.findMany({ where: { userId: assessor.userId }, orderBy: { id: 'asc' } });
    const stats0 = await consentTableStats();
    expect((await deleteAs(assessor)).status).toBe(204);
    const after = await testDb.consentRecord.findMany({ where: { userId: assessor.userId }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.ipAddress === null)).toBe(true);
    expect(await consentTableStats()).toEqual(stats0);
    // What actually forbids a change (the counters above see only flushed statistics): K0a's refusal trigger.
    expect(await testDb.$queryRaw<{ e: string }[]>`SELECT event_manipulation AS e FROM information_schema.triggers
      WHERE event_object_table = 'consent_records' AND trigger_name = 'consent_records_refuse_row' ORDER BY 1`).toEqual([{ e: 'DELETE' }, { e: 'UPDATE' }]);
  });

  it('FR-ORG-03 FR-EXP-03: the platform administrator account answers 409 platform_admin_account and nothing changes', async () => {
    const admin = await buildPlatformAdmin();
    const before = await testDb.user.findUniqueOrThrow({ where: { id: admin.userId } });
    sessionFor(admin.userId);
    const { result: r, lines } = await captureLogs(() => DELETE(req({ password: admin.password, phrase: PHRASE })));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: 'platform_admin_account',
      error: "The platform administrator's account cannot be deleted here. Ask the operator to hand the role over first." });
    expect(await testDb.user.findUniqueOrThrow({ where: { id: admin.userId } })).toEqual(before);
    expect(lines.some((l) => l.includes('ACCOUNT_DELETED'))).toBe(false);
  });

  it('NFR-SEC-08: a cross-site DELETE answers 403', async () => {
    const fx = await buildOrg({ label: 'delcsrf' });
    sessionFor(fx.members.assessor.userId);
    const r = await DELETE(req({ password: fx.members.assessor.password, phrase: PHRASE }, 'https://evil.example'));
    expect([r.status, (await r.json()).code]).toEqual([403, 'cross_origin']);
    expect(await testDb.membership.count({ where: { userId: fx.members.assessor.userId } })).toBe(1);
  });

  it('FR-EXP-03 FR-ACC-04: a person missing an acceptance can still delete their account', async () => {
    const fx = await buildOrg({ label: 'delprev1', acceptances: 'pre-v1' });
    expect((await deleteAs(fx.members.assessor)).status).toBe(204);
  });

  it('NFR-OBS-01: one ACCOUNT_DELETED line with the user id only', async () => {
    const fx = await buildOrg({ label: 'dellog' });
    const assessor = fx.members.assessor;
    const { result, lines } = await captureLogs(() => deleteAs(assessor));
    expect(result.status).toBe(204);
    const deleted = lines.filter((l) => l.includes('ACCOUNT_DELETED')).map((l) => JSON.parse(l));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ event: 'ACCOUNT_DELETED', userId: assessor.userId });
    expect(deleted[0].details ?? {}).toEqual({});
    expect(lines.some((l) => l.includes('ACCOUNT_DEACTIVATED'))).toBe(false);
    expect(scanLines(lines, { markers: false, emails: true })).toEqual([]);
  });
});
