import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { listStageReviews } from '@/lib/data/reviews';
import { listSeals } from '@/lib/data/seals';
import { documentDraft, documentSummaries, listDocuments, typedFieldsOf } from '@/lib/data/documents';
import { runningContent } from '@/lib/content/loader';
import { DOCUMENT_TITLES } from '@/lib/documents/copy';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/record';
import { MSG_SEAL_CHECK_FAILED } from '@/lib/documents/copy';
import { RENDERERS } from '@/lib/documents/render';
import { AppError } from '@/lib/http/errors';
import { logSecurityEvent } from '@/lib/security-logger';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { GenerateDocumentForm, NeverSealed, type GenerateDocumentFormProps } from '@/components/documents/GenerateDocumentForm';
import { IssuedDocumentsList } from '@/components/documents/IssuedDocumentsList';

interface PageProps {
  params: Promise<{ slug: string; id: string; reviewId: string }>;
}

/**
 * S-18, the documents of one stage review (W-9; FR-DOC-01 to 05, FR-DOC-08; UX-20). Every member reads it (`record:read`) and sees
 * the issued documents; the generate form is for `document:generate` roles of a live project, and the drafts of typed values are
 * read only for them. A review of another organisation or project is not found (RLS, then the review-to-project check) before
 * anything else is read. A review never sealed shows only the way to seal it.
 */
export default async function DocumentsPage({ params }: PageProps) {
  const { slug, id, reviewId } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, archivedAt: true } }));
  if (project === null) notFound();
  const review = (await listStageReviews(ctx, id)).find((r) => r.id === reviewId);
  if (review === undefined) notFound();

  const archived = project.archivedAt !== null;
  const [seals, documents] = await Promise.all([listSeals(ctx, reviewId), listDocuments(ctx, { projectId: id, reviewId })]);
  const latestNumber = seals.reduce<number | null>((n, s) => (n === null || s.sealNumber > n ? s.sealNumber : n), null);
  const canGenerate = can(ctx.role, 'document:generate') && !archived;
  const canWithdraw = can(ctx.role, 'document:withdraw') && !archived;
  const usable = seals.filter((s) => s.bytesMatch);

  // The documents with a generator. The mitigation plan is offered once DOC-b registers its renderer (RENDERERS has no entry for it before).
  const offered = DOCUMENT_TYPES.filter((t) => RENDERERS[t] !== null);
  let formProps: GenerateDocumentFormProps | null = null;
  // A seal that fails its check cannot be a source (NFR-INT-05): the form's place holds that line, and the issued list and its downloads stay.
  let sealsFailed = canGenerate && seals.length > 0 && usable.length === 0;
  if (canGenerate && usable.length > 0) {
    try {
      const drafts = Object.fromEntries(await Promise.all(DOCUMENT_TYPES.map(async (t) => [t, await documentDraft(ctx, id, t)] as const))) as Record<DocumentType, Record<string, string>>;
      const summaries = await documentSummaries(ctx, { projectId: id, reviewId, sealId: usable[0].id }, drafts);
      const help = runningContent().documentHelp;
      formProps = {
        orgSlug: slug, projectId: id, reviewId,
        seals: seals.map((s) => ({ sealId: s.id, sealNumber: s.sealNumber, reviewId, reviewName: review.name, sealedAt: s.sealedAt, latest: s.sealNumber === latestNumber, bytesMatch: s.bytesMatch })),
        documents: offered.map((t) => ({
          type: t, title: DOCUMENT_TITLES[t], help: help[t], neverSealedStages: summaries[t]?.neverSealedStages ?? [], typedFields: typedFieldsOf(t), draft: drafts[t],
          fromRecord: summaries[t] === null ? null : { fields: summaries[t].fields, questions: summaries[t].questions, notRecorded: summaries[t].notRecorded },
        })),
      };
    } catch (e) {
      // Only a seal that cannot be read as a seal of this project is caught (the snapshot has logged its id); anything else is a fault and goes on.
      if (!(e instanceof AppError && (e.code === 'integrity_failure' || e.code === 'validation'))) throw e;
      logSecurityEvent('SEAL_CHECK_FAILED', 'error', { details: { sealId: usable[0].id, reviewId, kind: 'summary_failed', code: e.code } });
      sealsFailed = true;
    }
  }
  const form = formProps === null ? null : <GenerateDocumentForm {...formProps} />;

  return (
    <div className="page-content">
      <ArchivedBanner archived={archived} />
      <h1>Generate a document</h1>
      <p>{review.name}</p>
      {seals.length === 0 ? <NeverSealed orgSlug={slug} projectId={id} reviewId={reviewId} /> : (
        <>
          {form !== null ? <section aria-labelledby="documents-generate"><h2 id="documents-generate">Documents</h2>{form}</section> : null}
          {sealsFailed ? <section aria-labelledby="documents-generate"><h2 id="documents-generate">Documents</h2><p>{MSG_SEAL_CHECK_FAILED}</p></section> : null}
          <section aria-labelledby="documents-issued">
            <h2 id="documents-issued">Issued documents</h2>
            <IssuedDocumentsList orgSlug={slug} documents={documents} latestSealNumber={latestNumber} canWithdraw={canWithdraw} />
          </section>
        </>
      )}
    </div>
  );
}
