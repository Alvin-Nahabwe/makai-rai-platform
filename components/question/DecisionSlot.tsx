import type { ReactElement } from 'react';
import type { QuestionPanelData } from '@/lib/question/panel';
import { CurrentDecision } from '@/components/decision/CurrentDecision';
import { DecisionForm } from '@/components/decision/DecisionForm';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { canWithdrawVersion } from '@/lib/question/draft';
import { QUESTION_COPY } from '@/lib/question/copy';
import { WayOn } from '@/components/question/WayOn';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';

const Q = QUESTION_COPY;

/**
 * What the decision card is given (coordinator's ruling of 15 November 2026, lane 2 accepted at 10:00): EXACTLY the props
 * of lane 2's `DecisionCard` in components/decision/DecisionCard.tsx. `next` is the next question that applies (the
 * panel's `position.nextId`), with its running words, its address, its 1-based place in the stage counted as
 * `position.index` counts (every question of the stage, switched off or not) and the stage's total; null on the last.
 */
export type DecisionSlotProps = {
  data: QuestionPanelData;
  next: { questionId: string; text: string; href: string; number: number; total: number } | null;
  stageHref: string;
  openFindingsOnQuestion: number;
};

/**
 * The seam between the question page's frame (lane 1) and the decision card (lane 2). The page renders the decision
 * through this slot and nothing else, so the frame never holds the decision's own parts.
 *
 * STUB. Until lane 2's card merges, this body is what the page rendered for a person who may record before the Route
 * rebuild: the current decision, the answer form with WithdrawDecision under it, the finding link (the open finding or
 * "Raise a finding about this question"; coordinator's ruling on review S1a-4: it moved here from the guidance column,
 * and lane 2's card carries it after a save), and the way on to the next question. The card replaces all of it.
 * At the merge the whole body below becomes ONE line:
 *     return <DecisionCard {...props} />;
 * (with `import { DecisionCard } from '@/components/decision/DecisionCard';`), and the imports this stub alone uses go.
 * For a reader (`!data.canWrite`) it renders nothing, as the card will: the page shows the reading view instead.
 */
export function DecisionSlot(props: DecisionSlotProps): ReactElement | null {
  const { data, next, stageHref } = props;
  if (!data.canWrite) return null;
  const question = data.question;
  const historyHref = `${stageHref}/questions/${question.id}/history`;
  return (
    <div className="decision-slot" data-region="decision-slot">
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
      <section className="decision-slot__controls" data-region="answer-form" aria-labelledby="s12-answer-form">
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
      {data.openFinding !== null || data.canRaiseFinding ? (
        <section data-region="finding-link" aria-labelledby="s12-finding-link">
          <h2 id="s12-finding-link">{Q.headings.findings}</h2>
          <QuestionFindingLink orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={question.id}
            currentVersionId={data.current?.id ?? null} openFinding={data.openFinding} canRaise={data.canRaiseFinding} />
        </section>
      ) : null}
      <WayOn next={next} stageHref={stageHref} />
    </div>
  );
}
