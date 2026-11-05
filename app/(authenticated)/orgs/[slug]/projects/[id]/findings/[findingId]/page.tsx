import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadFindingPage, type FindingPageData } from '@/lib/findings/pageData';
import { FindingPageView } from '@/components/findings/FindingPageView';

/**
 * S-15, one finding of a project (FR-FND-01, 03 to 07; SRS 7.4.2 S-15 row). The gate is `record:read`, every role's, so this refuses
 * only a person who is not a member (404, ADR-0001). A finding of another project or organisation reads as not found (NFR-SEC-02):
 * `findingDetail` asks for the route's own project. A role that cannot act gets the page with the action absent or its M-26 line
 * (owner question B21). `params` is a Promise (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md).
 */
export default async function FindingPage({ params }: { params: Promise<{ slug: string; id: string; findingId: string }> }) {
  const { slug, id, findingId } = await params;
  const identity = await requireIdentity();
  let data: FindingPageData;
  try {
    const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
    data = await loadFindingPage(ctx, identity, { projectId: id, findingId });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return <FindingPageView data={data} />;
}
