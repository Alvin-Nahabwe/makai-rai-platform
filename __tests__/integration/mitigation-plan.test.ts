import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuedDocumentView } from '@/types/api';
import { issueDocument, previewDocument, readDocumentPdf, documentViews } from '@/lib/data/documents';
import { requestDigest } from '@/lib/data/idempotency';
import { withOrg } from '@/lib/data/tenant';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { RENDERERS } from '@/lib/documents/render';
import { SEALED_NOTE, STATEMENT, textErasedLine } from '@/lib/documents/copy';
import { claimMatches } from '@/lib/claims/pattern';
import { resetDb, testDb } from '../helpers/db';
// Aliased: the name starts with "use", and react-hooks/rules-of-hooks reads any such call as a React hook.
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import {
  addAcceptedRisk, addDecision, addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import { pdfPageRuns, pdfTextRuns } from '../helpers/pdfText';
import { HOSTILE_STRINGS, hostileText } from '../helpers/hostile';
import { claimsOutsideNames, readFrameworkNames } from '../helpers/frameworkNames';

// Each issue renders a PDF with an embedded font (about a second on a loaded host).
vi.setConfig({ testTimeout: 60_000 });

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;
let reviewId: string;
let sealId: string;
let findingId: string;
let mitigationId: string;
const titles: string[] = [];

const ctx = () => ctxFor(fx, 'admin');
const admin = () => ({ userId: fx.members.admin.userId, role: 'admin' as const });
const squash = (s: string) => s.replace(/\s+/g, ' ');

async function issueMp(typedFields: Record<string, string> = { 'MP-09': 'Reviewed with the PI.' }): Promise<IssuedDocumentView> {
  const requestId = randomUUID();
  const digest = requestDigest({ path: { id: projectId, reviewId }, body: { requestId, documentType: 'mitigation_plan', sealId, typedFields } });
  return (await issueDocument(ctx(), admin(), { projectId, reviewId, sealId, documentType: 'mitigation_plan', typedFields, requestId }, digest)).value;
}
const runsOf = async (id: string) => pdfTextRuns((await readDocumentPdf(ctx(), id)).bytes).join(' ');

async function build(text?: (field: string, n: number) => string) {
  await resetDb();
  ({ contentVersionId } = await publishFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({
    label: 'mp', text: text ?? ((field, n) => (field === 'title' && titles.length > 0 ? (titles.shift() as string) : `Fixture ${field} ${n}`)),
  });
  projectId = (await addProject(fx)).id;
  await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-12', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30' });
  reviewId = (await addStageReview(fx, projectId, { stage: 'pre-processing', preparedFor: 'ethics submission' })).id;
}

beforeEach(async () => {
  titles.length = 0;
  await build();
  findingId = (await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' })).id;
  const m = await addMitigationVersion(fx, findingId, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
  mitigationId = m.mitigationId;
  const accepted = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-03' });
  await addAcceptedRisk(fx, accepted.id, { lookAgainOn: '2027-01-15' });
  sealId = (await sealFixture(fx, reviewId, { projectId })).id;
});

describe('the mitigation plan renderer', () => {
  it('FR-DOC-01: RENDERERS registers a mitigation plan renderer', () => {
    expect(RENDERERS.mitigation_plan).toBeTypeOf('function');
  });

  it('FR-DOC-01: issuing a mitigation plan from a sealed review produces a stored PDF', async () => {
    const value = await issueMp();
    const { bytes } = await readDocumentPdf(ctx(), value.id);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(value.documentType).toBe('mitigation_plan');
  });

  it('FR-DOC-08: the preview of a mitigation plan answers its text and stores nothing', async () => {
    const p = await previewDocument(ctx(), admin(), { projectId, reviewId, sealId, documentType: 'mitigation_plan', typedFields: {} });
    expect(p.text).toContain('Mitigation plan');
    expect(p.typedFields).toEqual(['MP-09']);
    expect(p.notRecordedFields).toContain('MP-09');
    expect(await testDb.issuedDocument.count()).toBe(0);
  });

  it('NFR-A11Y-06: the mitigation plan has its title, language en, and text in field-map order', async () => {
    const value = await issueMp();
    const { bytes } = await readDocumentPdf(ctx(), value.id);
    expect(bytes.toString('latin1')).toContain('/Lang (en)');
    expect(squash(pdfTextRuns(bytes).join(' '))).toContain('Mitigation plan');
    const joined = squash(pdfTextRuns(bytes).join(' '));
    const at = loadFieldMap('mitigation_plan').fields.map((f) => joined.indexOf(squash(f.label)));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('FR-DOC-02 (D8): every page of the mitigation plan carries its type, the issue time, the statement and the sealed note', async () => {
    // Enough findings to run onto a second page.
    for (let i = 0; i < 12; i += 1) {
      const f = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
      await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    }
    sealId = (await sealFixture(fx, reviewId, { projectId })).id;
    const value = await issueMp();
    const pages = pdfPageRuns((await readDocumentPdf(ctx(), value.id)).bytes);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      const t = squash(p.join(' '));
      expect(t).toContain('Mitigation plan');
      expect(t).toContain(`${new Date(value.issuedAt).toISOString().slice(11, 19)} UTC`);
      expect(t).toContain(STATEMENT);
      expect(t).toContain(SEALED_NOTE);
    }
  });

  it('NFR-INT-10 FR-DOC-05: a mitigation updated after the seal is listed in its sealed version', async () => {
    await addMitigationVersion(fx, findingId, { mitigationId, status: 'in_progress', owner: 'assessor', dueDate: '2026-12-01' });   // after the seal
    const text = squash(await runsOf((await issueMp()).id));
    expect(text).toContain('Status: Planned');
    expect(text).not.toContain('Status: In progress');
  });

  it('FR-DOC-01 (MP-06): a risk accepted is listed with who accepted it and the date to look again', async () => {
    const text = squash(await runsOf((await issueMp()).id));
    expect(text).toContain(`Accepted by: ${fx.members.owner.name}`);
    expect(text).toContain('Look again on: 15 Jan 2027');
  });

  it('FR-DOC-01 (MP-09, MP-10): the typed note is marked as typed, and the seal is listed', async () => {
    const text = squash(await runsOf((await issueMp()).id));
    expect(text).toContain('Reviewed with the PI.');
    expect(text).toContain('Typed for this document; not part of the sealed record');
    expect(text).toContain('Seal 1 of Pre-processing review 1');
  });

  it('FR-DOC-07 FR-REV-08: every printed finding, mitigation and review text is a source row, and erasing one empties the document', async () => {
    const value = await issueMp();
    const sources = await testDb.issuedDocumentSource.findMany({ where: { documentId: value.id } });
    const has = (table: string, field: string | null) => sources.some((s) => s.sourceTable === table && s.field === field);
    expect(has('findings', 'title')).toBe(true);
    expect(has('findings', 'description')).toBe(true);
    expect(has('mitigation_versions', 'what')).toBe(true);
    expect(has('accepted_risks', 'reason')).toBe(true);
    expect(has('stage_reviews', 'preparedFor')).toBe(true);
    // An operator erasure of the printed mitigation text nulls the document, and its view reads erased.
    const mv = sources.find((s) => s.sourceTable === 'mitigation_versions' && s.field === 'what') as { sourceId: string };
    await eraseText('mitigation_versions', mv.sourceId, 'what');
    const view = (await withOrg(ctx(), (tx) => documentViews(tx, [value.id]))).get(value.id) as IssuedDocumentView;
    expect(view.erased).not.toBeNull();
    await expect(readDocumentPdf(ctx(), value.id)).rejects.toMatchObject({ status: 410 });
  });

  it('FR-REV-08 (SRS 7.5.6): a mitigation text erased before issue prints the erasure line', async () => {
    const mv = await testDb.mitigationVersion.findFirstOrThrow({ where: { findingId } });
    await eraseText('mitigation_versions', mv.id, 'what');
    const sealAfter = (await sealFixture(fx, reviewId, { projectId })).id;
    sealId = sealAfter;
    const text = squash(await runsOf((await issueMp()).id));
    expect(text).toContain(squash(textErasedLine(new Date().toISOString().slice(0, 10))));
  });

  it('FR-PUB-01 FR-DOC-02 (SRS 7.5.3): the printed copy holds no claim word outside the framework names, and no form of "fail"', async () => {
    const value = await issueMp();
    const text = squash(await runsOf(value.id)).replaceAll(STATEMENT, '');
    const plain = ((await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id }, select: { plainText: true } })).plainText as string).replaceAll(STATEMENT, '');
    const names = readFrameworkNames();
    // "in progress" is the status word of one mitigation (SRS 5.3 item 11, 7.5.6), as claim-allowlist.json allows it on the screens.
    const claims = (t: string) => claimsOutsideNames(t, names).filter((m) => !(m.text.toLowerCase() === 'progress' && /\bin $/i.test(t.slice(Math.max(0, m.index - 3), m.index))));
    for (const t of [text, plain]) {
      expect(claims(t)).toEqual([]);
      expect(t).not.toMatch(/fail/i);
    }
    expect(claimMatches('compliant')).not.toEqual([]);   // the pattern is live
  });
});

describe('team text in the mitigation plan', () => {
  it('NFR-SEC-11: hostile finding titles print literally in the PDF and the plain text', async () => {
    await build(hostileText);
    const f = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    sealId = (await sealFixture(fx, reviewId, { projectId })).id;
    const value = await issueMp();
    const runs = pdfTextRuns((await readDocumentPdf(ctx(), value.id)).bytes).join('').replace(/\s+/g, '');
    const plain = (await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id }, select: { plainText: true } })).plainText as string;
    for (const h of HOSTILE_STRINGS) {
      expect(runs).toContain(h.replace(/\s+/g, ''));
      expect(plain).toContain(h);
    }
  });

  it('NFR-A11Y-06 (A11 (b)): a finding title with a letter the font has prints in the embedded Geist font, and one it lacks prints ? with the A11 note', async () => {
    titles.push('Nankya ŋ labels', 'Okɔ labels');
    await build((field, n) => (field === 'title' && titles.length > 0 ? (titles.shift() as string) : `Fixture ${field} ${n}`));
    await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
    await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
    sealId = (await sealFixture(fx, reviewId, { projectId })).id;
    const value = await issueMp();
    const runs = squash(await runsOf(value.id));
    expect(runs).toContain('Nankya ŋ labels');
    expect(runs).toContain('Ok? labels');
    expect(runs).toContain('Some characters could not be printed in this PDF. The plain-text copy has the exact text.');
    const plain = (await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id }, select: { plainText: true } })).plainText as string;
    expect(plain).toContain('Okɔ labels');
  });
});

/** The erasure as an operator makes it: the definer function nulls the text, writes the tombstone and nulls the documents that printed it. */
const eraseText = (table: string, id: string, field: string) => testDb.$transaction(async (tx) => {
  await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
  await tx.$executeRawUnsafe(`SELECT erase_text_field('${fx.org.id}','${table}','${id}','${field}','ER-MP','INSTR-MP')`);
});
