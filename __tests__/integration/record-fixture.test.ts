import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { authorizeCredentials } from '../../lib/auth/credentials';
import { fixtureLegalTexts } from '../helpers/legalStub';
import { testDb, resetDb } from '../helpers/db';
import { buildTwoOrgFixture } from '../helpers/fixture';
import {
  addAcceptedRisk, addDecision, addEvidence, addFinding, addFindingEvent, addIssuedDocument, addMitigationVersion, addProject,
  addSealRow, addStageReview, buildOrg, buildPlatformAdmin,
} from '../helpers/recordFixture';

/**
 * The record fixture builder (00-contract.md, Test harness API; SRS 13.3 K0 row): accounts that
 * pass the v1 acceptance gate (FR-ACC-04), the five roles, and record rows written through the
 * owner role so the database's own triggers set times and numbers.
 */

const FV = 'fv_k0a_test';
const acceptances = (userId: string) => testDb.consentRecord.findMany({ where: { userId }, select: { version: true, textHash: true, consentType: true } });

beforeAll(async () => {
  await resetDb();
  await testDb.$executeRaw`INSERT INTO framework_versions (id, semver, "contentHash", "publishedAt", status) VALUES (${FV}, '0.0.0-k0a-test', ${'d'.repeat(64)}, now(), 'deprecated') ON CONFLICT (id) DO NOTHING`;
});

describe('record fixture builder', () => {
  it('FR-ACC-04 (fixture): every member of buildOrg holds the three v1 acceptances of fixtureLegalTexts', async () => {
    const fx = await buildOrg();
    for (const m of Object.values(fx.members)) {
      expect(await acceptances(m.userId)).toEqual(expect.arrayContaining(fixtureLegalTexts().map((t) => expect.objectContaining({ version: t.version, textHash: t.sha256 }))));
      expect(await acceptances(m.userId)).toHaveLength(fixtureLegalTexts().length);
    }
    const old = await buildOrg({ acceptances: 'pre-v1' });
    expect(await acceptances(old.members.owner.userId)).toEqual(expect.arrayContaining([expect.objectContaining({ version: '1.0', textHash: null })]));
  });

  it('FR-AUTHZ-01 FR-ORG-05 (fixture): five roles, an agreement, and members that sign in with the fixture password', async () => {
    const fx = await buildOrg({ label: 'a' });
    expect(Object.keys(fx.members).sort()).toEqual(['admin', 'assessor', 'owner', 'reviewer', 'viewer']);
    for (const m of Object.values(fx.members)) {
      expect(await testDb.membership.findFirst({ where: { orgId: fx.org.id, userId: m.userId }, select: { role: true } })).toEqual({ role: m.role });
    }
    expect(await testDb.organisationAgreement.count({ where: { orgId: fx.org.id } })).toBe(1);
    expect(await authorizeCredentials({ email: fx.members.owner.email, password: fx.members.owner.password })).not.toBeNull();
    expect(await testDb.organisationAgreement.count({ where: { orgId: (await buildOrg({ withAgreement: false })).org.id } })).toBe(0);
  });

  it('FR-ORG-03 NFR-SEC-04 (fixture): buildPlatformAdmin is an administrator with no membership', async () => {
    const admin = await buildPlatformAdmin();
    expect((await testDb.user.findUniqueOrThrow({ where: { id: admin.userId } })).role).toBe('admin');
    expect(await testDb.membership.count({ where: { userId: admin.userId } })).toBe(0);
  });

  it('FR-DEC-03 FR-DEC-09 (fixture): decisions number per question and the database sets received time', async () => {
    const fx = await buildOrg(); const p = await addProject(fx);
    const a = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: FV, status: 'done' });
    const b = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: FV, status: 'partly', declaredDate: '2026-10' });
    const c = await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-02', contentVersionId: FV, status: 'done' });
    expect([a.versionNumber, b.versionNumber, c.versionNumber]).toEqual([1, 2, 1]);
    const row = await testDb.decisionVersion.findUniqueOrThrow({ where: { id: b.id } });
    expect(Math.abs(row.receivedAt.getTime() - Date.now())).toBeLessThan(60000);
    expect({ precision: row.declaredPrecision, base: row.baseVersionNumber }).toEqual({ precision: 'month', base: 1 });
  });

  it('FR-FND-07 (fixture): findingSeq runs 1, 2, 3 across events, mitigations and accepted risks of one finding', async () => {
    const fx = await buildOrg(); const p = await addProject(fx);
    const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    const seqs = [(await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-11-10' })).findingSeq,
      (await addFindingEvent(fx, f.id, { kind: 'reopened' })).findingSeq, (await addAcceptedRisk(fx, f.id, {})).findingSeq];
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('FR-REV-03 FR-DOC-04 (fixture): evidence, a stage review, seals and an issued document link up', async () => {
    const fx = await buildOrg(); const p = await addProject(fx);
    const file = await addEvidence(fx, p.id, { kind: 'file' });
    const link = await addEvidence(fx, p.id, { kind: 'link', url: 'https://x.test' });
    expect([file.sha256?.length, link.sha256]).toEqual([64, null]);
    const r = await addStageReview(fx, p.id, { stage: 'in-processing' });
    const s1 = await addSealRow(fx, r.id);
    const s2 = await addSealRow(fx, r.id, { contentVersionId: FV });
    expect([s1.sealNumber, s2.sealNumber]).toEqual([1, 2]);
    const d1 = await addIssuedDocument(fx, r.id, { documentType: 'data_card', sealIds: [s2.id, s1.id] });
    const d2 = await addIssuedDocument(fx, r.id, { documentType: 'data_card', sealIds: [s2.id] });
    expect(await testDb.issuedDocumentSeal.count({ where: { documentId: d1.id } })).toBe(2);
    expect(d1.id).not.toBe(d2.id);
  });

  it('FR-AUTHZ-01 (fixture): buildTwoOrgFixture keeps its type, builds 20 seats, and calls no preauth writer', async () => {
    const two = await buildTwoOrgFixture();
    expect(two.users).toHaveLength(20);
    expect(two.orgs).toHaveLength(2);
    expect(readFileSync('__tests__/helpers/fixture.ts', 'utf8')).not.toMatch(/bootstrapOrgWithOwner|createUserFromInvitation|acceptInvitation|createOrgForUser|createInvitation/);
  });

  it('NFR-PRIV-05: fixture builder and legal stub are imported only by tests', () => {
    const hits = execSync(`grep -rlE "__tests__/helpers/(recordFixture|legalStub|fixture)" app lib components || true`).toString().trim().split('\n').filter(Boolean);
    expect(hits).toEqual([]);
  });
});
