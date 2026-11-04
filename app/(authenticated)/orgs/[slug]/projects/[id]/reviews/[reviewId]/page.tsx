import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { listStageReviews } from '@/lib/data/reviews';
import { listSeals } from '@/lib/data/seals';
import { listDocuments } from '@/lib/data/documents';
import { runningContent } from '@/lib/content/loader';
import { formatDay, formatTime } from '@/lib/format/dates';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { SealCheckButton } from '@/components/review/SealCheckButton';
import { ReviewDocumentsList } from '@/components/documents/ReviewDocumentsList';
import { FingerprintDisplay } from '@/components/review/FingerprintDisplay';
import { SEAL_PROOF_HREF, contentChangedLine, reviewStateLine, sealAgainLabel } from '@/components/review/reviewText';

interface PageProps {
  params: Promise<{ slug: string; id: string; reviewId: string }>;
}

/**
 * S-16, the stage review (W-7; FR-REV-01, FR-REV-04, FR-REV-05). Every member reads it (`record:read`); the seal path
 * is shown only to `review:seal` roles of a live project, and "Generate a document" only to `document:generate` roles.
 * A review of another organisation or project is not found (RLS, then the review-to-project check). Links are native
 * `a` elements: S-11, S-15 and S-18 belong to units that may not have built them yet, and a plain link is never
 * prefetched.
 */
export default async function StageReviewPage({ params }: PageProps) {
  const { slug, id, reviewId } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, archivedAt: true } }));
  if (project === null) notFound();
  const review = (await listStageReviews(ctx, id)).find((r) => r.id === reviewId);
  if (review === undefined) notFound();
  const [seals, documents] = await Promise.all([listSeals(ctx, reviewId), listDocuments(ctx, { projectId: id, reviewId })]);

  const archived = project.archivedAt !== null;
  const base = `/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(id)}`;
  const canSeal = can(ctx.role, 'review:seal') && !archived;
  const contentLine = contentChangedLine(review.latestSeal, runningContent().semver);
  const opened = [
    `Stage: ${review.stage}`,
    review.preparedForErased !== null ? `Prepared for: erased on ${formatDay(review.preparedForErased.erasedOn)}`
      : review.preparedFor !== null ? `Prepared for: ${review.preparedFor}` : null,
    `Opened by ${review.openedBy.name} on ${formatDay(review.openedAt)}`,
  ].filter((x): x is string => x !== null).join(' . ');

  return (
    <div className="page-content">
      <ArchivedBanner archived={archived} />
      <h1>{review.name}</h1>
      <p>{opened}</p>

      <section aria-labelledby="review-state">
        <h2 id="review-state">State</h2>
        <p>{reviewStateLine(review)}</p>
        {contentLine !== null ? <p>{contentLine}</p> : null}
        {review.changed !== null ? (
          <>
            {review.changed.changedQuestions.length > 0 ? (
              <p>
                {`Questions with newer versions (${review.changed.changedQuestions.length}): `}
                {review.changed.changedQuestions.map((q, i) => (
                  <span key={q}>{i > 0 ? ', ' : ''}<a href={`${base}/stages/${review.stage}/questions/${encodeURIComponent(q)}`}>{q}</a></span>
                ))}
              </p>
            ) : null}
            {review.changed.changedFindings.length > 0 ? (
              <p>
                {`Findings changed (${review.changed.changedFindings.length}): `}
                {review.changed.changedFindings.map((f, i) => (
                  <span key={f}>{i > 0 ? ', ' : ''}<a href={`${base}/findings/${encodeURIComponent(f)}`}>{`Finding ${i + 1}`}</a></span>
                ))}
              </p>
            ) : null}
          </>
        ) : null}
        {canSeal && review.latestSeal === null ? <p><a href={`${base}/reviews/${encodeURIComponent(review.id)}/seal`}>Seal this review</a></p> : null}
        {canSeal && review.latestSeal !== null ? (
          <p><a href={`${base}/reviews/${encodeURIComponent(review.id)}/seal`}>{sealAgainLabel(review.latestSeal.sealNumber + 1)}</a></p>
        ) : null}
      </section>

      <section aria-labelledby="review-seals">
        <h2 id="review-seals">Seals</h2>
        {seals.length === 0 ? null : (
          <ul>
            {seals.map((s) => (
              <li key={s.id}>
                <p>{`Seal ${s.sealNumber} . ${formatDay(s.sealedAt)} ${formatTime(s.sealedAt)} . sealed by ${s.sealedBy.name} (${s.sealedByRole})`}</p>
                {s.bytesMatch ? null : <p>Does not match the record.</p>}
                <FingerprintDisplay fingerprint={s.fingerprint} />
                <SealCheckButton orgSlug={slug} projectId={id} reviewId={review.id} sealId={s.id} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="review-documents">
        <h2 id="review-documents">Documents from this review</h2>
        <ReviewDocumentsList orgSlug={slug} projectId={id} reviewId={review.id} documents={documents} />
        {can(ctx.role, 'document:generate') && !archived && seals.length > 0 ? (
          <p><a href={`${base}/reviews/${encodeURIComponent(review.id)}/documents`}>Generate a document</a></p>
        ) : null}
      </section>

      <p>Sealed by the platform; not independently time-stamped. <a href={SEAL_PROOF_HREF}>What a seal proves</a></p>
    </div>
  );
}
