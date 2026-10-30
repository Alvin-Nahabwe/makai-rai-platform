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
import { EvidenceBlock } from '@/components/evidence/EvidenceBlock';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';
import { SuggestedControls } from '@/components/suggestions/SuggestedControls';

const noop = () => {};

/**
 * The regions of S-12, in this DOM order: the question, the current decision, the seal note, the answer
 * form with the evidence block inside it, the finding link and the suggestions (contract "The S-12
 * shell"). Each is a `<section>` named by its heading; `finding-link` and `suggestions` come last so that
 * on a narrow screen they follow the form, and the grid puts them beside it on a wide one (W-3).
 *
 * Exported so a unit test renders the markup without the loader. Every region's component is a slot its
 * contributor fills; DEC-b owns this page after K0b and may move the evidence block into the form's own
 * client tree, where its callbacks belong: the no-op callbacks here only satisfy the props until then.
 */
export function QuestionPanelRegions({ data }: { data: QuestionPanelData }) {
  const question = data.question;
  const base = `/orgs/${data.orgSlug}/projects/${data.projectId}`;
  return (
    <div className="page-content">
      <ArchivedBanner archived={data.projectArchived} />
      <div style={{ display: 'grid', gap: '1.5rem', alignItems: 'start', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))' }}>
        <div>
          <section data-region="question" aria-labelledby="s12-question">
            <h2 id="s12-question">Question</h2>
            {/* The total of SUG's controlsForQuestion belongs to the page's owner; 0 until DEC-b passes it. */}
            <QuestionContent question={question} suggestionCount={0} />
          </section>
          <section data-region="current-decision" aria-labelledby="s12-current-decision">
            <h2 id="s12-current-decision">Current decision</h2>
            <CurrentDecision
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
            <DecisionForm data={data} />
            <section data-region="evidence-block" aria-labelledby="s12-evidence">
              <h3 id="s12-evidence">Evidence</h3>
              <EvidenceBlock
                orgSlug={data.orgSlug}
                projectId={data.projectId}
                initial={data.current?.evidence ?? []}
                disabled={!data.canWrite || data.projectArchived}
                onChange={noop}
                onUploadState={noop}
              />
            </section>
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
          <section data-region="suggestions" id="suggestions" aria-labelledby="s12-suggestions">
            <h2 id="s12-suggestions">Ways teams address this</h2>
            <SuggestedControls
              contentSemver={data.contentSemver}
              questionId={question.id}
              tickedOptions={data.current?.optionsInPlace ?? []}
            />
          </section>
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
