import { cache, type ReactNode } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadQuestionPanel, type QuestionPanelData } from '@/lib/question/panel';
import { loadQuestionOpenWork, type QuestionOpenWork } from '@/lib/question/openWork';
import { eatDate } from '@/lib/followup/overdue';
import { decisionFormNote } from '@/lib/authz/permissionNotes';
import { OpenWorkList } from '@/components/question/OpenWorkList';
import { STAGES, type Stage } from '@/types/record';
import { questionApplies, runningContent } from '@/lib/content/loader';
import { riskAreasOf } from '@/lib/content/riskAreas';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { QuestionContent } from '@/components/question/QuestionContent';
import { QuestionTopStrip } from '@/components/question/QuestionTopStrip';
import { PositionStrip } from '@/components/question/PositionStrip';
import { DecisionSlot } from '@/components/question/DecisionSlot';
import { HeadingFocusCue } from '@/components/question/HeadingFocusCue';
import { neighbourOf } from '@/components/question/neighbour';
import { WayOn } from '@/components/question/WayOn';
import { CurrentDecision } from '@/components/decision/CurrentDecision';
import { SealNote } from '@/components/review/SealNote';
import { FocusOnArrival } from '@/components/decision/FocusOnArrival';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';
import { SuggestedControls, suggestionCount } from '@/components/suggestions/SuggestedControls';
import { isReworded } from '@/lib/question/reworded';
import { DECISION_COPY } from '@/lib/decision/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import RememberProject from '@/components/layout/RememberProject';
import { RouteColumn } from '@/components/question/RouteColumn';
import { loadStagePage, type StagePageData } from '@/lib/question/stagePage';
import { isStageFilter } from '@/lib/question/stageList';
import '@/components/question/workspace.css';

const Q = QUESTION_COPY;

/** This question's open findings in the stage's list; a list without its row is a defect. */
function openFindingsOf(stage: StagePageData, questionId: string): number {
  const row = stage.rows.find((r) => r.questionId === questionId);
  if (row === undefined) throw new Error(`QuestionPanelRegions: the stage's list has no row for ${questionId}`);
  return row.openFindings;
}

/** n in "Ways teams address this (n)": SUG's `suggestionCount`. At 0 (the personal data question) there is no control and no list. */
function countFor(data: QuestionPanelData): number {
  return suggestionCount({ contentSemver: data.contentSemver, questionId: data.question.id, tickedOptions: data.current?.optionsInPlace ?? [] });
}

/**
 * What a person who may not record reads after the question (plan 1C Task 7, decision C12: a Reviewer, a Viewer, anyone
 * in an archived project): "What the team decided" (CurrentDecision's reading mode), then what is still open on the
 * question (only when something is) and the one line that says why there is no form (none in an archived project, whose
 * banner says it). The seal note follows as for everyone. No form, no evidence controls, no withdraw: no role without
 * `decision:write` holds `decision:withdraw`, and nobody withdraws in an archived project. Lane 1 Task 3 rebuilds their
 * look; here they keep their place in the new grid.
 */
function readingRegions(data: QuestionPanelData, openWork: QuestionOpenWork | null, historyHref: string): ReactNode {
  const note = decisionFormNote(data.viewer.role, data.projectArchived);
  const open = openWork?.findings.length ?? 0;
  return (
    <>
      <section data-region="current-decision" aria-labelledby="s12-current-decision">
        <h2 id="s12-current-decision">{Q.reading.title}</h2>
        <CurrentDecision
          orgSlug={data.orgSlug}
          current={data.current}
          historyCount={data.historyCount}
          historyHref={historyHref}
          seals={data.seals}
          isScopeQuestion={data.question.type === 'gate'}
          mode="reading"
        />
      </section>
      {openWork !== null && open > 0 ? (
        <section data-region="open-work" aria-labelledby="s12-open-work">
          <h2 id="s12-open-work">{Q.reading.stillOpen(open)}</h2>
          <OpenWorkList work={openWork} orgSlug={data.orgSlug} projectId={data.projectId} />
        </section>
      ) : null}
      {note !== null ? <p data-permission-note>{note}</p> : null}
    </>
  );
}

/**
 * The question page's frame (lane 1 Task 1; the Route sketch assigned.html and workspace-phone-saved.html), in this DOM
 * order, which is also the reading order at every width (workspace.css places the columns; nothing is reordered):
 *  1. the archived banner, when the project is archived;
 *  2. the top strip (breadcrumb with the follow-up counts, then the stage's tally), shown from 1160px, and the position
 *     strip (previous, "Question n of N", next), shown under it; both read the stage's data, which is required;
 *  3. the question: the running question's text as the page's one `h1` (FR-CNT-08), which takes focus on arrival (UX-42),
 *     its code line "{Q-ID} · {topic}" after it, the line for a question the personal data answer switched off, and the
 *     earlier-wording disclosure;
 *  4. a reader's reading regions; the seal note (only for a question in a seal); the decision slot (components/question/
 *     DecisionSlot.tsx: lane 2's decision card for a person who may record, nothing for a reader); a reader's way on;
 *  5. the guidance aside (with the risk areas and the folded list of ways teams address this), then the finding link;
 *  6. the route column (`route`).
 * The page itself renders no part of the decision for a person who may record: no "Current decision", no answer form, no
 * withdraw, no way on. Exported so a unit test renders the markup without the loader.
 */
export function QuestionPanelRegions({ data, openWork, route, stage }: {
  data: QuestionPanelData; openWork?: QuestionOpenWork | null; route?: ReactNode; stage: StagePageData;
}) {
  const question = data.question;
  const count = countFor(data);
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  const stageHref = `${base}/stages/${data.stage}`;
  const reworded = data.current !== null && data.current.status !== 'withdrawn' && isReworded(question, data.runningQuestion);
  const { index, total, previousId, nextId } = data.position;
  const historyHref = `${stageHref}/questions/${question.id}/history`;
  const doesNotApply = data.gateAnswer === 'no' && !questionApplies(runningContent(), data.runningQuestion.id, data.gateAnswer);
  const next = nextId === null ? null : neighbourOf(data, nextId);
  const previous = previousId === null ? null : neighbourOf(data, previousId);
  // This question's row of the stage list: its open findings, for the decision card's sentence. A stage list that lacks
  // this question is a defect, said by name, never "nothing open".
  const openFindingsOnQuestion = openFindingsOf(stage, question.id);
  // The Findings section: for a person who may record, when there is an open finding to view or they may raise one; for
  // a reader, only when they may raise one (R4), since the reader's open findings are listed in the main column.
  const showFindings = data.canWrite ? data.openFinding !== null || data.canRaiseFinding : data.canRaiseFinding;
  // Only a question in a seal has something to say here: SealNote renders nothing for one in none.
  const sealNote = data.seals.length > 0 ? (
    <section data-region="seal-note" aria-labelledby="s12-seal-note">
      <h2 id="s12-seal-note">{Q.headings.seals}</h2>
      <SealNote seals={data.seals} nextVersionNumber={(data.current?.versionNumber ?? 0) + 1} />
    </section>
  ) : null;
  return (
    <div className="question-page">
      <ArchivedBanner archived={data.projectArchived} />
      <QuestionTopStrip stage={stage} n={index + 1} total={total} />
      <PositionStrip previous={previous} next={next} n={index + 1} total={total} marks={stage.marks} currentId={question.id} scopeAnswer={stage.scopeAnswer} />
      <div className="question-workspace">
        <div className="question-workspace__main">
          <section data-region="question" aria-labelledby="question-heading">
            <h1 id="question-heading" tabIndex={-1} className="question-frame__title">{data.runningQuestion.text}</h1>
            <HeadingFocusCue headingId="question-heading" />
            <FocusOnArrival targetId="question-heading" />
            <p className="question-frame__code">{DECISION_COPY.titles.question(question.id, question.moduleTitle)}</p>
            {doesNotApply ? <p data-does-not-apply>{Q.doesNotApply}</p> : null}
            {/* FR-CNT-07: the disclosure holds the wording the current decision was answered against. */}
            {reworded ? (
              <div data-reworded>
                <p>{Q.reworded.line}</p>
                <details>
                  <summary>{Q.reworded.summary}</summary>
                  <p>{question.expectedPractice}</p>
                </details>
              </div>
            ) : null}
          </section>
          {data.canWrite ? null : readingRegions(data, openWork ?? null, historyHref)}
          {sealNote}
          <DecisionSlot data={data} next={next} stageHref={stageHref} openFindingsOnQuestion={openFindingsOnQuestion} />
          {/* A reader's way on (the decision card holds the writer's). */}
          {data.canWrite ? null : <WayOn next={next} stageHref={stageHref} />}
        </div>
        <div className="question-workspace__guide">
          {/* The guidance of the running wording (FR-CNT-08, ruling on SPEC-1), as an aside; the list opens inside it. */}
          <QuestionContent question={data.runningQuestion} suggestionCount={count} riskAreas={riskAreasOf(data.runningQuestion, runningContent())}>
            {count > 0 ? (
              <SuggestedControls contentSemver={data.contentSemver} questionId={question.id} tickedOptions={data.current?.optionsInPlace ?? []} />
            ) : null}
          </QuestionContent>
          {/* Exactly when QuestionFindingLink renders something, so no heading stands over nothing. A reader's open findings are
              in "Still open on this question", so here the reader gets only the raise link (review M2), not the same finding twice. */}
          {showFindings ? (
            <section data-region="finding-link" aria-labelledby="s12-finding-link">
              <h2 id="s12-finding-link">{Q.headings.findings}</h2>
              <QuestionFindingLink
                orgSlug={data.orgSlug}
                projectId={data.projectId}
                stage={data.stage}
                questionId={question.id}
                currentVersionId={data.current?.id ?? null}
                openFinding={data.canWrite ? data.openFinding : null}
                canRaise={data.canRaiseFinding}
              />
            </section>
          ) : null}
        </div>
        {/* The stage's questions (RouteColumn), last in the DOM at every width; workspace.css places it. */}
        {route === undefined ? null : <div className="question-workspace__route">{route}</div>}
      </div>
    </div>
  );
}

type Params = Promise<{ slug: string; id: string; stage: string; questionId: string }>;

/**
 * The gates and the loader, once per request: the page and its title both read through this (React `cache()`), so an
 * unknown stage, question or project is the same `notFound()` for both and the title names nothing.
 */
const gate = cache(async (slug: string, stage: string) => {
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage)) notFound();
  return { identity, ctx };
});

const load = cache(async (slug: string, id: string, stage: string, questionId: string) => {
  const { identity, ctx } = await gate(slug, stage);

  try {
    const panel = await loadQuestionPanel(ctx, identity, { projectId: id, stage: stage as Stage, questionId });
    // Only a reader sees what is still open (plan 1C Task 7, R1): read after the panel, which has already refused another
    // organisation's project or a question outside the stage.
    const openWork = panel.canWrite ? null
      : await loadQuestionOpenWork(ctx, { projectId: id, stage: stage as Stage, questionId, today: eatDate(new Date()) });
    return { panel, openWork };
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
});

/** The question's own heading, then the project. */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug, id, stage, questionId } = await params;
  const { panel: data } = await orNotFound(load(slug, id, stage, questionId));
  return { title: pageTitle(DECISION_COPY.titles.question(data.question.id, data.question.moduleTitle), data.projectName) };
}

/**
 * S-12, the question panel. The gate is `record:read`, every role's, so this refuses only a person who is
 * not a member (404, ADR-0001); the page and the loader decide what the person may then do. `requireIdentity`
 * and `requireOrgContextFor` are the page pair every `/orgs/[slug]` page uses (the app/(authenticated)/orgs/[slug]/layout.tsx
 * comment says why `requireOrgContext` is for route handlers): an unauthenticated visitor is redirected, not shown an error.
 */
export default async function QuestionPage({
  params, searchParams,
}: {
  params: Params;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug, id, stage, questionId } = await params;
  const sp = await searchParams;
  const show = isStageFilter(sp.show) ? sp.show : 'all';
  // The gate first (load reads the same one, cache()); then the stage's list for the column, with that context and
  // identity, in parallel with the panel; the panel and the open work come from that one call.
  const { identity, ctx } = await gate(slug, stage);
  const stagePage = loadStagePage(ctx, identity.userId, id, stage as Stage);
  // Observed at once: if the panel refuses (notFound) the page never awaits the list, and its failure must not escape
  // as an unhandled rejection. The await below still sees a failure when the panel loads.
  stagePage.catch(() => {});
  const { panel, openWork } = await load(slug, id, stage, questionId);
  const stageData = await stagePage;
  // The project's name is for the title only; the regions (and the client form inside them) get the panel as before.
  const { projectName: _projectName, ...data } = panel;
  // The project and stage the panel just found: the stage's load answers null only for a project it cannot see, which the
  // panel has already refused (notFound). A null here is a defect, not a page to show without its strips.
  if (stageData === null) throw new Error(`QuestionPage: the stage list of ${stage} was not found for a project the panel found`);
  const route = <RouteColumn data={stageData} currentQuestionId={data.question.id} nextQuestionId={data.position.nextId} show={show} />;
  return (
    <>
      <QuestionPanelRegions data={data} openWork={openWork} route={route} stage={stageData} />
      <RememberProject userId={data.viewer.userId} orgSlug={slug} projectId={data.projectId} />
    </>
  );
}
