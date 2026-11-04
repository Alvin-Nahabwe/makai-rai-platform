import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addEvidence, addFinding, addFindingEvent, addIssuedDocument, addMitigationVersion, addProject,
  addSealRow, addStageReview, buildOrg, ctxFor, type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';
import { withOrg, type OrgContext } from '../../lib/data/tenant';
import { readExportSnapshot, type TeamExportJson } from '../../lib/data/export';
import { safeEvidenceEntryName } from '../../lib/export/zip';

/**
 * The team export's JSON (format makrai.team-export/1, SRS 6.3) read from one snapshot of the
 * organisation (NFR-INT-10). Records are set up with K0a's fixture builder through `testDb`,
 * another connection that commits at once, which is what lets the race cases write between two
 * of the export's reads.
 */

let fx: OrgFixture;
let ctx: OrgContext;
let projectId: string;
let projectOfB: string;
let reviewId: string;
let sealId: string;
let q: { stage: 'pre-processing'; questionId: string; contentVersionId: string };

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const partly = (i: number): FixtureDecision => ({ ...q, status: 'partly', by: i % 2 === 0 ? 'assessor' : 'admin' });

function snapshotOf(id: string | null, isolationLevel: 'RepeatableRead' | 'ReadCommitted' = 'RepeatableRead'): Promise<TeamExportJson> {
  return withOrg(ctx, (tx) => readExportSnapshot(tx, { projectId: id }), { isolationLevel });
}
const snapshot = () => snapshotOf(null);

async function insertDocumentEvent(documentId: string, reason: string): Promise<void> {
  await testDb.$executeRaw`INSERT INTO document_events (id, "orgId", "documentId", kind, reason, "byId", "requestId", "requestDigest")
    VALUES (${randomUUID()}, ${fx.org.id}, ${documentId}, 'withdrawn', ${reason}, ${fx.members.owner.userId}, ${randomUUID()}::uuid, ${'d'.repeat(64)})`;
}

beforeAll(async () => {
  await resetDb();
  const content = await useFixtureContent('0.0.1-fixture');
  q = { stage: 'pre-processing', questionId: FIXTURE_QUESTION_IDS[0], contentVersionId: content.contentVersionId };
  fx = await buildOrg({ label: 'exp' });
  ctx = ctxFor(fx, 'admin');
  projectId = (await addProject(fx)).id;
  const second = (await addProject(fx, { archived: true })).id;
  projectOfB = (await addProject(await buildOrg({ label: 'expb' }))).id;

  await testDb.projectMetadata.create({ data: { orgId: fx.org.id, projectId, institution: 'Fixture institution', teamSize: 4 } });
  const file = await addEvidence(fx, projectId, { kind: 'file', fileName: '../../x.txt' });
  const link = await addEvidence(fx, projectId, { kind: 'link', url: 'https://example.org/policy', label: 'Policy' });
  const decision = await addDecision(fx, projectId, { ...q, status: 'partly', evidenceIds: [file.id, link.id] });
  await addDecision(fx, second, { ...q, status: 'done' });
  const finding = await addFinding(fx, projectId, { stage: q.stage, source: 'shortfall', questionId: q.questionId, decisionVersionId: decision.id });
  await addFindingEvent(fx, finding.id, { kind: 'reopened' });
  await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01', evidenceIds: [file.id] });
  await addAcceptedRisk(fx, (await addFinding(fx, projectId, { stage: q.stage, source: 'team' })).id, { lookAgainOn: '2027-01-15' });
  reviewId = (await addStageReview(fx, projectId, { stage: q.stage })).id;
  sealId = (await addSealRow(fx, reviewId, { manifest: Buffer.from('{"format":"makrai.seal/1"}'), contentVersionId: content.contentVersionId })).id;
});

describe('readExportSnapshot', () => {
  it('FR-EXP-01: the snapshot validates against the published schema and counts every decision version', async () => {
    const json = await snapshot();
    const validate = new Ajv({ allErrors: true }).compile(JSON.parse(readFileSync('docs/formats/team-export-1.json', 'utf8')));
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
    expect(json.projects.flatMap((p) => p.decisionVersions)).toHaveLength(await testDb.decisionVersion.count());
    expect(json.projects).toHaveLength(2);
    expect(json.organisation).toEqual({ id: fx.org.id, name: fx.org.name });
    expect(json.members.map((m) => m.role).sort()).toEqual(['admin', 'assessor', 'owner', 'reviewer', 'viewer']);
    expect(json.members.find((m) => m.role === 'owner')).toEqual({ userId: fx.members.owner.userId, name: fx.members.owner.name, role: 'owner' });
  });

  it('FR-EXP-01 (SRS 6.3): rows keep their stored values, the file name under fileName, and seal manifests as base64', async () => {
    const p = (await snapshotOf(projectId)).projects[0];
    const file = p.evidence.find((e) => e.kind === 'file')!;
    const link = p.evidence.find((e) => e.kind === 'link')!;
    expect([file.fileName, file.file]).toEqual(['../../x.txt', safeEvidenceEntryName(file.id, '../../x.txt')]);
    expect(file.file).toBe(`evidence/${file.id}-x.txt`);
    expect(link.file).toBeNull();
    expect(file).not.toHaveProperty('filename');
    expect(file.filenameSalt).toMatch(/^[0-9a-f]{32}$/);
    const seal = p.seals.find((s) => s.id === sealId)!;
    expect(sha256(Buffer.from(seal.manifest as string, 'base64'))).toBe(seal.fingerprint);
    expect(p.mitigationVersions[0].dueDate).toBe('2026-12-01');
    expect(p.acceptedRisks[0].lookAgainOn).toBe('2027-01-15');
    expect(p.decisionVersions[0].receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(p.decisionEvidence).toHaveLength(2);
    expect(p.mitigationEvidence).toHaveLength(1);
    expect(p.metadata).toMatchObject({ institution: 'Fixture institution', teamSize: 4 });
  });

  it('FR-DOC-06 FR-EXP-01: the export marks a withdrawn document with its date and reason', async () => {
    const doc = await addIssuedDocument(fx, reviewId, { documentType: 'data_card', sealIds: [sealId] });
    await insertDocumentEvent(doc.id, 'Sent to the wrong committee.');
    const d = (await snapshotOf(projectId)).projects[0].issuedDocuments.find((x) => x.id === doc.id)!;
    expect(d.withdrawn).toEqual({ on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), reason: 'Sent to the wrong committee.' });
    expect(d.file).toBe(`documents/${doc.id}.pdf`);
    expect(d).not.toHaveProperty('pdf');
  });

  it('NFR-INT-10 FR-EXP-01: an export racing a Partly save holds the decision and its finding together or neither', async () => {
    for (let i = 0; i < 50; i++) {
      let saved: string | null = null;
      const json = await withOrg(ctx, (tx) => readExportSnapshot(tx, { projectId }, {
        afterDecisions: async () => {
          saved = (await addDecision(fx, projectId, partly(i))).id;
          await addFinding(fx, projectId, { stage: q.stage, source: 'shortfall', questionId: q.questionId, decisionVersionId: saved, by: 'assessor' });
        },
      }), { isolationLevel: 'RepeatableRead' });
      const hasVersion = json.projects[0].decisionVersions.some((v) => v.id === saved);
      const hasFinding = json.projects[0].findings.some((f) => f.decisionVersionId === saved);
      expect(saved).not.toBeNull();
      expect(hasVersion).toBe(hasFinding);
    }
  });

  it('NFR-INT-10 (not vacuous): the same race under READ COMMITTED splits them', async () => {
    let saved: string | null = null;
    const json = await withOrg(ctx, (tx) => readExportSnapshot(tx, { projectId }, {
      afterDecisions: async () => {
        saved = (await addDecision(fx, projectId, partly(0))).id;
        await addFinding(fx, projectId, { stage: q.stage, source: 'shortfall', questionId: q.questionId, decisionVersionId: saved, by: 'assessor' });
      },
    }), { isolationLevel: 'ReadCommitted' });
    const hasVersion = json.projects[0].decisionVersions.some((v) => v.id === saved);
    const hasFinding = json.projects[0].findings.some((f) => f.decisionVersionId === saved);
    expect([hasVersion, hasFinding]).toEqual([false, true]);
  });

  it('FR-EXP-01 NFR-SEC-02: the snapshot of a project id of organisation B is empty and answers 404', async () => {
    await expect(withOrg(ctx, (tx) => readExportSnapshot(tx, { projectId: projectOfB }))).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
