import Link from 'next/link';
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
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { QuestionContent } from '@/components/question/QuestionContent';
import { CurrentDecision } from '@/components/decision/CurrentDecision';
import { SealNote } from '@/components/review/SealNote';
import { DecisionForm } from '@/components/decision/DecisionForm';
import { FocusOnArrival } from '@/components/decision/FocusOnArrival';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';
import { SuggestedControls, suggestionCount } from '@/components/suggestions/SuggestedControls';
import { isReworded } from '@/lib/question/reworded';
import { STAGE_TITLE } from '@/lib/question/stageList';
import { canWithdrawVersion, questionHref } from '@/lib/question/draft';
import { DECISION_COPY } from '@/lib/decision/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { orNotFound } from '@/lib/auth/titleGate';
import { pageTitle } from '@/lib/ui/title';
import RememberProject from '@/components/layout/RememberProject';
import { RouteColumn } from '@/components/question/RouteColumn';
import { loadStagePage } from '@/lib/question/stagePage';
import { isStageFilter } from '@/lib/question/stageList';
import '@/components/question/workspace.css';

const Q = QUESTION_COPY;

/**
 * The running text of the question the foot's "Next question" names. The panel took `nextId` from this same running
 * content, so an id it lacks is a defect, not a question to skip.
 */
function nextQuestionText(nextId: string): string {
  const next = runningContent().questions.get(nextId);
  if (next === undefined) throw new Error(`QuestionPanelRegions: the next question ${nextId} is not in the running content`);
  return next.text;
}

/** n in the in-page link "Ways teams address this (n)": SUG's `suggestionCount`. At 0 (the gate) there is no link and no section. */
function countFor(data: QuestionPanelData): number {
  return suggestionCount({ contentSemver: data.contentSemver, questionId: data.question.id, tickedOptions: data.current?.optionsInPlace ?? [] });
}

/**
 * What a person who may not record reads after the question (plan 1C Task 7, decision C12: a Reviewer, a Viewer, anyone
 * in an archived project): "What the team decided" (CurrentDecision's reading mode), then what is still open on the
 * question (only when something is) and the one line that says why there is no form (none in an archived project, whose
 * banner says it). The seal note follows as for everyone. No form, no evidence controls, no withdraw: no role without
 * `decision:write` holds `decision:withdraw`, and nobody withdraws in an archived project.
 */
function readingRegions(data: QuestionPanelData, openWork: QuestionOpenWork | null, historyHref: string) {
  const note = decisionFormNote(data.viewer.role, data.projectArchived);
  const open = openWork?.findings.length ?? 0;
  return {
    decision: (
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
    ),
    openWorkAndNote: (
      <>
        {openWork !== null && open > 0 ? (
          <section data-region="open-work" aria-labelledby="s12-open-work">
            <h2 id="s12-open-work">{Q.reading.stillOpen(open)}</h2>
            <OpenWorkList work={openWork} orgSlug={data.orgSlug} projectId={data.projectId} />
          </section>
        ) : null}
        {note !== null ? <p data-permission-note>{note}</p> : null}
      </>
    ),
  };
}

/**
 * The regions of S-12, in this DOM order (plan 1C decision C1, cut to slice 1): the question, the current decision,
 * the seal note (only for a question in a seal), the answer form with the evidence block inside it, then the
 * guidance aside, the finding link and the suggestions. Each region is named by its heading. workspace.css puts the
 * guidance column to the right of the form once the main column can keep 30rem beside it, and below it, in this
 * order, before that; nothing is reordered by CSS.
 *
 * The page's one `h1` is the running question's text (FR-CNT-08: the wording a new save re-confirms against), which
 * takes focus on arrival (UX-42); the code line "{Q-ID} · {module}" (the page title's own words) follows it in small
 * type. Above them, the strip: Previous and Next over the questions that apply in this stage, and All questions. The
 * evidence block is rendered by the answer form, a client component, so its callbacks are the form's and no function
 * crosses from this server component to a client one (EVD RE-1). Exported so a unit test renders the markup without
 * the loader.
 *
 * A question the personal data answer switched off (FR-CNT-04) says so under its code line; its form is unchanged. At
 * the foot of the main column, after the form, the way on: "Next question: {its words}" (or, on the stage's last
 * question, a sentence saying so) and All questions (workshop walk S3, S9). The Findings section is there only when it
 * has something to show: an open finding, or a person who may raise one.
 */
export function QuestionPanelRegions({ data, openWork, route }: { data: QuestionPanelData; openWork?: QuestionOpenWork | null; route?: ReactNode }) {
  const question = data.question;
  const count = countFor(data);
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  const reworded = data.current !== null && data.current.status !== 'withdrawn' && isReworded(question, data.runningQuestion);
  const { index, total, previousId, nextId } = data.position;
  const historyHref = `${base}/stages/${data.stage}/questions/${question.id}/history`;
  const stageHref = `${base}/stages/${data.stage}`;
  const doesNotApply = data.gateAnswer === 'no' && !questionApplies(runningContent(), data.runningQuestion.id, data.gateAnswer);
  // The Findings section: for a person who may record, when there is an open finding to view or they may raise one; for
  // a reader, only when they may raise one (R4), since the reader's open findings are listed in the main column.
  const showFindings = data.canWrite ? data.openFinding !== null || data.canRaiseFinding : data.canRaiseFinding;
  const reading = data.canWrite ? null : readingRegions(data, openWork ?? null, historyHref);
  // Only a question in a seal has something to say here: SealNote renders nothing for one in none.
  const sealNote = data.seals.length > 0 ? (
    <section data-region="seal-note" aria-labelledby="s12-seal-note">
      <h2 id="s12-seal-note">{Q.headings.seals}</h2>
      <SealNote seals={data.seals} nextVersionNumber={(data.current?.versionNumber ?? 0) + 1} />
    </section>
  ) : null;
  return (
    <div className="page-content">
      <ArchivedBanner archived={data.projectArchived} />
      <nav aria-label={Q.nav.label} className="question-strip">
        {previousId !== null ? <Link href={questionHref(data, previousId)}>{Q.nav.previous}</Link> : null}
        <span>{Q.nav.position(index + 1, total, STAGE_TITLE[data.stage])}</span>
        {nextId !== null ? <Link href={questionHref(data, nextId)}>{Q.nav.next}</Link> : null}
        <Link href={stageHref}>{Q.nav.allQuestions}</Link>
      </nav>
      <div className="question-workspace">
        <div className="question-workspace__main">
          <section data-region="question" aria-labelledby="question-heading">
            <h1 id="question-heading" tabIndex={-1} className="question-frame__title">{data.runningQuestion.text}</h1>
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
          {/* A person who may record sees the regions as before; a reader, the reading regions (R4). The main column keeps
              four children in both, each in the writer's place, so React's ids inside the form (useId) stay as they were. */}
          {reading === null ? (
            <section data-region="current-decision" aria-labelledby="s12-current-decision">
              <h2 id="s12-current-decision">{Q.headings.current}</h2>
              <CurrentDecision
                orgSlug={data.orgSlug}
                current={data.current}
                historyCount={data.historyCount}
                historyHref={historyHref}
                seals={data.seals}
                isScopeQuestion={question.type === 'gate'}
              />
            </section>
          ) : reading.decision}
          {reading === null ? sealNote : reading.openWorkAndNote}
          {reading === null ? (
            <section data-region="answer-form" aria-labelledby="s12-answer-form">
              <h2 id="s12-answer-form">{Q.headings.record}</h2>
              <DecisionForm key={`${data.projectId}:${question.id}`} data={data} />
              {/* Mounted whenever there is a current version, with the permission as a prop, so after a withdrawal it stays to
                  say "Withdrawn..." and to take focus (F12); it shows the More menu only while it can act. */}
              {data.current !== null ? (
                <WithdrawDecision
                  key={question.id} orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={question.id}
                  current={data.current} canWithdraw={canWithdrawVersion(data.viewer.role, data.viewer.userId, data.current, data.projectArchived)} inMoreMenu
                />
              ) : null}
            </section>
          ) : sealNote}
          {/* The way on after a save at the foot of a long page (workshop walk S9): a paragraph, so the page keeps one navigation landmark. */}
          <p className="question-foot" data-region="way-on">
            {nextId !== null
              ? <Link href={questionHref(data, nextId)}>{Q.foot.next(nextQuestionText(nextId))}</Link>
              : <span>{Q.foot.last}</span>}
            <Link href={stageHref}>{Q.nav.allQuestions}</Link>
          </p>
        </div>
        <div className="question-workspace__guide">
          {/* The guidance of the running wording (FR-CNT-08, ruling on SPEC-1), as an aside (plan 1C decision C1, cut). */}
          <QuestionContent question={data.runningQuestion} suggestionCount={count} />
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
                openFinding={reading === null ? data.openFinding : null}
                canRaise={data.canRaiseFinding}
              />
            </section>
          ) : null}
          {count > 0 ? (
            <section data-region="suggestions" id="suggestions" aria-labelledby="s12-suggestions">
              <h2 id="s12-suggestions">{Q.headings.suggestions}</h2>
              <SuggestedControls
                contentSemver={data.contentSemver}
                questionId={question.id}
                tickedOptions={data.current?.optionsInPlace ?? []}
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
  const { panel, openWork } = await load(slug, id, stage, questionId);
  const stageData = await stagePage;
  // The project's name is for the title only; the regions (and the client form inside them) get the panel as before.
  const { projectName: _projectName, ...data } = panel;
  // The project and stage the panel just found: null only where the panel's own load has already refused (notFound).
  const route = stageData === null ? undefined : <RouteColumn data={stageData} currentQuestionId={data.question.id} show={show} />;
  return (
    <>
      <QuestionPanelRegions data={data} openWork={openWork} route={route} />
      <RememberProject userId={data.viewer.userId} orgSlug={slug} projectId={data.projectId} />
    </>
  );
}
