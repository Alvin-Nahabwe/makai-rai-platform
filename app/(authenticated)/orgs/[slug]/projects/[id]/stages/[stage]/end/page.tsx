import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { orNotFound } from '@/lib/auth/titleGate';
import { loadStageEnd } from '@/lib/question/stageEnd';
import { QUESTION_COPY } from '@/lib/question/copy';
import { pageTitle } from '@/lib/ui/title';
import { isUuid } from '@/lib/shell/nav';
import { STAGES, type Stage } from '@/types/record';
import { StageEnd } from '@/components/question/StageEnd';
import RememberProject from '@/components/layout/RememberProject';

type Params = Promise<{ slug: string; id: string; stage: string }>;

/**
 * The gates and the reads, once per request: the page and its title both read through this (React `cache()`), so an unknown
 * stage or a project not visible is the same `notFound()` for both and the title names nothing. The gate is `record:read`, as
 * the stage page's: every member who can read the stage can read where it stands.
 */
const load = cache(async (slug: string, id: string, stage: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage) || !isUuid(id)) notFound();
  try {
    const data = await loadStageEnd(ctx, identity.userId, id, stage as Stage);
    if (data === null) notFound();
    return data;
  } catch (e) {
    // The working report's read answers NotFoundError for a project the organisation does not hold, as the report page maps it.
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, id, stage } = await params;
  return { title: pageTitle(QUESTION_COPY.end.title, (await orNotFound(load(slug, id, stage))).page.projectName) };
}

/**
 * The end of a stage (path to outputs, design G3): where saving the last question of a stage lands, and where the stage page and
 * the last question link back to. It reads only (the stage page's read and the working report's), and holds no form: the one
 * control that writes is the seal step, for the roles that may use it.
 */
export default async function StageEndPage({ params }: { params: Params }) {
  const { slug, id, stage } = await params;
  const { page, takenAt, summary, applies, canWrite } = await load(slug, id, stage);
  return (
    <>
      <StageEnd
        orgSlug={slug} projectId={id} projectName={page.projectName} projectArchived={page.projectArchived} stage={page.stage} takenAt={takenAt}
        rows={page.rows} marks={page.marks} summary={summary} applies={applies} canWrite={canWrite} sealStep={page.sealStep}
      />
      <RememberProject userId={page.viewerId} orgSlug={slug} projectId={page.projectId} />
    </>
  );
}
