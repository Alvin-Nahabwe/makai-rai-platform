import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { currentDecisions } from '@/lib/data/decisions';
import { listFindings } from '@/lib/data/findings';
import { changedSinceSeal, listStageReviews } from '@/lib/data/reviews';
import { stageFollowUpCounts } from '@/lib/data/followup';
import { eatDate } from '@/lib/followup/overdue';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { rewordedQuestionIds } from '@/lib/question/reworded';
import { buildStageRows, filterCounts, filterLabel, isStageFilter, moduleGroups, STAGE_FILTERS, STAGE_TITLE, type StageFilter, type StageRow } from '@/lib/question/stageList';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageSealBanner } from '@/components/review/StageSealBanner';
import { StageFollowUpCounts } from '@/components/followup/StageFollowUpCounts';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { ListLink } from '@/components/ui/ListLink';
import { STAGES, type ScopeAnswer, type Stage } from '@/types/record';
import type { ChangedSinceSeal } from '@/types/api';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';


export interface StagePageData {
  orgSlug: string; orgId: string; projectId: string; projectName: string; projectArchived: boolean; stage: Stage; viewerId: string;
  rows: StageRow[]; nothingRecorded: boolean; changed: ChangedSinceSeal | null;
  /** The newest stage review of this stage, whose seal `changed` compares against (REV-b's listStageReviews). */
  review: { id: string; name: string } | null;
  followUp: { openFindings: number; overdueMitigations: number };
}

/**
 * S-11's data (W-2; FR-PRJ-02, FR-CNT-04, FR-CNT-06, FR-CNT-08, FR-REV-05): the stage's questions in the running
 * content's module order with each one's current decision, open findings, the newest review's "changed since seal",
 * and the reworded marker. The project is read inside `withOrg`, so another organisation's project is not found
 * (NFR-SEC-02). Each read is its producer's service; until a producer merges its stub answers an empty value.
 */
export async function loadStagePage(ctx: OrgContext, viewerId: string, projectId: string, stage: Stage): Promise<StagePageData | null> {
  const project = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id: projectId }, select: { name: true, archivedAt: true, org: { select: { slug: true } } } }));
  if (project === null) return null;
  const running = runningContent();
  const today = eatDate(new Date());
  const [current, findings, reviews, followUp, gateStage] = await Promise.all([
    currentDecisions(ctx, projectId, stage),
    listFindings(ctx, projectId, stage, today),
    listStageReviews(ctx, projectId, stage),
    stageFollowUpCounts(ctx, projectId, stage, today),
    stage === 'pre-processing' ? Promise.resolve(null) : currentDecisions(ctx, projectId, 'pre-processing'),
  ]);
  const gateId = [...running.questions.values()].find((q) => q.condition !== undefined)?.condition?.questionId ?? null;
  const gateVersion = gateId === null ? undefined : (gateStage ?? current).get(gateId);
  const gate = gateVersion !== undefined && gateVersion.status !== 'withdrawn' ? (gateVersion.scopeAnswer as ScopeAnswer | null) : null;
  const newest = reviews.reduce<(typeof reviews)[number] | null>((a, r) => (a === null || r.numberInStage > a.numberInStage ? r : a), null);
  const changed = newest === null ? null : await changedSinceSeal(ctx, newest.id);
  const open = new Map<string, number>();
  for (const f of findings) if (f.state === 'open' && f.questionId !== null) open.set(f.questionId, (open.get(f.questionId) ?? 0) + 1);
  const rows = buildStageRows({
    questions: questionsInStage(running, stage), current, gate, openFindingsByQuestion: open,
    changed: changed?.changedQuestions ?? [], reworded: rewordedQuestionIds(current, running),
  });
  return {
    orgSlug: project.org.slug, orgId: ctx.orgId, projectId, projectName: project.name, projectArchived: project.archivedAt !== null, stage, viewerId,
    rows, nothingRecorded: current.size === 0, changed, followUp,
    review: newest === null ? null : { id: newest.id, name: newest.name },
  };
}

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
  return <StageWorkspace data={data} show={show} shown={shown} />;
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
      {/* W-2's subtitle: the stage and its modules, in module order. */}
      <p className="text-muted">{`${STAGE_TITLE[data.stage]}: ${moduleGroups(data.rows).map((g) => g.moduleTitle).join('; ')}`}</p>
      <p data-stage-summary>{`${data.rows.length} questions · ${noDecision} with no decision`}</p>
      <StageFollowUpCounts orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} counts={data.followUp} />
      {data.nothingRecorded
        ? <p>Nothing is recorded for this stage yet. Open any question to start. Stages can be recorded in any order.</p>
        : null}
      {data.changed !== null && data.review !== null ? (
        // W-2: "<review name>: changed since seal N in M questions. [Open review >]"; the banner prints all but the name.
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'baseline' }}>
          <strong>{`${data.review.name}:`}</strong>
          <StageSealBanner changed={data.changed} reviewHref={`${base}/reviews/${data.review.id}`} />
        </div>
      ) : null}
      <StageQuestionList
        orgSlug={data.orgSlug} orgId={data.orgId} projectId={data.projectId} stage={data.stage} viewerId={data.viewerId}
        rows={page.items} show={show} counts={counts} filters={filters.map((f) => ({ key: f, label: filterLabel(f, sealNumber) }))}
        total={data.rows.length} sealNumber={sealNumber}
      />
      {page.hasMore ? <ShowMoreLink href={`?show=${show}&shown=${page.nextShown}`} label="Show more" /> : null}
    </div>
  );
}
