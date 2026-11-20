import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { readWorkingReport } from '@/lib/data/workingReport';
import { orNotFound } from '@/lib/auth/titleGate';
import { PROJECT_COPY } from '@/lib/project/copy';
import { pageTitle } from '@/lib/ui/title';
import { isUuid } from '@/lib/shell/nav';
import { WorkingReportView } from '@/components/report/WorkingReportView';
import RememberProject from '@/components/layout/RememberProject';
import { reportRefusalFrom } from '@/lib/http/exportRefusal';

interface PageProps {
  params: Promise<{ slug: string; id: string }>;
}
type SearchProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * The gates and the read, once per request: the page and its title both read through this (React `cache()`), so a project that is not
 * visible is the same 404 for both and its title names nothing. The gate is `project:read`, as the project page's; the read then asks
 * `record:read`, which every role that holds the first holds too. A project of another organisation is `NotFoundError` in the read,
 * mapped to Next's 404 by `notFound()` here (NFR-SEC-02); a refusal by the gate is mapped by the organisation layout, and in the title by `orNotFound`.
 */
const load = cache(async (slug: string, id: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'project:read');
  // An id that is not a UUID is no project, and the database would refuse it as an error instead of finding nothing.
  if (!isUuid(id)) notFound();
  try {
    return { ...(await readWorkingReport(ctx, { userId: identity.userId, role: ctx.role }, id)), userId: identity.userId };
  } catch (e) {
    // The read answers NotFoundError for a project the organisation does not hold, and the page answers it as a 404, as every project page does.
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, id } = await params;
  return { title: pageTitle(PROJECT_COPY.titles.workingReport, (await orNotFound(load(slug, id))).record.project.name) };
}

/**
 * The working report of a project (path to outputs, Task 10; design G1): a draft made from the current answers, open to every member who
 * can read the project, at any time and with nothing sealed. The page reads only: nothing it does writes a row (anti-goal 5), and it renders
 * no PDF; the downloads are links to the route that does (Task 9). The reads are one REPEATABLE READ snapshot, so page 1 and the draft
 * documents below it list the same open items.
 */
export default async function WorkingReportPage({ params, searchParams }: PageProps & SearchProps) {
  const { slug, id } = await params;
  const { record, summary, userId } = await load(slug, id);
  return (
    <>
      <WorkingReportView orgSlug={slug} projectId={id} record={record} summary={summary} refusal={reportRefusalFrom(await searchParams)} />
      <RememberProject userId={userId} orgSlug={slug} projectId={id} />
    </>
  );
}
