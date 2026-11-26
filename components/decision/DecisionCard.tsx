import type { ReactElement } from 'react';
import { CardEntryNames, DecisionForm, type NextQuestion } from '@/components/decision/DecisionForm';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { SavedMark, SavedShape } from '@/components/ui/SavedMark';
import { WITHDRAWAL_CODE_LABELS } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { ReaderZoneTime } from '@/components/decision/ReaderZoneTime';
import { SealMarker } from '@/components/review/SealMarker';
import { HeldFindingLink, HeldLink } from '@/components/decision/SaveHeld';
import { PLATFORM_ZONE } from '@/components/decision/zone';
import { platformOrigin } from '@/components/evidence/VersionEvidenceList';
import { UI_COPY } from '@/lib/ui/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { canWithdrawVersion } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import './DecisionCard.css';

const C = QUESTION_COPY.current;

/** The corner's saved shape, 16 px; the phone's saved block draws the same shape at 24 px (design N4). */
const SAVED_SHAPE = <SavedShape size={16} />;

export type DecisionCardProps = {
  data: QuestionPanelData;
  /** The next question that applies in this stage; null on the stage's last question. */
  next: NextQuestion | null;
  stageHref: string;
  /**
   * All open findings on this question, of any source (the seam's prop, kept). No sentence of the card counts them today:
   * the line on what this save will do reads the question's open shortfall finding, `data.openFinding`, the one a save
   * acts on (coordinator's seam ruling, review round 1).
   */
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
export function DecisionCard({ data, next, stageHref }: DecisionCardProps): ReactElement | null {
  if (!data.canWrite) return null;
  const current = data.current;
  const historyHref = `/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}/questions/${data.question.id}/history`;
  const decision = current !== null && current.status !== 'withdrawn' ? current : null;
  const S = UI_COPY.saved;

  // The corner (lead's ruling D1, the sketch's .fh): one line, the saved shape (SavedShape: a page with a folded corner,
  // its own form, not Done's mark; critique P1 4) and "Saved as version N · <saved date>" in the reader's zone;
  // "No decision yet." with no version; the withdrawn line for a withdrawal. Not a live region: it is server-rendered
  // filled, and the save's own status line announces the save. The date is the reader's and names its zone (review A
  // A3-3), so it never reads as a contradiction of the foot's "Entered by", which is in East Africa time.
  const corner = current === null ? <p className="decision-card__none">{C.none}</p>
    : decision === null ? <p className="decision-card__none">{current.withdrawalCode === null ? C.withdrawnNoCode : C.withdrawn(WITHDRAWAL_CODE_LABELS[current.withdrawalCode])}</p>
    : (
      <p className="decision-card__saved">
        <span className="decision-card__saved-shape">{SAVED_SHAPE}</span>
        {DECISION_FORM_COPY.card.savedAs(decision.versionNumber)}<ReaderZoneTime at={decision.receivedAt} dateOnly />
      </p>
    );

  // Spec 9.3, after a save: "Entered by" and "Decided by" both shown, and "History: n versions"; spec 7.3's dates and its
  // line on the platform. All quiet, at the card's foot (D1). The saved time is the reader's (spec 7.3) and "Entered by" is
  // East Africa time (T3 item 9): both name their zone, so for a reader elsewhere the two never read as a contradiction.
  // The line and its time are drawn here; the names before the time are the form's (CardEntryNames), by the name the tab heard
  // last, so the line names each person as the conflict view beside it does.

  // The card's foot, rendered by the form inside its SaveHeldContext (reviews B M-r4-3, A M-1): its History and finding
  // links are text while a Save waits or is out, as Next is, so none of them takes the person away from a Save not yet sent.
  const foot = current === null ? null : (
    <div className="decision-card__meta">
      {/* The current version's seal markers (T3 item 7; plan 1C Task 6), in the foot, below the Save row: they cost the first
          view no height. The card's first seal marker defines "seal" and the stage beside their first use (lane 6, X-5). */}
      <SealMarker seals={data.seals} defineTerms />
      {decision === null ? null : (
        <div className="decision-card__saved-lines">
          <p>
            {decision.declaredDate === null ? null : `${S.decidedOn} ${formatDeclaredDate(decision.declaredDate)} \u00b7 `}
            {`${S.savedAt} `}<ReaderZoneTime at={decision.receivedAt} />
          </p>
          <p>
            {S.onPlatform}
            {decision.versionNumber > 1 ? <>{` ${S.keptBefore(decision.versionNumber - 1)}`}<HeldLink href={historyHref}>{S.keptLink}</HeldLink>.</> : null}
          </p>
        </div>
      )}
      {decision === null ? null : (
        <p><CardEntryNames /><time dateTime={decision.receivedAt}>{`${formatDay(decision.receivedAt, PLATFORM_ZONE)}, ${formatTime(decision.receivedAt, PLATFORM_ZONE)}`}</time>.</p>
      )}
      <p><HeldLink href={historyHref}>{QUESTION_COPY.reading.history(data.historyCount)}</HeldLink></p>
      {/* Spec 9.3 (coordinator, T3b item 8 and T3c item 9): the page's own finding control in the card's foot. "View the
          finding" whenever the question has an open finding; "Raise a finding about this question" after a save (a current
          decision that is not a withdrawal), for a role that may raise, about that version. */}
      <div className="decision-card__raise">
        <HeldFindingLink orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={data.question.id}
          currentVersionId={decision?.id ?? null} openFinding={data.openFinding} canRaise={decision !== null && data.canRaiseFinding} />
      </div>
    </div>
  );

  // A phone (spec 7.3: the most visible thing after the question): the whole saved mark, first in the card. Rendered by the
  // form inside SaveHeldContext, before the form, so its history link is text while a Save waits or is out (A3c-2).
  const savedBlock = decision === null ? null : (
    <div className="decision-card__saved-block">
      <SavedMark saved={{ version: decision.versionNumber, savedAt: decision.receivedAt, decidedOn: decision.declaredDate }} historyHref={historyHref} live={false}
        savedTime={<ReaderZoneTime at={decision.receivedAt} />} historyLink={<HeldLink href={historyHref}>{UI_COPY.saved.keptLink}</HeldLink>}
        shape={<SavedShape size={24} />} />
    </div>
  );

  return (
    <section data-region="answer-form" aria-labelledby="s12-answer-form" className="decision-card">
      <div className="decision-card__head">
        <h2 id="s12-answer-form">{DECISION_FORM_COPY.card.heading}</h2>
        <div className="decision-card__corner">{corner}</div>
      </div>
      <DecisionForm key={`${data.projectId}:${data.question.id}`} data={data} nextQuestion={next} stageHref={stageHref} foot={foot} lead={savedBlock} ownOrigin={platformOrigin()} />
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
