import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { can } from '@/lib/authz/policy';
import { withOrg } from '@/lib/data/tenant';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { OpenReviewForm } from '@/components/review/OpenReviewForm';
import { STAGES, type Stage } from '@/types/record';
import { REVIEW_COPY } from '@/lib/review/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import RememberProject from '@/components/layout/RememberProject';

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The gates and the project read, once per request: the page and its title both read through this (React `cache()`), so
 * a project that is not visible is the same `notFound()` for both. The page's later read stays in the page.
 */
const load = cache(async (slug: string, id: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  const project = await withOrg(ctx, (tx) => tx.project.findUnique({ where: { id }, select: { id: true, name: true, archivedAt: true } }));
  if (project === null) notFound();
  return { identity, ctx, project };
});

export async function generateMetadata({ params }: Pick<PageProps, 'params'>): Promise<Metadata> {
  const { slug, id } = await params;
  const { project } = await orNotFound(load(slug, id));
  return { title: pageTitle(REVIEW_COPY.titles.openReview, project.name) };
}

/**
 * The "Open a stage review" form of S-16 (W-7; FR-REV-01). Every member may open the address; a role without
 * `review:open` sees one line saying who can, with status 200 and no form (M-26 pattern, owner question B21 default),
 * and an archived project shows the banner and no form (UX-31). `?stage=` fixes the stage; anything else gives the select.
 */
export default async function OpenReviewPage({ params, searchParams }: PageProps) {
  const { slug, id } = await params;
  const { stage } = await searchParams;
  const { identity, ctx, project } = await load(slug, id);
  const heading = <h1>Open a stage review</h1>;
  const remember = <RememberProject userId={identity.userId} orgSlug={slug} projectId={project.id} />;
  if (!can(ctx.role, 'review:open')) {
    return <div className="page-content">{heading}<p>Only owners, admins and assessors can open a stage review.</p>{remember}</div>;
  }
  if (project.archivedAt !== null) {
    return <div className="page-content"><ArchivedBanner archived />{heading}{remember}</div>;
  }
  // Only the next number of each stage is needed: one read of the reviews' stages and numbers, not the seal state (C4 SF-6).
  const reviews = await withOrg(ctx, (tx) => tx.stageReview.findMany({ where: { projectId: id }, select: { stage: true, numberInStage: true } }));
  const nextNumbers = Object.fromEntries(STAGES.map((s) => [s, Math.max(0, ...reviews.filter((r) => r.stage === s).map((r) => r.numberInStage)) + 1])) as Record<Stage, number>;
  const fixedStage = typeof stage === 'string' && (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : null;
  return (
    <div className="page-content">
      {heading}
      <OpenReviewForm orgSlug={slug} projectId={id} userId={identity.userId} fixedStage={fixedStage} nextNumbers={nextNumbers} />
      {remember}
    </div>
  );
}
