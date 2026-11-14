import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadFindingsPage, type FindingsPageData, type RaisePrefill } from '@/lib/findings/pageData';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import { FindingsPageView } from '@/components/findings/FindingsPageView';
import { STAGES, type Stage } from '@/types/record';
import RememberProject from '@/components/layout/RememberProject';

const first = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v !== '' ? v : Array.isArray(v) && v[0] ? v[0] : null);
const asStage = (v: string | null): Stage | null => ((STAGES as readonly (string | null)[]).includes(v) ? (v as Stage) : null);

type Params = Promise<{ slug: string; id: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

/** The query values the loader reads, in `load`'s parameter order after the slug and the project id. */
type FindingsQuery = readonly [stage: string | null, raise: string | null, questionId: string | null, versionId: string | null, shown: string | null];

/** The query values the loader reads, as primitives: the page and its title derive them here, so they share one load. */
async function queryOf(searchParams: Search): Promise<FindingsQuery> {
  const query = await searchParams;
  return [first(query.stage), first(query.raise), first(query.questionId), first(query.versionId), first(query.shown)] as const;
}

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so a
 * person who is not a member, or a project not visible, is the same `notFound()` for both and the title names nothing.
 */
const load = cache(async (
  slug: string, id: string, stageParam: string | null, raiseParam: string | null, questionId: string | null, versionId: string | null, shown: string | null,
): Promise<FindingsPageData> => {
  const identity = await requireIdentity();
  const stage = asStage(stageParam);
  const raise: RaisePrefill | null = raiseParam === '1' && stage !== null
    ? { stage, questionId, versionId } : null;

  let data: FindingsPageData;
  try {
    const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
    data = await loadFindingsPage(ctx, identity, { projectId: id, stage: raise === null ? stage : null, raise, shown });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return data;
});

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: Search }): Promise<Metadata> {
  const { slug, id } = await params;
  const data = await orNotFound(load(slug, id, ...(await queryOf(searchParams))));
  return { title: pageTitle(FINDINGS_COPY.titles.findings, data.projectName) };
}

/**
 * S-14, the findings of a project (UX-15; SRS 7.4.2). The gate is `record:read`, every role's, so this refuses only a person
 * who is not a member (404, ADR-0001; NFR-SEC-02). `?stage=` filters to one stage; `?raise=1&stage=&questionId=&versionId=` is the
 * link S-12 sends a reviewer by (UX-14), and then `stage` fills the form and filters nothing. `?shown=` pages every list (UX-40).
 * `params` and `searchParams` are Promises (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function FindingsPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { slug, id } = await params;
  const data = await load(slug, id, ...(await queryOf(searchParams)));
  return (
    <>
      <FindingsPageView data={data} />
      <RememberProject userId={data.userId} orgSlug={slug} projectId={data.projectId} />
    </>
  );
}
