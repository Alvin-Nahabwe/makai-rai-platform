import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError } from '@/lib/data/tenant';
import { loadQuestionPanel, type QuestionPanelData } from '@/lib/question/panel';
import { STAGES, type Stage } from '@/types/record';
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

/** n in the in-page link "Ways teams address this (n)": SUG's `suggestionCount`. At 0 (the gate) there is no link and no section. */
function countFor(data: QuestionPanelData): number {
  return suggestionCount({ contentSemver: data.contentSemver, questionId: data.question.id, tickedOptions: data.current?.optionsInPlace ?? [] });
}

/**
 * The regions of S-12, in this DOM order: the question, the current decision, the seal note, the answer
 * form with the evidence block inside it, the finding link and the suggestions (contract "The S-12
 * shell"). Each is a `<section>` named by its heading; `finding-link` and `suggestions` come last so that
 * on a narrow screen they follow the form, and the grid puts them beside it on a wide one (W-3).
 *
 * Above them: the page's one `h1`, the question id and module, which takes focus on arrival (UX-42), and
 * Previous and Next over the questions that apply in this stage. The evidence block is rendered by the
 * answer form, a client component, so its callbacks are the form's and no function crosses from this
 * server component to a client one (EVD RE-1). Exported so a unit test renders the markup without the loader.
 */
export function QuestionPanelRegions({ data }: { data: QuestionPanelData }) {
  const question = data.question;
  const count = countFor(data);
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  const reworded = data.current !== null && data.current.status !== 'withdrawn' && isReworded(question, data.runningQuestion);
  const { index, total, previousId, nextId } = data.position;
  return (
    <div className="page-content">
      <ArchivedBanner archived={data.projectArchived} />
      <nav aria-label="Questions in this stage" style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
        {previousId !== null ? <Link href={questionHref(data, previousId)}>Previous question</Link> : null}
        <span>{`Question ${index + 1} of ${total} in ${STAGE_TITLE[data.stage]}`}</span>
        {nextId !== null ? <Link href={questionHref(data, nextId)}>Next question</Link> : null}
        <Link href={`${base}/stages/${data.stage}`}>Back to stage</Link>
      </nav>
      <div style={{ display: 'grid', gap: '1.5rem', alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))' }}>
        <div>
          <section data-region="question" aria-labelledby="s12-question">
            <h1 id="question-heading" tabIndex={-1}>{`${question.id} . ${question.moduleTitle}`}</h1>
            <FocusOnArrival targetId="question-heading" />
            <h2 id="s12-question">Question</h2>
            {/* FR-CNT-08, ruling on SPEC-1: the region shows the running wording, the one a new save re-confirms against; the
                disclosure below holds the wording the current decision was answered against (FR-CNT-07). */}
            <QuestionContent question={data.runningQuestion} suggestionCount={count} />
            {reworded ? (
              <div data-reworded>
                <p>{`Wording updated in content version ${data.contentSemver}.`}</p>
                <details>
                  <summary>See the earlier wording</summary>
                  <p>{question.expectedPractice}</p>
                </details>
              </div>
            ) : null}
          </section>
          <section data-region="current-decision" aria-labelledby="s12-current-decision">
            <h2 id="s12-current-decision">Current decision</h2>
            <CurrentDecision
              orgSlug={data.orgSlug}
              current={data.current}
              historyCount={data.historyCount}
              historyHref={`${base}/stages/${data.stage}/questions/${question.id}/history`}
              seals={data.seals}
            />
          </section>
          <section data-region="seal-note" aria-labelledby="s12-seal-note">
            <h2 id="s12-seal-note">Seals</h2>
            <SealNote seals={data.seals} nextVersionNumber={(data.current?.versionNumber ?? 0) + 1} />
          </section>
          <section data-region="answer-form" aria-labelledby="s12-answer-form">
            <h2 id="s12-answer-form">Record a decision</h2>
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
        </div>
        <div>
          <section data-region="finding-link" aria-labelledby="s12-finding-link">
            <h2 id="s12-finding-link">Findings</h2>
            <QuestionFindingLink
              orgSlug={data.orgSlug}
              projectId={data.projectId}
              stage={data.stage}
              questionId={question.id}
              currentVersionId={data.current?.id ?? null}
              openFinding={data.openFinding}
              canRaise={data.canRaiseFinding}
            />
          </section>
          {count > 0 ? (
            <section data-region="suggestions" id="suggestions" aria-labelledby="s12-suggestions">
              <h2 id="s12-suggestions">Ways teams address this</h2>
              <SuggestedControls
                contentSemver={data.contentSemver}
                questionId={question.id}
                tickedOptions={data.current?.optionsInPlace ?? []}
              />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * S-12, the question panel. The gate is `record:read`, every role's, so this refuses only a person who is
 * not a member (404, ADR-0001); the page and the loader decide what the person may then do. `requireIdentity`
 * and `requireOrgContextFor` are the page pair every `/orgs/[slug]` page uses (the app/(authenticated)/orgs/[slug]/layout.tsx
 * comment says why `requireOrgContext` is for route handlers): an unauthenticated visitor is redirected, not shown an error.
 */
export default async function QuestionPage({
  params,
}: {
  params: Promise<{ slug: string; id: string; stage: string; questionId: string }>;
}) {
  const { slug, id, stage, questionId } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage)) notFound();

  let data: QuestionPanelData;
  try {
    data = await loadQuestionPanel(ctx, identity, { projectId: id, stage: stage as Stage, questionId });
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return <QuestionPanelRegions data={data} />;
}
