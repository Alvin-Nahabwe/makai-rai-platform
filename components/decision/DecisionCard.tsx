import Link from 'next/link';
import type { ReactElement } from 'react';
import { DecisionForm, type NextQuestion } from '@/components/decision/DecisionForm';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { SavedMark } from '@/components/ui/SavedMark';
import { WITHDRAWAL_CODE_LABELS, deciderLabel } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { formatDay, formatDeclaredDate, formatTime } from '@/lib/format/dates';
import { ReaderZoneTime } from '@/components/decision/ReaderZoneTime';
import { SealMarker } from '@/components/review/SealMarker';
import { QuestionFindingLink } from '@/components/findings/QuestionFindingLink';
import { LocalTime } from '@/components/ui/LocalTime';
import { UI_COPY } from '@/lib/ui/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { canWithdrawVersion } from '@/lib/question/draft';
import type { QuestionPanelData } from '@/lib/question/panel';
import './DecisionCard.css';

const C = QUESTION_COPY.current;

/**
 * The zone "Entered by" is written in: East Africa time, the zone of the platform's teams (coordinator's ruling, T3 item
 * 9), as lane 1's reading card; the card is rendered on the server, whose own zone is the host's. formatTime names it.
 */
const ZONE = 'Africa/Kampala';

/**
 * The corner's saved shape (design finish review m4; the sketch's .saved): Done's filled green disc with its white check,
 * the kit's done geometry (components/ui/StatusMark.tsx SHAPES.done), in classes of its own. It says "saved", not a
 * status, so it is not a status mark (`ui-mark__shape`), which the no-score checks hold to the status rules
 * (e2e/helpers/noScore.ts); DecisionCard.css paints it. Hidden: the words beside it say what it means.
 */
const SAVED_SHAPE = (
  <svg className="decision-card__saved-svg" width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle className="decision-card__saved-disc" cx={12} cy={12} r={9} />
    <path className="decision-card__saved-check" d="M8 12.5l2.7 2.7L16 9.8" fill="none" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

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

  // The corner (lead's ruling D1, the sketch's .fh): one line, the saved shape (Done's mark, the filled green disc with its
  // check: design finish review m4, as the sketch draws it) and "Saved as version N · <saved date>" in the reader's zone;
  // "No decision yet." with no version; the withdrawn line for a withdrawal. Not a live region: it is server-rendered
  // filled, and the save's own status line announces the save.
  const corner = current === null ? <p className="decision-card__none">{C.none}</p>
    : decision === null ? <p className="decision-card__none">{current.withdrawalCode === null ? C.withdrawnNoCode : C.withdrawn(WITHDRAWAL_CODE_LABELS[current.withdrawalCode])}</p>
    : (
      <p className="decision-card__saved">
        <span className="decision-card__saved-shape">{SAVED_SHAPE}</span>
        {DECISION_FORM_COPY.card.savedAs(decision.versionNumber)}<LocalTime at={decision.receivedAt} dateOnly />
      </p>
    );

  // Spec 9.3, after a save: "Entered by" and "Decided by" both shown, and "History: n versions"; spec 7.3's dates and its
  // line on the platform. All quiet, at the card's foot (D1). The saved time is the reader's (spec 7.3) and "Entered by" is
  // East Africa time (T3 item 9): both name their zone, so for a reader elsewhere the two never read as a contradiction.
  const decider = decision?.decidedBy == null ? null : C.decidedBy(deciderLabel(decision.decidedBy, '', 'record'), null);
  const enterer = decision === null ? null : (decision.enteredBy.formerMember ? C.formerMember(decision.enteredBy.name) : decision.enteredBy.name);

  return (
    <section data-region="answer-form" aria-labelledby="s12-answer-form" className="decision-card">
      <div className="decision-card__head">
        <h2 id="s12-answer-form">{DECISION_FORM_COPY.card.heading}</h2>
        <div className="decision-card__corner">{corner}</div>
      </div>
      {/* A phone (spec 7.3: the most visible thing after the question): the whole saved mark, first in the card. */}
      {decision === null ? null : (
        <div className="decision-card__saved-block">
          <SavedMark saved={{ version: decision.versionNumber, savedAt: decision.receivedAt, decidedOn: decision.declaredDate }} historyHref={historyHref} live={false}
            savedTime={<ReaderZoneTime at={decision.receivedAt} />} />
        </div>
      )}
      <DecisionForm key={`${data.projectId}:${data.question.id}`} data={data} nextQuestion={next} stageHref={stageHref} />
      {current === null ? null : (
        <div className="decision-card__meta">
          {/* The current version's seal markers (T3 item 7; plan 1C Task 6, as the old "Current decision" summary showed
              them), in the foot, below the Save row: they cost the first view no height. Lane 6's `defineTerms` is wired
              after its merge. */}
          <SealMarker seals={data.seals} />
          {decision === null ? null : (
            <div className="decision-card__saved-lines">
              <p>
                {decision.declaredDate === null ? null : `${S.decidedOn} ${formatDeclaredDate(decision.declaredDate)} \u00b7 `}
                {`${S.savedAt} `}<ReaderZoneTime at={decision.receivedAt} />
              </p>
              <p>
                {S.onPlatform}
                {decision.versionNumber > 1 ? <>{` ${S.keptBefore(decision.versionNumber - 1)}`}<Link href={historyHref}>{S.keptLink}</Link>.</> : null}
              </p>
            </div>
          )}
          {enterer === null ? null : (
            <p>{decider === null ? null : `${decider} `}{DECISION_FORM_COPY.card.enteredBy(enterer)}<time dateTime={decision!.receivedAt}>{`${formatDay(decision!.receivedAt, ZONE)}, ${formatTime(decision!.receivedAt, ZONE)}`}</time>.</p>
          )}
          <p><Link href={historyHref}>{QUESTION_COPY.reading.history(data.historyCount)}</Link></p>
          {/* Spec 9.3, after a save (coordinator, T3b item 8): the quiet way to raise a finding about this question, the page's
              own control (same target, same permission, the version it is about), without its open-finding line, which the
              page shows elsewhere. Below the Save row: it costs the first view nothing. */}
          {decision === null || !data.canRaiseFinding ? null : (
            <div className="decision-card__raise">
              <QuestionFindingLink orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={data.question.id}
                currentVersionId={decision.id} openFinding={null} canRaise={data.canRaiseFinding} />
            </div>
          )}
        </div>
      )}
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
