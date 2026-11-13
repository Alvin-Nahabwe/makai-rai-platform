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
import type { OrgContext } from '@/lib/data/tenant';
import { REVIEW_COPY } from '@/lib/review/copy';
import { pageTitle } from '@/lib/ui/title';

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Whether the role may open a stage review; the page shows a refusal line, and the title names no project, when not. */
const mayOpen = (ctx: OrgContext): boolean => can(ctx.role, 'review:open');

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
  const { ctx, project } = await load(slug, id);
  return { title: pageTitle(REVIEW_COPY.titles.openReview, mayOpen(ctx) ? project.name : null) };
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
  if (!mayOpen(ctx)) {
    return <div className="page-content">{heading}<p>Only owners, admins and assessors can open a stage review.</p></div>;
  }
  if (project.archivedAt !== null) {
    return <div className="page-content"><ArchivedBanner archived />{heading}</div>;
  }
  // Only the next number of each stage is needed: one read of the reviews' stages and numbers, not the seal state (C4 SF-6).
  const reviews = await withOrg(ctx, (tx) => tx.stageReview.findMany({ where: { projectId: id }, select: { stage: true, numberInStage: true } }));
  const nextNumbers = Object.fromEntries(STAGES.map((s) => [s, Math.max(0, ...reviews.filter((r) => r.stage === s).map((r) => r.numberInStage)) + 1])) as Record<Stage, number>;
  const fixedStage = typeof stage === 'string' && (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : null;
  return (
    <div className="page-content">
      {heading}
      <OpenReviewForm orgSlug={slug} projectId={id} userId={identity.userId} fixedStage={fixedStage} nextNumbers={nextNumbers} />
    </div>
  );
}
