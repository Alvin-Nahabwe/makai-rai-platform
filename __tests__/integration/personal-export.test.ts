import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { clearSession, sessionFor } from '../helpers/authSession';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import { MARKER_PATTERN, markerText } from '../helpers/markers';
import { addDecision, addFinding, addMitigationVersion, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { GET } from '../../app/api/users/me/export/route';
import type { PersonalExport } from '../../types/api';

/**
 * Route 38 and personalExport (00-contract.md, Routes row 38, Services lib/data/export.ts; FR-EXP-02,
 * NFR-PRIV-08, SRS 6.4): a person's own data as one JSON file, with the records they entered or were
 * named in listed by organisation, type, id and date, and none of the organisation's record text.
 */

let contentVersionId: string;
const q = () => ({ stage: 'pre-processing' as const, questionId: FIXTURE_QUESTION_IDS[0], contentVersionId });

async function exportOf(userId: string): Promise<{ status: number; body: PersonalExport; disposition: string | null }> {
  sessionFor(userId);
  const res = await GET();
  return { status: res.status, body: (await res.json()) as PersonalExport, disposition: res.headers.get('content-disposition') };
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
    const { status, body, disposition } = await exportOf(fx.members.assessor.userId);
    expect(status).toBe(200);
    expect(disposition).toMatch(/^attachment; filename="makrai-export-\d{4}-\d{2}-\d{2}\.json"$/);
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
