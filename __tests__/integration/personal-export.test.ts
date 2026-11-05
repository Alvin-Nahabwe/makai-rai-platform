import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearSession, sessionFor } from '../helpers/authSession';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import { MARKER_PATTERN, markerText } from '../helpers/markers';
import { addDecision, addFinding, addMitigationVersion, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { GET } from '../../app/api/users/me/export/route';
import { PERSONAL_ITEM_TABLES } from '../../lib/data/export';
import { createHash, randomUUID } from 'node:crypto';
import type { PersonalExport } from '../../types/api';

/**
 * Route 38 and personalExport (00-contract.md, Routes row 38, Services lib/data/export.ts; FR-EXP-02,
 * NFR-PRIV-08, SRS 6.4): a person's own data as one JSON file, with the records they entered or were
 * named in listed by organisation, type, id and date, and none of the organisation's record text.
 */

let contentVersionId: string;
const q = () => ({ stage: 'pre-processing' as const, questionId: FIXTURE_QUESTION_IDS[0], contentVersionId });

async function exportOf(userId: string): Promise<{ status: number; body: PersonalExport; disposition: string | null; cacheControl: string | null }> {
  sessionFor(userId);
  const res = await GET();
  return { status: res.status, body: (await res.json()) as PersonalExport, disposition: res.headers.get('content-disposition'), cacheControl: res.headers.get('cache-control') };
}

/** An assessor who entered 3 decisions decided by an outside role, and owns 1 mitigation the admin entered. */
async function fourItems(fx: OrgFixture): Promise<void> {
  const projectId = (await addProject(fx)).id;
  for (let i = 0; i < 3; i++) {
    await addDecision(fx, projectId, { ...q(), status: 'done', by: 'assessor', decidedBy: { kind: 'outside_role', role: 'funder' } });
  }
  const finding = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', by: 'admin' });
  await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01', by: 'admin' });
}

beforeAll(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
});
beforeEach(() => clearSession());

describe('route 38, GET /api/users/me/export', () => {
  it('FR-EXP-02: given 3 decisions entered and 1 mitigation owned, the export lists 4 items with ids and dates and no reason text', async () => {
    const fx = await buildOrg({ label: 'pe4', text: markerText });
    await fourItems(fx);
    const { status, body, disposition, cacheControl } = await exportOf(fx.members.assessor.userId);
    expect(status).toBe(200);
    expect(disposition).toMatch(/^attachment; filename="makrai-export-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(cacheControl).toBe('no-store'); // personal data is not kept by a browser or proxy cache (C4 SF-6)
    expect(body.format).toBe('makrai.personal-export/1');
    expect(body.items).toHaveLength(4);
    for (const i of body.items) {
      expect(i.id).toBeTruthy();
      expect(i.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect([i.orgId, i.organisation]).toEqual([fx.org.id, fx.org.name]);
      expect(Object.keys(i).sort()).toEqual(['date', 'id', 'orgId', 'organisation', 'roles', 'type']);
    }
    expect(body.items.filter((i) => i.type === 'decision_version').map((i) => i.roles)).toEqual([['entered'], ['entered'], ['entered']]);
    expect(body.items.find((i) => i.type === 'mitigation_version')!.roles).toEqual(['owns']);
    expect(JSON.stringify(body)).not.toMatch(MARKER_PATTERN);
  });

  it('FR-EXP-02: a person named in more than one column of one row is listed once with each role', async () => {
    const fx = await buildOrg({ label: 'peroles' });
    const projectId = (await addProject(fx)).id;
    const assessor = fx.members.assessor.userId;
    await addDecision(fx, projectId, { ...q(), status: 'done', by: 'assessor', decidedBy: { kind: 'member', userId: assessor } });
    const { body } = await exportOf(assessor);
    expect(body.items.map((i) => [i.type, i.roles])).toEqual([['decision_version', ['entered', 'decided']]]);
  });

  it('NFR-PRIV-08: the export holds every allow-listed personal field and withholds the two hashes', async () => {
    const list = JSON.parse(readFileSync('__tests__/lint/personal-data-allowlist.json', 'utf8')) as Array<{ table: string; column: string; maps: string }>;
    // Left out on purpose: FR-RES-01 voided the research tick box, so no code may read these two columns
    // (__tests__/lint/no-research-consent.test.ts), and the person's voided research consent row is exported under
    // `acceptances` instead (asserted below), so the export still states what the platform holds.
    const VOIDED = ['users.researchConsent', 'users.researchConsentVoidedAt'];
    const want = (t: string) => list.filter((e) => e.table === t && e.maps !== 'no personal data' && !VOIDED.includes(`${t}.${e.column}`)).map((e) => e.column).sort();
    const fx = await buildOrg({ label: 'peall' });
    const userId = fx.members.assessor.userId;
    await testDb.knownDevice.create({ data: { userId, failedCount: 1 } });
    await testDb.passwordResetToken.create({ data: { userId, tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000) } });
    const voidedAt = new Date('2026-10-08T12:00:00.000Z');
    await testDb.consentRecord.create({ data: { userId, consentType: 'research_data_usage', granted: true, voidedAt, voidReason: 'Withdrawn: no approved protocol.' } });

    const { body } = await exportOf(userId);
    expect(want('users').length).toBeGreaterThan(0); // not vacuous
    expect(Object.keys(body.account).sort()).toEqual(expect.arrayContaining(want('users')));
    for (const a of body.acceptances) expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(want('consent_records')));
    for (const d of body.signIn.knownDevices) expect(Object.keys(d).sort()).toEqual(expect.arrayContaining(want('known_devices')));
    for (const p of body.signIn.passwordResets) expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(want('password_reset_tokens')));
    expect(body.signIn.knownDevices).toHaveLength(1);
    expect(body.signIn.passwordResets).toHaveLength(1);
    expect(body.account.passwordHash).toBe('withheld');
    for (const p of body.signIn.passwordResets) expect(p.tokenHash).toBe('withheld');
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64));
    expect(body.account).not.toHaveProperty('researchConsent');
    expect(body.acceptances).toContainEqual(expect.objectContaining({
      consentType: 'research_data_usage', granted: true, voidedAt: voidedAt.toISOString(), voidReason: 'Withdrawn: no approved protocol.',
    }));
  });

  it('NFR-PRIV-08: every allow-list table with a row naming a person is read by personalExport', () => {
    const list = JSON.parse(readFileSync('__tests__/lint/personal-data-allowlist.json', 'utf8')) as Array<{ table: string; column: string; maps: string }>;
    // A column that names a person: an account id (…ById, …UserId, byId, userId, actorId, targetUserId) or an address.
    const namesPerson = (column: string) => /(ById|UserId)$|^(byId|userId|actorId|email)$/.test(column);
    const tables = [...new Set(list.filter((e) => e.maps !== 'no personal data' && namesPerson(e.column)).map((e) => e.table))].sort();
    // The account's own tables are exported by their columns (the case above); every other one as items.
    const ACCOUNT_TABLES = ['consent_records', 'known_devices', 'password_reset_tokens', 'users'];
    // Tables personalExport cannot read yet, each with its reason and register row. Empty is the target (NFR-PRIV-08).
    const DEFERRED: Record<string, string> = {
      platform_events: 'no application role holds SELECT on platform_events (only its definer function writes it); reported to the controller for a read path',
    };
    expect(tables.length).toBeGreaterThan(10); // not vacuous
    const missing = tables.filter((t) => !ACCOUNT_TABLES.includes(t) && !PERSONAL_ITEM_TABLES.includes(t) && !(t in DEFERRED));
    expect(missing, 'allow-list tables naming a person that personalExport does not read').toEqual([]);
    expect(Object.keys(DEFERRED).filter((t) => PERSONAL_ITEM_TABLES.includes(t)), 'a DEFERRED table that is now read').toEqual([]);
  });

  it('NFR-PRIV-08 FR-EXP-02: projects, draft fields, organisation events, request receipts, invitations and agreements naming the person are items, with no other person\'s id or address', async () => {
    const fx = await buildOrg({ label: 'peother' });
    const me = fx.members.admin;
    const other = fx.members.viewer;
    const p = (await addProject(fx, { by: 'admin' })).id;
    await testDb.documentDraftFields.create({ data: { orgId: fx.org.id, projectId: p, documentType: 'data_card', fieldValues: { purpose: 'Draft text of the team' }, updatedById: me.userId } });
    const acted = await testDb.organisationEvent.create({ data: { orgId: fx.org.id, actorId: me.userId, actorRole: 'admin', action: 'member_role_changed', targetUserId: other.userId, previousValue: 'reviewer', reason: 'Reason text of the team' } });
    const named = await testDb.organisationEvent.create({ data: { orgId: fx.org.id, actorId: fx.members.owner.userId, actorRole: 'owner', action: 'member_role_changed', targetUserId: me.userId, previousValue: 'assessor' } });
    const receipt = await testDb.requestReceipt.create({ data: { orgId: fx.org.id, requestId: randomUUID(), requestDigest: 'd'.repeat(64), actorUserId: me.userId, route: 'POST:/api/v1/orgs/*/projects', rowId: p, result: { ownerUserId: other.userId } } });
    const sent = await testDb.invitation.create({ data: { orgId: fx.org.id, email: 'someone-else@fixture.test', role: 'viewer', tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), invitedById: me.userId, expiresAt: new Date(Date.now() + 86_400_000) } });
    const received = await testDb.invitation.create({ data: { orgId: fx.org.id, email: me.email, role: 'admin', tokenHash: createHash('sha256').update(randomUUID()).digest('hex'), invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 86_400_000), status: 'accepted', acceptedAt: new Date('2026-10-31T10:00:00Z') } });
    const agreement = await testDb.organisationAgreement.create({ data: {
      orgId: fx.org.id, agreementVersion: '2', textHash: 'e'.repeat(64), acceptedOn: new Date('2026-11-01T00:00:00Z'),
      controllerLegalName: 'Controller Legal Name Ltd', dpContactEmail: 'dpo-other@fixture.test', recordedById: me.userId,
    } });

    const { body } = await exportOf(me.userId);
    const byType = (type: string) => body.items.filter((i) => i.type === type);
    expect(byType('project').map((i) => [i.id, i.roles])).toEqual([[p, ['entered']]]);
    expect(byType('document_draft_field').map((i) => [i.kind, i.roles])).toEqual([['data_card', ['entered']]]);
    expect(byType('organisation_event').map((i) => [i.id, i.kind, i.roles]).sort()).toEqual([
      [acted.id, 'member_role_changed', ['acted']], [named.id, 'member_role_changed', ['named']]].sort());
    expect(byType('request_receipt').map((i) => [i.id, i.kind, i.roles])).toEqual([[receipt.id, 'POST:/api/v1/orgs/*/projects', ['entered']]]);
    expect(byType('invitation').map((i) => [i.id, i.roles, i.own ?? null]).sort()).toEqual([
      [received.id, ['invited'], { email: me.email, acceptedAt: '2026-10-31T10:00:00.000Z' }], [sent.id, ['entered'], null]].sort());
    expect(byType('organisation_agreement').map((i) => [i.id, i.kind, i.roles])).toEqual([[agreement.id, '2', ['entered']]]);
    for (const i of body.items) expect([i.orgId, i.organisation]).toEqual([fx.org.id, fx.org.name]);
    const text = JSON.stringify(body);
    for (const theirs of [other.userId, fx.members.owner.userId, 'someone-else@fixture.test', 'dpo-other@fixture.test', 'Controller Legal Name Ltd', 'Draft text of the team', 'Reason text of the team']) {
      expect(text, `the export holds ${theirs}`).not.toContain(theirs);
    }
  });

  it('FR-EXP-02 NFR-PRIV-08: items of an organisation the person left are absent', async () => {
    const fx = await buildOrg({ label: 'pestay' });
    const left = await buildOrg({ label: 'peleft' });
    const assessor = fx.members.assessor.userId;
    await testDb.membership.create({ data: { orgId: left.org.id, userId: assessor, role: 'assessor' } });
    const p = (await addProject(left)).id;
    await testDb.decisionVersion.create({ data: {
      orgId: left.org.id, projectId: p, stage: 'pre-processing', questionId: q().questionId, contentVersionId, versionNumber: 1, status: 'done',
      reason: 'Left behind', enteredById: assessor, enteredByRole: 'assessor', requestId: crypto.randomUUID(), requestDigest: 'd'.repeat(64),
    } });
    expect((await exportOf(assessor)).body.items.map((i) => i.orgId)).toEqual([left.org.id]);
    await testDb.membership.deleteMany({ where: { orgId: left.org.id, userId: assessor } });
    const { body } = await exportOf(assessor);
    expect(body.items).toEqual([]);
    expect(body.memberships.map((m) => m.orgId)).toEqual([fx.org.id]);
    expect(body.memberships[0]).toEqual({ orgId: fx.org.id, organisation: fx.org.name, role: 'assessor', joinedAt: expect.stringMatching(/Z$/) });
  });

  it('FR-EXP-02: every legal acceptance is listed with kind, version, hash and time', async () => {
    const fx = await buildOrg({ label: 'peacc' });
    const userId = fx.members.viewer.userId;
    const rows = await testDb.consentRecord.findMany({ where: { userId } });
    expect(rows.length).toBe(3);
    const { body } = await exportOf(userId);
    expect(body.acceptances.map((a) => [a.consentType, a.version, a.textHash, a.grantedAt]).sort()).toEqual(
      rows.map((r) => [r.consentType, r.version, r.textHash, r.grantedAt.toISOString()]).sort());
  });

  it('FR-EXP-02 FR-ACC-04: a person missing an acceptance can still export their data', async () => {
    const fx = await buildOrg({ label: 'pepre', acceptances: 'pre-v1' });
    const { status, body } = await exportOf(fx.members.assessor.userId);
    expect(status).toBe(200);
    expect(body.account.id).toBe(fx.members.assessor.userId);
  });

  it('FR-EXP-02: a caller with no session gets 401', async () => {
    clearSession();
    expect((await GET()).status).toBe(401);
  });
});
