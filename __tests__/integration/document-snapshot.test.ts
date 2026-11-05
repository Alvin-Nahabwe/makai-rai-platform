import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentType, Stage } from '@/types/record';
import { withOrg } from '@/lib/data/tenant';
import { readDocumentSnapshot } from '@/lib/data/documents';
import { manifestIds } from '@/lib/seal/ids';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addAcceptedRisk, addDecision, addEvidence, addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;
let ppReview: string;
let ipReview: string;
let poReview: string;
let ppVersionIds: string[];
let ipVersionIds: string[];
let poVersionIds: string[];
let ppSeal: string;
let ipSeal1: string;
let ipSeal2: string;

const ctx = () => ctxFor(fx, 'admin');
const readAt = (a: { reviewId: string; sealId: string; documentType: DocumentType }) =>
  withOrg(ctx(), (tx) => readDocumentSnapshot(tx, { projectId, ...a }), { isolationLevel: 'RepeatableRead' });

async function decide(stage: Stage, questionId: string, extra: { evidenceIds?: string[] } = {}): Promise<string> {
  return (await addDecision(fx, projectId, { stage, questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30', ...extra })).id;
}

beforeAll(async () => {
  ({ contentVersionId } = await useFixtureContent('0.0.1-fixture'));
});

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await useFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'dsnap' });
  projectId = (await addProject(fx)).id;
  ppVersionIds = [await decide('pre-processing', 'Q-PP-12'), await decide('pre-processing', 'Q-PP-13')];
  ipVersionIds = [await decide('in-processing', 'Q-IP-01')];
  poVersionIds = [await decide('post-processing', 'Q-PO-01')];
  ppReview = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
  ipReview = (await addStageReview(fx, projectId, { stage: 'in-processing' })).id;
  poReview = (await addStageReview(fx, projectId, { stage: 'post-processing' })).id;
  ppSeal = (await sealFixture(fx, ppReview, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: ppVersionIds })).id;
  ipSeal1 = (await sealFixture(fx, ipReview, { projectId, stage: 'in-processing', contentVersionId, decisionVersionIds: ipVersionIds })).id;
  ipSeal2 = (await sealFixture(fx, ipReview, { projectId, stage: 'in-processing', contentVersionId, decisionVersionIds: ipVersionIds })).id;
});

describe('the document snapshot', () => {
  it('FR-DOC-05: the review stage comes from the chosen seal, other stages from their latest seal, a never-sealed stage is null', async () => {
    const snap = await readAt({ reviewId: ipReview, sealId: ipSeal1, documentType: 'model_card' });
    expect(snap.reviewStage).toBe('in-processing');
    expect(snap.stages['in-processing']?.seal.sealId).toBe(ipSeal1);
    expect(snap.stages['pre-processing']?.seal.sealId).toBe(ppSeal);
    expect(snap.stages['post-processing']).toBeNull();
    expect(snap.chosen.seal.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(snap.chosen.seal.sealNumber).toBe(1);
    expect(snap.chosen.seal.reviewName).toBe('In-processing review 1');
    expect(snap.chosen.seal.enteredByPeople).toBe(1);
    expect(snap.organisationName).toBe(fx.org.name);
    expect(ipSeal2).not.toBe(ipSeal1);
  });

  it('FR-DOC-05: the latest seal of another stage is the one with the highest sealed time, not the first', async () => {
    const later = await sealFixture(fx, ppReview, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: ppVersionIds });
    const snap = await readAt({ reviewId: ipReview, sealId: ipSeal1, documentType: 'model_card' });
    expect(snap.stages['pre-processing']?.seal.sealId).toBe(later.id);
    expect(snap.stages['pre-processing']?.seal.sealNumber).toBe(2);
  });

  it('FR-DOC-05: decisions come from the sealed versions, not from versions saved after the seal', async () => {
    await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'partly' });   // v2, after the seal
    const snap = await readAt({ reviewId: ppReview, sealId: ppSeal, documentType: 'data_card' });
    expect(snap.chosen.decisions.get('Q-PP-12')?.row.versionNumber).toBe(1);
    expect(snap.chosen.decisions.get('Q-PP-12')?.row.status).toBe('done');
    expect(snap.chosen.decisions.get('Q-PP-12')?.content.semver).toBe('0.0.1-fixture');
    expect(snap.contents.get(contentVersionId)?.semver).toBe('0.0.1-fixture');
  });

  it('FR-DOC-02 FR-REV-08: a sealed decision carries its people, its evidence and the erased mark of its reason', async () => {
    const ev = await addEvidence(fx, projectId, { kind: 'file', fileName: 'protocol.pdf' });
    const withEvidence = await decide('pre-processing', 'Q-PP-08', { evidenceIds: [ev.id] });
    const review2 = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fx, review2, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: [...ppVersionIds, withEvidence] });
    const snap = await readAt({ reviewId: review2, sealId: seal.id, documentType: 'data_card' });
    const d = snap.chosen.decisions.get('Q-PP-08')!;
    expect(d.enteredBy.name).toBe(fx.members.assessor.name);
    expect(d.decidedBy).toMatchObject({ kind: 'member', user: { userId: fx.members.owner.userId } });
    expect(d.evidence.map((e) => e.fileName)).toEqual(['protocol.pdf']);
    expect(d.reasonErased).toBeNull();
    await testDb.$executeRaw`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", field, digest, "erasureCode", "instructionReference") VALUES (gen_random_uuid()::text, ${fx.org.id}, 'decision_versions', ${withEvidence}, 'reason', ${'a'.repeat(64)}, 'ER', 'I')`;
    const after = await readAt({ reviewId: review2, sealId: seal.id, documentType: 'data_card' });
    expect(after.chosen.decisions.get('Q-PP-08')!.reasonErased).toEqual({ erasedOn: new Date().toISOString().slice(0, 10) });
  });

  it('FR-DOC-01 NFR-SEC-02: a seal of another review is refused with 422 on sealId', async () => {
    await expect(readAt({ reviewId: ppReview, sealId: ipSeal1, documentType: 'data_card' })).rejects.toMatchObject({ status: 422, code: 'validation' });
  });

  it('NFR-SEC-02: a seal that exists nowhere in this organisation is not found', async () => {
    await expect(readAt({ reviewId: ppReview, sealId: '00000000-0000-4000-8000-000000000000', documentType: 'data_card' })).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('NFR-INT-05: a seal whose stored bytes are no readable manifest of it is refused, never turned into a document', async () => {
    const bad = await testDb.seal.findUniqueOrThrow({ where: { id: ppSeal } });
    const other = await testDb.stageReview.create({ data: { orgId: fx.org.id, projectId, stage: 'pre-processing', numberInStage: 9, openedById: fx.members.owner.userId, requestId: '11111111-1111-4111-8111-111111111111', requestDigest: 'x' } });
    const junk = Buffer.from('{}');
    const row = await testDb.seal.create({ data: {
      orgId: fx.org.id, stageReviewId: other.id, sealNumber: 1, format: 'makrai.seal/1', contentVersionId, manifest: Uint8Array.from(junk),
      fingerprint: createHash('sha256').update(junk).digest('hex'), sealedById: fx.members.owner.userId, sealedByRole: 'owner',
      requestId: '22222222-2222-4222-8222-222222222222', requestDigest: bad.requestDigest,
    } });
    await expect(readAt({ reviewId: other.id, sealId: row.id, documentType: 'data_card' })).rejects.toMatchObject({ status: 422, code: 'validation' });
  });

  it('NFR-INT-10: the snapshot runs in one repeatable-read transaction and does not see a seal committed between its reads', async () => {
    let isolation = '';
    const snap = await withOrg(ctx(), (tx) => readDocumentSnapshot(tx, { projectId, reviewId: ipReview, sealId: ipSeal1, documentType: 'model_card' }, {
      afterSeals: async (t) => {
        isolation = (await t.$queryRaw<{ i: string }[]>`SELECT current_setting('transaction_isolation') AS i`)[0].i;
        await sealFixture(fx, poReview, { projectId, stage: 'post-processing', contentVersionId, decisionVersionIds: poVersionIds });   // other connection, commits
      },
    }), { isolationLevel: 'RepeatableRead' });
    expect(isolation).toBe('repeatable read');
    expect(snap.stages['post-processing']).toBeNull();
    // a later snapshot sees it
    expect((await readAt({ reviewId: ipReview, sealId: ipSeal1, documentType: 'model_card' })).stages['post-processing']).not.toBeNull();
  });

  it('FR-DOC-02 (round 10): the snapshot holds every project metadata value as a string, with the companion texts, so the resolver can show display words', async () => {
    const data = { processesPersonalData: true, datasetSize: 'medium_1k_100k' as const, aiSystemType: 'other', aiSystemTypeOther: 'Triage chatbot', projectStart: new Date('2026-09-01T00:00:00Z'), teamSize: 4, fundingSource: null };
    await testDb.projectMetadata.upsert({ where: { orgId_projectId: { orgId: fx.org.id, projectId } }, create: { orgId: fx.org.id, projectId, ...data }, update: data });
    const snap = await readAt({ reviewId: ppReview, sealId: ppSeal, documentType: 'data_card' });
    expect(snap.project.metadata).toMatchObject({ processesPersonalData: 'true', datasetSize: 'medium_1k_100k', aiSystemType: 'other', aiSystemTypeOther: 'Triage chatbot', projectStart: '2026-09-01', teamSize: '4', fundingSource: null });
    expect(snap.project.name).toBe((await testDb.project.findUniqueOrThrow({ where: { id: projectId } })).name);
  });

  it('FR-DOC-02: a project with no metadata row has every metadata value null', async () => {
    const snap = await readAt({ reviewId: ppReview, sealId: ppSeal, documentType: 'data_card' });
    expect(snap.project.metadata.fundingSource ?? null).toBeNull();
    expect(snap.project.metadata.processesPersonalData ?? null).toBeNull();
  });

  it('FR-DOC-05: findings, their current mitigation versions and the accepted risk come from the manifest of the chosen seal', async () => {
    const finding = await addFinding(fx, projectId, { stage: 'in-processing', source: 'team', riskArea: 'IP-01' });
    const m = await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const done = await addMitigationVersion(fx, finding.id, { mitigationId: m.mitigationId, status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
    const seal = await sealFixture(fx, ipReview, { projectId, stage: 'in-processing', contentVersionId, decisionVersionIds: ipVersionIds, findingIds: [finding.id] });
    await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-02' });   // after the seal
    const snap = await readAt({ reviewId: ipReview, sealId: seal.id, documentType: 'model_card' });
    const sf = snap.chosen.findings.find((f) => f.finding.id === finding.id)!;
    expect(sf.finding.state).toBe('closed_mitigation');
    expect(sf.mitigations.map((x) => x.id)).toEqual([done.id]);
    expect(sf.mitigations[0].owner.name).toBe(fx.members.assessor.name);
    expect(sf.acceptedRisk).toBeNull();
    const risky = await addFinding(fx, projectId, { stage: 'in-processing', source: 'team' });
    await addAcceptedRisk(fx, risky.id, { acceptedBy: { kind: 'outside_role', role: 'supervisor' }, lookAgainOn: '2027-01-15' });
    const seal2 = await sealFixture(fx, ipReview, { projectId, stage: 'in-processing', contentVersionId, decisionVersionIds: ipVersionIds, findingIds: [risky.id] });
    const risk = (await readAt({ reviewId: ipReview, sealId: seal2.id, documentType: 'model_card' })).chosen.findings.find((f) => f.finding.id === risky.id)!.acceptedRisk!;
    expect(risk.acceptedBy).toEqual({ kind: 'outside_role', role: 'supervisor' });
    expect(risk.lookAgainOn).toBe('2027-01-15');
  });

  it('FR-CNT-04 (H2): a question the seal derives from the gate is carried as derived, with the gate version it comes from', async () => {
    const gate = await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId, status: null, scopeAnswer: 'no', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30' });
    const review = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fx, review, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: [gate.id], derived: [{ question: 'Q-PP-13', from: gate.id }] });
    const snap = await readAt({ reviewId: review, sealId: seal.id, documentType: 'data_card' });
    expect(snap.chosen.derived.get('Q-PP-13')).toBe(gate.id);
    expect(snap.chosen.decisions.has('Q-PP-13')).toBe(false);
    expect(snap.chosen.decisions.get('Q-PP-GATE-SENSITIVE')?.row.id).toBe(gate.id);
  });

  it('FR-REV-08 (H1, H6): the snapshot carries the tombstones of the evidence, findings and risks it holds', async () => {
    const ev = await addEvidence(fx, projectId, { kind: 'link', url: 'https://example.org/z', label: 'Z' });
    const d = await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-08', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30', evidenceIds: [ev.id] });
    const review = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
    const seal = await sealFixture(fx, review, { projectId, stage: 'pre-processing', contentVersionId, decisionVersionIds: [d.id] });
    await testDb.$executeRaw`INSERT INTO tombstones (id, "orgId", "targetTable", "targetId", field, digest, "erasureCode", "instructionReference") VALUES (gen_random_uuid()::text, ${fx.org.id}, 'evidence', ${ev.id}, 'url', ${'b'.repeat(64)}, 'ER', 'I')`;
    const snap = await readAt({ reviewId: review, sealId: seal.id, documentType: 'data_card' });
    expect(snap.erasures.evidence.get(ev.id)).toEqual({ fields: ['url'], erasedOn: new Date().toISOString().slice(0, 10) });
    expect(snap.erasures.findings.size).toBe(0);
  });

  it('FR-DOC-05 (helper): the sealFixture manifest names exactly the decision versions it was given, through manifestIds', async () => {
    const row = await testDb.seal.findUniqueOrThrow({ where: { id: ppSeal } });
    expect(manifestIds(JSON.parse(Buffer.from(row.manifest).toString('utf8'))).decisionVersions.sort()).toEqual([...ppVersionIds].sort());
    expect(createHash('sha256').update(row.manifest).digest('hex')).toBe(row.fingerprint);
  });
});
