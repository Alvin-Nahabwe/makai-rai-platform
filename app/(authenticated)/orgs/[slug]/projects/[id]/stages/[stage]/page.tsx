import { cache, type ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { isStageFilter, moduleGroups, STAGE_TITLE, type StageFilter } from '@/lib/question/stageList';
import { loadStagePage, type StagePageData } from '@/lib/question/stagePage';
import { stageFilterSet, tallyOfRows, tallyParts } from '@/lib/question/route';
import { LIST_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { StageSealBanner } from '@/components/review/StageSealBanner';
import { SealStep } from '@/components/review/SealStep';
import { sealStepTexts } from '@/lib/review/sealStep';
import { StageQuestionList } from '@/components/decision/StageQuestionList';
import { StageMeaning, stageTerm } from '@/components/question/StageMeaning';
import { StageTally } from '@/components/question/StageTally';
import { routeTermTips } from '@/components/question/termTips';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import { Icon } from '@/components/ui/Icon';
import { Term } from '@/components/ui/Definition';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { QUESTION_COPY } from '@/lib/question/copy';
import { STAGE_LIST_COPY } from '@/lib/question/list/copy';
import { ListLink } from '@/components/ui/ListLink';
import { PROJECT_COPY } from '@/lib/project/copy';
import { STAGES, type Stage } from '@/types/record';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import RememberProject from '@/components/layout/RememberProject';
import '@/components/question/stage-route.css';


export { loadStagePage } from '@/lib/question/stagePage';
export type { StagePageData };

type Params = Promise<{ slug: string; id: string; stage: string }>;

/** The words of the question page's strip (its tips' names and the personal data question's tally words). */
const FR = QUESTION_COPY.frame;

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

/** The overdue count's words with the word "overdue" in its own element, which the stylesheet draws in the overdue red. */
function overdueWords(words: string): ReactNode {
  const at = words.indexOf(FR.overdueWord);
  if (at < 0) throw new Error(`StageWorkspace: "${words}" does not hold "${FR.overdueWord}"`);
  return <>{words.slice(0, at)}<span className="stage-route__overdue-word">{FR.overdueWord}</span>{words.slice(at + FR.overdueWord.length)}</>;
}

/** The markup of S-11, exported so a test renders it from real data without the request. */
export function StageWorkspace({ data, show, shown }: { data: StagePageData; show: StageFilter; shown: string | null }) {
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  // The counts and options, and the RE-4 rule for the changed filter: lib/question/route.ts, shared with the question page's column.
  const { counts, filters, sealNumber } = stageFilterSet(data.rows, data.changed);
  const page = pageOf(data.rows, shown, LIST_PAGE_SIZE);
  const { openFindings, overdueMitigations } = data.followUp;
  const F = PROJECT_COPY.followUpCounts;
  return (
    <div className="page-content stage-route">
      <ArchivedBanner archived={data.projectArchived} />
      <Breadcrumb items={[{ label: data.projectName, href: base }, { label: STAGE_TITLE[data.stage] }]} />
      <h1><Term of={stageTerm(data.stage)}>{STAGE_TITLE[data.stage]}</Term></h1>
      {/* D1: the stage's name with its plain meaning. Then W-2's subtitle: the stage's topics, in module order. */}
      <StageMeaning stage={data.stage} />
      <p className="stage-route__topics">{QUESTION_COPY.stage.topics(moduleGroups(data.rows).map((g) => g.moduleTitle))}</p>
      {/* Design G2: the seal step for the viewer's role, under the heading (lib/review/sealStep.ts decides what it shows). */}
      <SealStep orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} state={data.sealStep} />
      {/* Spec 7.2: the whole stage's tally in words, each kind beside its mark (every question, not the page the list shows). */}
      <StageTally rows={data.rows} marks={data.marks} />
      {/* Design G3: the stage's end screen, reachable again from here (the controller's call). */}
      <p className="stage-route__end"><ListLink href={`${base}/stages/${data.stage}/end`}>{QUESTION_COPY.end.link}</ListLink></p>
      {/* The follow-up counts as links, each only above zero (plan 1C Task 3): the findings list and the stage's follow-up. */}
      {openFindings > 0 || overdueMitigations > 0 ? (
        <p className="stage-route__followup">
          {openFindings > 0 ? <ListLink href={`${base}/findings`}>{`${openFindings} ${openFindings === 1 ? F.openFinding : F.openFindings}`}</ListLink> : null}
          {/* The gap shows the two apart; in text (copied, or read without styles) they are a list, as they were before. */}
          {openFindings > 0 && overdueMitigations > 0 ? <span className="visually-hidden">, </span> : null}
          {overdueMitigations > 0 ? (
            // As the question page's strip draws it (fix round 3, S3-N4; spec 7.1): an ink link, red only on the clock and the
            // word "overdue".
            <ListLink className="stage-route__overdue" href={`${base}#${data.stage}`}>
              <Icon name="clock" size={16} />{overdueWords(`${overdueMitigations} ${overdueMitigations === 1 ? F.overdueMitigation : F.overdueMitigations}`)}
            </ListLink>
          ) : null}
        </p>
      ) : null}
      {data.nothingRecorded
        ? <p>{QUESTION_COPY.stage.nothingRecorded}</p>
        : null}
      {data.changed !== null && data.review !== null ? (
        // W-2: "<review name>: changed since seal N in M questions. [Open review >]"; the banner prints all but the name.
        <div className="stage-route__seal">
          <strong>{QUESTION_COPY.stage.reviewName(data.review.name)}</strong>{' '}
          <StageSealBanner changed={data.changed} reviewHref={`${base}/reviews/${data.review.id}`} />
        </div>
      ) : null}
      <StageQuestionList
        orgSlug={data.orgSlug} orgId={data.orgId} projectId={data.projectId} stage={data.stage} viewerId={data.viewerId}
        rows={page.items} show={show} counts={counts} filters={filters}
        total={data.rows.length} sealNumber={sealNumber} marks={data.marks} scopeAnswer={data.scopeAnswer}
        termTips={routeTermTips([
          // The page's words ahead of the rows, in reading order (fix round 4): a term they use is not first used in a row.
          STAGE_TITLE[data.stage], QUESTION_COPY.stage.topics(moduleGroups(data.rows).map((g) => g.moduleTitle)), ...sealStepTexts(data.sealStep),
          STAGE_LIST_COPY.count(data.rows.length), ...tallyParts(tallyOfRows(data.rows, data.marks)).map((t) => t.words),
          ...(openFindings > 0 ? [F.openFindings] : []), ...(overdueMitigations > 0 ? [F.overdueMitigations] : []),
          ...(data.nothingRecorded ? [QUESTION_COPY.stage.nothingRecorded] : []),
          ...(data.review !== null ? [QUESTION_COPY.stage.reviewName(data.review.name)] : []),
          ...filters.map((f) => f.label),
          // Then each topic's name and count line, and its rows.
          ...moduleGroups(page.items).flatMap((g) => [g.moduleTitle, STAGE_LIST_COPY.summary(g.rows.length, g.noDecision), ...g.rows]),
        ], data.marks, data.scopeAnswer)}
      />
      {page.hasMore ? <ShowMoreLink href={`?show=${show}&shown=${page.nextShown}`} label={QUESTION_COPY.stage.showMore} /> : null}
    </div>
  );
}
