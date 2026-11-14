import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { filterCounts, filterLabel, isStageFilter, moduleGroups, STAGE_FILTERS, STAGE_TITLE, type StageFilter } from '@/lib/question/stageList';
import { loadStagePage, type StagePageData } from '@/lib/question/stagePage';
import { stopsOf, tallyOfRows } from '@/lib/question/route';
import { questionHref } from '@/lib/question/draft';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageSealBanner } from '@/components/review/StageSealBanner';
import { StageFollowUpCounts } from '@/components/followup/StageFollowUpCounts';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { RouteRow } from '@/components/ui/RouteRow';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { QUESTION_COPY } from '@/lib/question/copy';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { ListLink } from '@/components/ui/ListLink';
import { STAGES, type Stage } from '@/types/record';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import RememberProject from '@/components/layout/RememberProject';
import '@/components/question/stage-route.css';


export { loadStagePage } from '@/lib/question/stagePage';
export type { StagePageData };

type Params = Promise<{ slug: string; id: string; stage: string }>;

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so an
 * unknown stage or a project not visible is the same `notFound()` for both and the title names nothing.
 */
const load = cache(async (slug: string, id: string, stage: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage)) notFound();
  const data = await loadStagePage(ctx, identity.userId, id, stage as Stage);
  if (data === null) notFound();
  return data;
});

/** The stage's own heading, then the project. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, id, stage } = await params;
  const data = await orNotFound(load(slug, id, stage));
  return { title: pageTitle(STAGE_TITLE[data.stage], data.projectName) };
}

/**
 * S-11, the stage workspace (W-2). Every member reads it (`record:read`); a role that cannot record sees the same page,
 * with status 200 (owner question B21). `?show=<filter>` picks a filter: the server renders that filter's rows, so the
 * filters work without scripts (W-2 note 2), and `?show=drafts` renders every row for the client to narrow from this
 * device's drafts (contract "S-11 address", gap G023). Filter addresses hold only the filter key (NFR-PRIV-04).
 */
export default async function StagePage({
  params, searchParams,
}: {
  params: Params;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug, id, stage } = await params;
  const data = await load(slug, id, stage);
  const sp = await searchParams;
  const show = isStageFilter(sp.show) ? sp.show : 'all';
  const shown = typeof sp.shown === 'string' ? sp.shown : null;
  return (
    <>
      <StageWorkspace data={data} show={show} shown={shown} />
      <RememberProject userId={data.viewerId} orgSlug={slug} projectId={data.projectId} />
    </>
  );
}

/** The markup of S-11, exported so a test renders it from real data without the request. */
export function StageWorkspace({ data, show, shown }: { data: StagePageData; show: StageFilter; shown: string | null }) {
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  // RE-4: the changed filter counts every question the seal comparison names, a question the running content has cut
  // included, so it agrees with the banner (REV-b RE-1); the rows it shows are those the stage still holds.
  const counts = { ...filterCounts(data.rows, new Set()), ...(data.changed === null ? {} : { changed_since_seal: data.changed.changedQuestions.length }) };
  const noDecision = counts.no_decision;
  const page = pageOf(data.rows, shown, LIST_PAGE_SIZE);
  const sealNumber = data.changed?.sealNumber ?? null;
  const filters = STAGE_FILTERS.filter((f) => f !== 'changed_since_seal' || data.changed !== null);
  return (
    <div className="page-content">
      <ArchivedBanner archived={data.projectArchived} />
      <p><ListLink href={base}>{data.projectName}</ListLink></p>
      <h1>{STAGE_TITLE[data.stage]}</h1>
      {/* W-2's subtitle: the stage's topics, in module order. */}
      <p className="text-muted">{QUESTION_COPY.stage.topics(moduleGroups(data.rows).map((g) => g.moduleTitle))}</p>
      <p data-stage-summary>{STAGE_LIST_COPY.summary(data.rows.length, noDecision)}</p>
      {/* Spec 7.2: the whole stage as a row of marks, every question (not the page the list shows), with its tally. */}
      <div className="stage-route__marks">
        <RouteRow
          label={QUESTION_COPY.stage.routeLabel}
          stops={stopsOf(data.rows, data.marks, (q) => questionHref(data, q), undefined, data.scopeAnswer)}
          tally={tallyOfRows(data.rows, data.marks)}
        />
      </div>
      <StageFollowUpCounts orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} counts={data.followUp} />
      {data.nothingRecorded
        ? <p>{QUESTION_COPY.stage.nothingRecorded}</p>
        : null}
      {data.changed !== null && data.review !== null ? (
        // W-2: "<review name>: changed since seal N in M questions. [Open review >]"; the banner prints all but the name.
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'baseline' }}>
          <strong>{QUESTION_COPY.stage.reviewName(data.review.name)}</strong>
          <StageSealBanner changed={data.changed} reviewHref={`${base}/reviews/${data.review.id}`} />
        </div>
      ) : null}
      <StageQuestionList
        orgSlug={data.orgSlug} orgId={data.orgId} projectId={data.projectId} stage={data.stage} viewerId={data.viewerId}
        rows={page.items} show={show} counts={counts} filters={filters.map((f) => ({ key: f, label: filterLabel(f, sealNumber) }))}
        total={data.rows.length} sealNumber={sealNumber} marks={data.marks} scopeAnswer={data.scopeAnswer}
      />
      {page.hasMore ? <ShowMoreLink href={`?show=${show}&shown=${page.nextShown}`} label={QUESTION_COPY.stage.showMore} /> : null}
    </div>
  );
}
