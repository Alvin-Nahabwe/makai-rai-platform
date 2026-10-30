/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producers replace the file's bodies. */
import type { OrgContext } from '@/lib/data/tenant';
import type { Actor, WriteOutcome } from '@/types/record';
import type {
  DocumentPreview, IssueDocumentRequest, IssuedDocumentView, PreviewDocumentRequest, WithdrawDocumentRequest,
} from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Preview, issue, list, download, withdraw and plain text of issued documents (FR-DOC-01 to 08). Typed stubs until the producers merge. */

// CONTRACT_STUB: DOC-a
export async function previewDocument(
  ctx: OrgContext, actor: Actor, a: PreviewDocumentRequest & { projectId: string; reviewId: string },
): Promise<DocumentPreview> {
  throw new NotImplementedError('DOC-a');
}

// CONTRACT_STUB: DOC-a
export async function issueDocument(
  ctx: OrgContext, actor: Actor, a: IssueDocumentRequest & { projectId: string; reviewId: string }, digest: string,
): Promise<WriteOutcome<IssuedDocumentView>> {
  throw new NotImplementedError('DOC-a');
}

// CONTRACT_STUB: DOC-a
export async function listDocuments(
  ctx: OrgContext, filter: { projectId: string; reviewId?: string },
): Promise<IssuedDocumentView[]> {
  return [];
}

// CONTRACT_STUB: DOC-a
export async function readDocumentPdf(
  ctx: OrgContext, documentId: string,
): Promise<{ bytes: Buffer; fileName: string }> {
  throw new NotImplementedError('DOC-a');
}

// CONTRACT_STUB: DOC-b
export async function withdrawDocument(
  ctx: OrgContext, actor: Actor, a: WithdrawDocumentRequest & { documentId: string }, digest: string,
): Promise<WriteOutcome<IssuedDocumentView>> {
  throw new NotImplementedError('DOC-b');
}

// CONTRACT_STUB: DOC-b
export async function readDocumentText(ctx: OrgContext, documentId: string): Promise<string> {
  throw new NotImplementedError('DOC-b');
}
