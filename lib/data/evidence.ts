import { createHash } from 'node:crypto';
import questionBank from '@/data/questionBank.json';
import type { TenantTx } from '@/lib/data/tenant';

export type CreateEvidenceInput = {
  assessmentId: string;
  frameworkVersionId: string;
  questionId: string | null;
  remediationItemId: string | null;
  filename: string;
  mimeType: string;
  content: Buffer;
  uploadedById: string;
  orgId: string;
};

/**
 * Metadata and blob are written in ONE transaction: a metadata row with no
 * bytes is a broken evidence claim, and bytes with no metadata are
 * unreachable. The caller is already inside withOrg, so `tx` is that
 * transaction -- do not open a second one.
 *
 * O-23: `existing` is a idempotency check keyed on the SAME four columns as
 * `evidence_dedup_key` (`assessmentId, sha256, questionId, remediationItemId`,
 * `UNIQUE ... NULLS NOT DISTINCT`) -- a retry after a dropped response
 * returns the row already created rather than raising a constraint error or
 * creating a second one.
 */
export async function createEvidence(input: CreateEvidenceInput, tx: TenantTx) {
  const sha256 = createHash('sha256').update(input.content).digest('hex');

  const existing = await tx.evidence.findFirst({
    where: {
      assessmentId: input.assessmentId,
      sha256,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
    },
  });
  if (existing) return existing;

  const row = await tx.evidence.create({
    data: {
      orgId: input.orgId,
      assessmentId: input.assessmentId,
      frameworkVersionId: input.frameworkVersionId,
      questionId: input.questionId,
      remediationItemId: input.remediationItemId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteLength,
      sha256,
      uploadedById: input.uploadedById,
    },
  });
  await tx.evidenceBlob.create({
    // Prisma's generated `Bytes` type is `Uint8Array<ArrayBuffer>` specifically,
    // not the wider `Buffer<ArrayBufferLike>` (Buffer's `.buffer` can in
    // principle be a SharedArrayBuffer) -- `new Uint8Array(...)` copies into a
    // freshly allocated, non-shared ArrayBuffer, satisfying that type exactly.
    data: { evidenceId: row.id, orgId: input.orgId, content: new Uint8Array(input.content) },
  });
  return row;
}

/**
 * Metadata only -- never selects the blob. The tables are split precisely so
 * this cannot accidentally drag bytes; keep it that way.
 */
export function listEvidenceForAssessment(assessmentId: string, tx: TenantTx) {
  return tx.evidence.findMany({
    where: { assessmentId },
    orderBy: { uploadedAt: 'desc' },
  });
}

/**
 * The full set of question ids in the CURRENTLY deployed question bank,
 * flattened from `data/questionBank.json`'s `stages -> modules -> questions`
 * nesting. Computed once at module load from a STATIC import (matches
 * `lib/data/framework.ts#readCurrentContentVersion`'s own reasoning: no
 * synchronous disk I/O inside an open `withOrg` transaction, which holds one
 * of only 10 pooled connections) -- generated from the file rather than
 * hand-maintained, per AGENTS.md §3 ("where a list must be complete,
 * generate it rather than writing it").
 */
type QuestionBankShape = {
  stages: Record<string, { modules: Array<{ questions: Array<{ id: string }> }> }>;
};

const ALL_QUESTION_IDS: ReadonlySet<string> = new Set(
  Object.values((questionBank as QuestionBankShape).stages).flatMap((stage) =>
    stage.modules.flatMap((mod) => mod.questions.map((q) => q.id)),
  ),
);

/**
 * O-22: does `questionId` name a real question in the question bank?
 *
 * Safe to read as "the PINNED version's question bank" only once the
 * caller has already confirmed `resolveFramework(assessmentId, tx).matches
 * === true` for this assessment -- `data/questionBank.json` is one of the
 * four files `lib/framework/bundleHash.ts#BUNDLE_FILES` hashes, so a
 * `matches` result of `true` already proves the deployed file IS the
 * content this assessment pinned. Verifying that is the ROUTE's ordering
 * responsibility (it runs this check only after the drift check), not this
 * function's -- a pure lookup has no assessment to check drift against.
 *
 * O-2's CHECK constraint proves exactly one attach target is present; this
 * proves the questionId target, when present, actually exists -- a
 * different claim neither the CHECK nor `num_nonnulls` establishes.
 */
export function questionExistsInBank(questionId: string): boolean {
  return ALL_QUESTION_IDS.has(questionId);
}
