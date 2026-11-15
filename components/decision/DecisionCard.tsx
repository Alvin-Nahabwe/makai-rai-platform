import Link from 'next/link';
import type { ReactElement } from 'react';
import { DecisionForm, type NextQuestion } from '@/components/decision/DecisionForm';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { SavedMark } from '@/components/ui/SavedMark';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { formatDay, formatTime } from '@/lib/format/dates';
import { QUESTION_COPY } from '@/lib/question/copy';
import { canWithdrawVersion } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import './DecisionCard.css';

const C = QUESTION_COPY.current;

export type DecisionCardProps = {
  data: QuestionPanelData;
  /** The next question that applies in this stage; null on the stage's last question. */
  next: NextQuestion | null;
  stageHref: string;
  /** Open findings on this question: the input of the line on what this save will do. */
  openFindingsOnQuestion: number;
};

/**
 * "Your decision" (owner's ruling R2, 15 November 2026; the locked sketch's form; spec 7.3 and 9.3): the whole decision
 * section of the question page for a person who may record, as one card. Its header holds the heading and, in the corner,
 * the saved mark of the current version (or "No decision yet.", or the withdrawn line); under it, quietly, who decided, who
 * entered it and the history link. Then the answer form (DecisionForm, the client component that owns every state of the
 * save, the draft and the conflict) with the current answer filled in, the line on what this save will do, Save beside the
 * next question; then More actions with the withdrawal. After a save the card stays open with the new current answer
 * filled in (R2, ruled 15 Nov). Null for a person who may not record: the page shows them the reading view.
 *
 * Not a client component: the page renders it, and a save's router.refresh() renders it again with the new version.
 */
export function DecisionCard({ data, next, stageHref, openFindingsOnQuestion }: DecisionCardProps): ReactElement | null {
  if (!data.canWrite) return null;
  const current = data.current;
  const historyHref = `/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}/questions/${data.question.id}/history`;
  const withdrawn = current !== null && current.status === 'withdrawn';

  // The corner: the saved mark of a decision; the withdrawn line of a withdrawal; "No decision yet." with no version. The
  // mark is not a live region: it is server-rendered filled, and the save's own status line announces the save.
  const corner = current === null ? <p className="decision-card__none">{C.none}</p>
    : withdrawn ? <p className="decision-card__none">{current.withdrawalCode === null ? C.withdrawnNoCode : C.withdrawn(WITHDRAWAL_CODE_LABELS[current.withdrawalCode])}</p>
    : <SavedMark saved={{ version: current.versionNumber, savedAt: current.receivedAt, decidedOn: current.declaredDate }} historyHref={historyHref} live={false} />;

  // Spec 9.3, after a save: "Entered by" and "Decided by" both shown, and "History: n versions". The decided date is in the
  // saved mark ("Decided on ..."), so the decider's line names the person alone.
  const decided = current === null || withdrawn || current.decidedBy === null ? null : C.decidedBy(deciderLabel(current.decidedBy, '', 'record'), null);
  const entered = current === null || withdrawn ? null
    : C.enteredBy(current.enteredBy.formerMember ? C.formerMember(current.enteredBy.name) : current.enteredBy.name, formatDay(current.receivedAt), formatTime(current.receivedAt));

  return (
    <section data-region="answer-form" aria-labelledby="s12-answer-form" className="decision-card">
      <div className="decision-card__head">
        <h2 id="s12-answer-form">{DECISION_FORM_COPY.card.heading}</h2>
        <div className="decision-card__corner">{corner}</div>
      </div>
      {current === null ? null : (
        <div className="decision-card__meta">
          {decided === null && entered === null ? null : <p>{decided === null ? entered : <>{decided} {entered}</>}</p>}
          <p><Link href={historyHref}>{QUESTION_COPY.reading.history(data.historyCount)}</Link></p>
        </div>
      )}
      <DecisionForm key={`${data.projectId}:${data.question.id}`} data={data} next={next} stageHref={stageHref} openFindings={openFindingsOnQuestion} />
      {/* Mounted whenever there is a current version, with the permission as a prop, so after a withdrawal it stays to say
          "Withdrawn..." and to take focus (F12); it shows the More menu only while it can act. */}
      {current !== null ? (
        <div className="decision-card__more">
          <WithdrawDecision
            key={data.question.id} orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={data.question.id}
            current={current} canWithdraw={canWithdrawVersion(data.viewer.role, data.viewer.userId, current, data.projectArchived)} inMoreMenu
          />
        </div>
      ) : null}
    </section>
  );
}
