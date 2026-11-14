import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { listStageReviews, sealPreview } from '@/lib/data/reviews';
import { questionsInStage, reasonCodesFor, runningContent } from '@/lib/content/loader';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { SealConfirm } from '@/components/review/SealConfirm';
import { REVIEW_COPY } from '@/lib/review/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { contentChangedLine, previewLines } from '@/components/review/reviewText';
import RememberProject from '@/components/layout/RememberProject';

interface PageProps {
  params: Promise<{ slug: string; id: string; reviewId: string }>;
}

/**
 * The gates, the project read and the review lookup, once per request: the page and its title both read through this
 * (React `cache()`), so a project not visible, or a review not of this project, is the same `notFound()` for both and
 * the title names nothing. The page's later reads stay in the page.
 */
const load = cache(async (slug: string, id: string, reviewId: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, name: true, archivedAt: true } }));
  if (project === null) notFound();
  const review = (await listStageReviews(ctx, id)).find((r) => r.id === reviewId);
  if (review === undefined) notFound();
  return { identity, ctx, project, review };
});

/** The seal number the next seal of this review takes. */
const nextSealNumber = (review: { latestSeal: { sealNumber: number } | null }): number => (review.latestSeal?.sealNumber ?? 0) + 1;

/** The page's own heading, then the project. */
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id, reviewId } = await params;
  const { project, review } = await orNotFound(load(slug, id, reviewId));
  return { title: pageTitle(REVIEW_COPY.titles.seal(review.name, nextSealNumber(review)), project.name) };
}

/**
 * S-17, the seal confirmation (W-7; FR-REV-02, FR-REV-03, UX-18). Every member may open the address (`record:read`):
 * a role without `review:seal` sees the 7.4.2 refusal line with status 200 and no form (owner question B21 default),
 * and route 13 refuses it too; an archived project shows the archived banner and no form (UX-31). For the others the
 * page renders what the seal will hold (`sealPreview`, read as the person sealing) inside `SealConfirm`.
 */
export default async function SealConfirmationPage({ params }: PageProps) {
  const { slug, id, reviewId } = await params;
  const { identity, ctx, project, review } = await load(slug, id, reviewId);
  const archived = project.archivedAt !== null;
  const sealNumber = nextSealNumber(review);
  const base = `/orgs/${encodeURIComponent(slug)}/projects/${encodeURIComponent(id)}`;
  const heading = <h1>{`Seal "${review.name}" as seal ${sealNumber}`}</h1>;
  const remember = <RememberProject userId={identity.userId} orgSlug={slug} projectId={project.id} />;

  if (!can(ctx.role, 'review:seal')) {
    return <div className="page-content">{heading}<p>Only owners, admins and reviewers can seal a stage review.</p>{remember}</div>;
  }
  if (archived) {
    return <div className="page-content"><ArchivedBanner archived />{heading}{remember}</div>;
  }

  const content = runningContent();
  const preview = await sealPreview(ctx, { userId: identity.userId, role: ctx.role }, reviewId);
  const labels = Object.fromEntries([...reasonCodesFor(content, 'not_applicable'), ...reasonCodesFor(content, 'not_yet')].map((c) => [c.code, c.label]));
  const lines = previewLines(preview, sealNumber, labels);
  const contentLine = contentChangedLine(review.latestSeal, content.semver);
  return (
    <div className="page-content">
      {heading}
      <SealConfirm
        orgSlug={slug} projectId={id} reviewId={reviewId} stage={review.stage} sealNumber={sealNumber}
        userId={identity.userId} orgId={ctx.orgId} questionIds={questionsInStage(content, review.stage).map((q) => q.id)}
      >
        <p>{lines[0]}</p>
        {contentLine !== null ? <p>{contentLine}</p> : null}
        <h2>{`What the seal will hold (${review.stage})`}</h2>
        <ul>
          {lines.slice(1).map((l) => <li key={l}>{l}</li>)}
          <li>
            {`No decision (${preview.noDecision.length})`}
            {preview.noDecision.length > 0 ? ': ' : ''}
            {preview.noDecision.map((q, i) => (
              <span key={q}>{i > 0 ? ', ' : ''}<a href={`${base}/stages/${review.stage}/questions/${encodeURIComponent(q)}`}>{q}</a></span>
            ))}
          </li>
        </ul>
      </SealConfirm>
      {remember}
    </div>
  );
}
