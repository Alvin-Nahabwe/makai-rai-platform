import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentType, Stage, StoredDecisionStatus } from '@/types/record';
import { closeByDecision } from '@/lib/data/findings';
import { issueDocument, previewDocument } from '@/lib/data/documents';
import { checkSeal } from '@/lib/data/seals';
import { requestDigest } from '@/lib/data/idempotency';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { closedByLine, formatUtcDay } from '@/lib/documents/copy';
import { resetDb, testDb } from '../helpers/db';
// Aliased: the name starts with "use", and react-hooks/rules-of-hooks reads any such call as a React hook.
import { useFixtureContent as publishFixtureContent } from '../helpers/content';
import { addDecision, addFinding, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';

/**
 * Register row D-408, through the services the routes call: a finding closed by a decision (the real closeByDecision write,
 * `what: null`, no tombstone) is sealed by the real seal path, and the mitigation plan and the model card of that seal preview
 * and issue, printing the record under its finding as who closed it, on which day, and the owner's sentence (a closing record
 * is not a mitigation: the coordinator's ruling of 14 November 2026, 21:45 EAT). Nothing stored or sealed is written to make
 * the document work: the seal still checks as valid and the row keeps its null text with no tombstone.
 */

// Each issue renders a PDF with an embedded font (about a second on a loaded host).
vi.setConfig({ testTimeout: 60_000 });

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;
const D = 'd'.repeat(64);
const CHANGED = FINDINGS_COPY.mitigation.closedBecauseDecisionChanged;
const WITHDRAWN = FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn;

const ctx = () => ctxFor(fx, 'admin');
const admin = () => ({ userId: fx.members.admin.userId, role: 'admin' as const });

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await publishFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'd408' });
  projectId = (await addProject(fx)).id;
});

const dec = (stage: Stage, questionId: string, status: StoredDecisionStatus) =>
  addDecision(fx, projectId, { stage, questionId, contentVersionId, status, withdrawalCode: status === 'withdrawn' ? 'entered_in_error' : null });

/** A shortfall finding raised by a "not yet" decision, then closed by a decision change ("done") or by withdrawing that decision. */
async function closedByDecision(stage: Stage, questionId: string, how: 'changed' | 'withdrawn', riskArea: string | null = null): Promise<{ findingId: string; mitigationVersionId: string; closedBy: string }> {
  const v1 = await dec(stage, questionId, 'not_yet');
  const findingId = (await addFinding(fx, projectId, { stage, source: 'shortfall', questionId, decisionVersionId: v1.id, riskArea })).id;
  const closing = await dec(stage, questionId, how === 'changed' ? 'done' : 'withdrawn');
  const out = await closeByDecision(ctxFor(fx, 'assessor'), { userId: fx.members.assessor.userId, role: 'assessor' },
    { requestId: randomUUID(), decisionVersionId: closing.id, projectId, findingId }, D);
  expect(out.value).toMatchObject({ kind: how === 'changed' ? 'decision_changed' : 'decision_withdrawn', status: 'done', what: null });
  // The line the documents print under the finding: who entered the closing record and the UTC day it was received.
  return { findingId, mitigationVersionId: out.value.id, closedBy: closedByLine(out.value.enteredBy.name, formatUtcDay(out.value.receivedAt)) };
}

async function sealStage(stage: Stage): Promise<{ reviewId: string; sealId: string }> {
  const reviewId = (await addStageReview(fx, projectId, { stage })).id;
  return { reviewId, sealId: (await sealFixture(fx, reviewId, { projectId })).id };
}

async function previewAndIssue(documentType: DocumentType, reviewId: string, sealId: string): Promise<{ preview: string; issued: string; documentId: string }> {
  const p = await previewDocument(ctx(), admin(), { projectId, reviewId, sealId, documentType, typedFields: {} });
  const requestId = randomUUID();
  const digest = requestDigest({ path: { id: projectId, reviewId }, body: { requestId, documentType, sealId, typedFields: {} } });
  const { value } = await issueDocument(ctx(), admin(), { projectId, reviewId, sealId, documentType, typedFields: {}, requestId }, digest);
  const row = await testDb.issuedDocument.findUniqueOrThrow({ where: { id: value.id }, select: { plainText: true } });
  return { preview: p.text, issued: row.plainText as string, documentId: value.id };
}

/** Nothing was written to make the document work: the row keeps its null text, no tombstone names it, and the seal checks. */
async function nothingStoredChanged(mitigationVersionId: string, sealId: string, before: unknown): Promise<void> {
  expect((await testDb.mitigationVersion.findUniqueOrThrow({ where: { id: mitigationVersionId } })).what).toBeNull();
  expect(await testDb.tombstone.count({ where: { targetTable: 'mitigation_versions', targetId: mitigationVersionId } })).toBe(0);
  expect(await testDb.seal.findUniqueOrThrow({ where: { id: sealId } })).toEqual(before);
  expect(await checkSeal(ctxFor(fx, 'viewer'), sealId)).toMatchObject({ kind: 'valid' });
}

describe('documents of a stage holding a finding closed by a decision (D-408)', () => {
  it('FR-FND-06 FR-DOC-01: the mitigation plan previews and issues, printing "Closed because the decision changed." under the finding; the seal still checks', async () => {
    const { mitigationVersionId, closedBy } = await closedByDecision('pre-processing', 'Q-PP-01', 'changed');
    const { reviewId, sealId } = await sealStage('pre-processing');
    const before = await testDb.seal.findUniqueOrThrow({ where: { id: sealId } });
    const { preview, issued } = await previewAndIssue('mitigation_plan', reviewId, sealId);
    for (const t of [preview, issued]) {
      expect(t).toContain(`Status: Closed\n${closedBy}\n${CHANGED}`);
      expect(t).not.toMatch(new RegExp(`^(\\d+\\.|Mitigation \\d+:) ${CHANGED}`, 'm'));
    }
    await nothingStoredChanged(mitigationVersionId, sealId, before);
  });

  it('FR-FND-06 FR-DEC-08 FR-DOC-01: the mitigation plan prints "Closed because the decision was withdrawn." under the finding for a withdrawal; the seal still checks', async () => {
    const { mitigationVersionId, closedBy } = await closedByDecision('pre-processing', 'Q-PP-01', 'withdrawn');
    const { reviewId, sealId } = await sealStage('pre-processing');
    const before = await testDb.seal.findUniqueOrThrow({ where: { id: sealId } });
    const { preview, issued } = await previewAndIssue('mitigation_plan', reviewId, sealId);
    for (const t of [preview, issued]) {
      expect(t).toContain(`Status: Closed\n${closedBy}\n${WITHDRAWN}`);
      expect(t).not.toMatch(new RegExp(`^(\\d+\\.|Mitigation \\d+:) ${WITHDRAWN}`, 'm'));
    }
    await nothingStoredChanged(mitigationVersionId, sealId, before);
  });

  it('FR-FND-06 FR-DOC-01: the model card of an in-processing stage previews and issues, MC-23 printing the line under the finding and MC-24 not listing it; the seal still checks', async () => {
    const { mitigationVersionId, closedBy } = await closedByDecision('in-processing', 'Q-IP-01', 'changed', 'IP-01');
    const { reviewId, sealId } = await sealStage('in-processing');
    const before = await testDb.seal.findUniqueOrThrow({ where: { id: sealId } });
    const { preview, issued } = await previewAndIssue('model_card', reviewId, sealId);
    for (const t of [preview, issued]) {
      expect(t).toContain(`Status: Closed\n${closedBy}\n${CHANGED}`);
      expect(t).not.toMatch(new RegExp(`^(\\d+\\.|Mitigation \\d+:) ${CHANGED}`, 'm'));
    }
    await nothingStoredChanged(mitigationVersionId, sealId, before);
  });
});
