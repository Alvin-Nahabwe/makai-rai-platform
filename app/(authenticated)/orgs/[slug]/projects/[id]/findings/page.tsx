import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadFindingsPage, type FindingsPageData, type RaisePrefill } from '@/lib/findings/pageData';
import { FindingsPageView } from '@/components/findings/FindingsPageView';
import { STAGES, type Stage } from '@/types/record';

const first = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v !== '' ? v : Array.isArray(v) && v[0] ? v[0] : null);
const asStage = (v: string | null): Stage | null => ((STAGES as readonly (string | null)[]).includes(v) ? (v as Stage) : null);

/**
 * S-14, the findings of a project (UX-15; SRS 7.4.2). The gate is `record:read`, every role's, so this refuses only a person
 * who is not a member (404, ADR-0001; NFR-SEC-02). `?stage=` filters to one stage; `?raise=1&stage=&questionId=&versionId=` is the
 * link S-12 sends a reviewer by (UX-14), and then `stage` fills the form and filters nothing. `?shown=` pages every list (UX-40).
 * `params` and `searchParams` are Promises (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function FindingsPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug, id } = await params;
  const query = await searchParams;
  const identity = await requireIdentity();
  const stage = asStage(first(query.stage));
  const raise: RaisePrefill | null = first(query.raise) === '1' && stage !== null
    ? { stage, questionId: first(query.questionId), versionId: first(query.versionId) } : null;

  let data: FindingsPageData;
  try {
    const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
    data = await loadFindingsPage(ctx, identity, { projectId: id, stage: raise === null ? stage : null, raise, shown: first(query.shown) });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return <FindingsPageView data={data} />;
}
