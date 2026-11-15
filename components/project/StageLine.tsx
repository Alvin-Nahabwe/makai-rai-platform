import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { FollowUpItem, StageCounts, StageReviewView } from '@/types/api';
import type { Stage } from '@/types/record';
import { ListLink } from '@/components/ui/ListLink';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { ItemPlate } from '@/components/ui/ItemPlate';
import { RouteTally, type DefinedTallyKind } from '@/components/ui/RouteRow';
import { Definition, Term } from '@/components/ui/Definition';
import { TermTip } from '@/components/ui/TermTip';
import { STATUS_WORD } from '@/components/followup/StageFollowUp';
import { DeviceDateTime } from '@/components/review/DeviceTime';
import { plural } from '@/components/project/StageColumn';
import { hasOpenWork, sealDamaged, type FirstUses } from '@/components/project/firstUse';
import { compareFollowUp } from '@/lib/followup/rules';
import { formatDay } from '@/lib/format/dates';
import { PROJECT_COPY } from '@/lib/project/copy';
import { REVIEW_COPY } from '@/lib/review/copy';
import { positionWords } from '@/lib/ui/copy';
import type { StageRoute } from '@/lib/project/routes';
import type { ContinueTarget } from '@/lib/home/types';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import {
  TERM_ACCEPTED_RISK, TERM_DOES_NOT_APPLY, TERM_DONE, TERM_FINDING, TERM_MITIGATION, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY,
  TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3, TERM_STAGE_REVIEW,
} from '@/lib/vocabulary/terms';

const P = PROJECT_COPY;
const C = PROJECT_COPY.stage;
const F = PROJECT_COPY.followUp;
const SEP = ' · ';

/** Each stage's plain meaning, the vocabulary's sentence (decision D1, X-5), shown under its name. */
const STAGE_TERM: Readonly<Record<Stage, DefinedEntry>> = { 'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3 };

/** The status words a tally may define, with the term whose name the (i) button says. */
const STATUS_TERM: Readonly<Record<DefinedTallyKind, DefinedEntry>> = {
  done: TERM_DONE, partly: TERM_PARTLY, not_yet: TERM_NOT_YET, not_applicable: TERM_NOT_APPLICABLE, does_not_apply: TERM_DOES_NOT_APPLY,
};

/** `children` marked as the first use of `term` when `first`, else as they are. */
const used = (first: boolean, term: DefinedEntry, children: ReactNode): ReactNode => (first ? <Term of={term}>{children}</Term> : children);
/** The term's definition one step away, as the (i) toggletip right after its first use (owner's ruling of 15 Nov 2026, 21:32), or nothing. */
const defined = (first: boolean, term: DefinedEntry): ReactNode => (first ? <TermTip of={term} label={P.whatMeans(term.term)} /> : null);
/** A stage's question list (S-11). */
const stagePath = (base: string, stage: Stage): string => `${base}/stages/${stage}`;

export type StageLineProps = {
  stage: Stage; base: string; counts: StageCounts; route: StageRoute;
  followUp: { items: FollowUpItem[]; cannotAct: FollowUpItem[] }; reviews: readonly StageReviewView[];
  canOpenReview: boolean; uses: FirstUses;
  /** The page's one primary action when it continues THIS stage (plan 1C C11); null on every other line. */
  primary: ContinueTarget | null;
};

/**
 * One stage of S-10 as a vertical line of stops (Route R5; spec 9.2; the sketch `surfaces/project.png`): exactly five
 * stops, always, so the three lines' stops share rows (a subgrid, ProjectPage.css): the stage (with the next step and the
 * page's primary action on the line the page continues), what is still open, what is recorded so far, its reviews, and the
 * last stop with what is left and the link to the stage's questions. Counts are
 * words and numerals of this stage alone; no percentage, bar or total across stages (FR-RM-04).
 *
 * Where a defined term is first used is decided by components/project/firstUse.ts, which mirrors the order and the words
 * of these stops: when a stop's words change here, update firstUse.ts with them.
 */
export function StageLine(p: StageLineProps): ReactElement {
  const headingId = `${p.stage}-name`;
  const name = P.stageNames[p.stage];
  return (
    <section className="stage-line" id={p.stage} data-stage={p.stage} aria-labelledby={headingId}>
      <div className="stage-line__stop stage-line__stop--head">
        <h2 id={headingId}><Term of={STAGE_TERM[p.stage]}>{name}</Term></h2>
        <Definition of={STAGE_TERM[p.stage]} as="p" />
        <p className="stage-line__count">{plural(p.counts.questions, C.question, C.questions)}</p>
        {/* Owner's ruling on C3 (option A): on the line the page continues, the next step and the one primary action sit in
            the head stop, inside the first view. Hidden while the lines are stacked: ProjectPage shows the same block once
            above them then, so exactly one primary is in the accessibility tree at any width (ProjectPage.css). */}
        {p.primary !== null ? <NextStep target={p.primary} base={p.base} route={p.route} counts={p.counts} where="line" /> : null}
      </div>
      <StillOpen {...p} />
      <div className="stage-line__stop stage-line__stop--recorded">
        <h3>{C.recorded}</h3>
        {/* What is recorded, as the tally in words with the kit's mark beside each count; no row of marks per question (owner's
            ruling of 15 Nov 2026 20:50, the sketch's counts). The no-decision questions are still open, so the tally leaves
            them out ("No decisions recorded yet", FR-PRJ-02); Still open counts them and links to them. */}
        <div className="ui-route-row">
          <RouteTally tally={{ ...p.route.tally, no_decision: undefined }} define={tallyDefinitions(p.uses, p.stage)} />
        </div>
        {p.counts.acceptedRisks + p.counts.documentsIssued > 0 ? (
          <p>
            {used(p.uses.acceptedRisk === p.stage, TERM_ACCEPTED_RISK, C.issued(plural(p.counts.acceptedRisks, C.acceptedRisk, C.acceptedRisks), plural(p.counts.documentsIssued, C.document, C.documents)))}
            {defined(p.uses.acceptedRisk === p.stage, TERM_ACCEPTED_RISK)}
          </p>
        ) : null}
      </div>
      <Reviews {...p} />
      <LastStop {...p} headingId={headingId} />
    </section>
  );
}

/** The (i) labels for the status words whose first use on the page is this stage's tally (components/project/firstUse.ts). */
function tallyDefinitions(uses: FirstUses, stage: Stage): Partial<Record<DefinedTallyKind, string>> {
  const out: Partial<Record<DefinedTallyKind, string>> = {};
  for (const [kind, at] of Object.entries(uses.statusWords) as Array<[DefinedTallyKind, Stage]>) {
    if (at === stage) out[kind] = P.whatMeans(STATUS_TERM[kind].term);
  }
  return out;
}

/**
 * "Still open in this stage": the count of questions with no decision, open findings, the overdue mitigations (or that none
 * is overdue), then how many other open mitigations the stage has.
 */
function StillOpen(p: StageLineProps): ReactElement {
  const c = p.counts;
  const stageHref = stagePath(p.base, p.stage);
  // FR-FUP-01's order (overdue first, then due date). The two lists are disjoint: lib/data/projects.ts splits one by ownerCanAct.
  const all = [...p.followUp.items, ...p.followUp.cannotAct].sort(compareFollowUp);
  const overdue = all.filter((i) => i.overdue);
  // The rest of the stage's open mitigations, one line to the Findings page, where each is listed and can be reassigned
  // (owner's ruling of 15 Nov 2026 20:50; a departure from FR-FUP-01/05's list on S-10, which the owner made).
  const others = all.length - overdue.length;
  const m = p.uses.mitigation?.stage === p.stage ? p.uses.mitigation.at : null;
  const findingFirst = p.uses.finding !== null && p.uses.finding.stage === p.stage;
  return (
    <div className="stage-line__stop stage-line__stop--open">
      <h3>{C.stillOpen}</h3>
      {!hasOpenWork(c) ? <p>{C.nothingOpen}</p> : (
        <ul className="stage-line__open" role="list">
          {c.noDecision > 0 ? (
            // A count, not the questions' names (owner's ruling, 15 Nov 2026 19:20): the link leads to the filtered list.
            <li><ListLink href={`${stageHref}?show=no_decision`}>{C.noDecisionQuestions(c.noDecision)}</ListLink></li>
          ) : null}
          {c.openFindings > 0 ? (
            // The findings page filtered to this stage lists every open finding the count holds.
            <li>
              {used(findingFirst, TERM_FINDING, <ListLink href={`${p.base}/findings?stage=${p.stage}`}>{plural(c.openFindings, C.openFinding, C.openFindings)}</ListLink>)}
              {c.openFindingsWithoutMitigation > 0 ? used(m === 'bracket', TERM_MITIGATION, C.withoutMitigation(c.openFindingsWithoutMitigation)) : null}
              {defined(findingFirst, TERM_FINDING)}
              {defined(m === 'bracket', TERM_MITIGATION)}
            </li>
          ) : null}
          {c.overdueMitigations > 0 ? (
            <li className="stage-line__mitigations">
              <p>
                <span className="followup-overdue"><Icon name="clock" size={16} />{F.overdue}</span>
                {': '}{used(m === 'overdue', TERM_MITIGATION, P.mitigationCount(c.overdueMitigations))}
                {defined(m === 'overdue', TERM_MITIGATION)}
              </p>
              <Plates items={overdue} base={p.base} />
            </li>
          ) : (
            <li className="stage-line__quiet">
              {used(m === 'noOverdue', TERM_MITIGATION, P.noOverdue)}
              {defined(m === 'noOverdue', TERM_MITIGATION)}
            </li>
          )}
          {others > 0 ? (
            <li><ListLink href={`${p.base}/findings?stage=${p.stage}`}>{P.otherOpenMitigations(others)}</ListLink></li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/**
 * One kit plate per mitigation, never run together: the text (linking to its finding), then "Assigned to: <name> ·
 * <status> · was due <date>" with only "was due <date>" in the overdue red (spec 7.1), the name in ink; a person who can no
 * longer act is said in two plain sentences.
 */
function Plates({ items, base }: { items: readonly FollowUpItem[]; base: string }): ReactElement {
  return (
    <ul className="stage-line__plates" role="list">
      {items.map((i) => (
        <li key={i.mitigationId} className={i.overdue ? 'stage-line__plate stage-line__plate--overdue' : 'stage-line__plate'}>
          <ItemPlate
            title={i.what ?? F.erased}
            href={`${base}/findings/${i.findingId}`}
            state={(
              <>
                <span className="stage-line__plate-meta">
                  <span>{F.assignedTo(i.owner.name)}</span>{SEP}<span className="status-label">{STATUS_WORD[i.status]}</span>{SEP}
                  {i.overdue ? <span className="followup-overdue">{P.wasDue(formatDay(i.dueDate))}</span> : <span>{F.due(formatDay(i.dueDate))}</span>}
                </span>
                {i.ownerCanAct ? null : <span className="stage-line__plate-note">{F.cannotAct(i.owner.name)}{' '}{F.reassign}</span>}
              </>
            )}
          />
        </li>
      ))}
    </ul>
  );
}

/** The stage's reviews (spec 9.2): each one's name, its number and state, its purpose, and for one not sealed what to look at first. */
function Reviews(p: StageLineProps): ReactElement {
  const reviewsBase = `${p.base}/reviews`;
  const sr = p.uses.stageReview !== 'share' && p.uses.stageReview.stage === p.stage ? p.uses.stageReview.at : null;
  return (
    <div className="stage-line__stop stage-line__stop--reviews">
      <h3>{P.reviewsHeading}</h3>
      {p.reviews.length === 0 ? (
        <p>{used(sr === 'empty', TERM_STAGE_REVIEW, REVIEW_COPY.mounted.noReviews)}{defined(sr === 'empty', TERM_STAGE_REVIEW)}</p>
      ) : (
        <ul className="review-list" role="list">
          {p.reviews.map((r) => (
            <li key={r.id} className="review-list__item">
              <ListLink className="review-list__name" href={`${reviewsBase}/${r.id}`}>{r.name}</ListLink>
              <p className="review-list__meta">
                {P.reviewNumber(r.numberInStage)}{SEP}
                <ReviewState review={r} base={p.base} uses={p.uses} />
              </p>
              {r.preparedForErased !== null ? <p className="review-list__meta">{REVIEW_COPY.review.facts.preparedFor}: {REVIEW_COPY.mounted.noteErased(formatDay(r.preparedForErased.erasedOn))}</p>
                // The note is team-typed: only it sits in <bdi>, so right-to-left text cannot reorder the line (merge review M-2).
                : r.preparedFor !== null ? <p className="review-list__meta">{REVIEW_COPY.review.facts.preparedFor}: <bdi>{r.preparedFor}</bdi></p> : null}
              {r.latestSeal === null ? <BeforeSealing counts={p.counts} base={p.base} stage={p.stage} /> : null}
            </li>
          ))}
        </ul>
      )}
      {p.canOpenReview ? (
        <p>
          {used(sr === 'open', TERM_STAGE_REVIEW, <ListLink href={`${reviewsBase}/new?stage=${p.stage}`}>{REVIEW_COPY.mounted.openReview}</ListLink>)}
          {defined(sr === 'open', TERM_STAGE_REVIEW)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A review's state after its number, all in the one line (owner's ruling of 15 Nov 2026, 21:32): not sealed yet; the damaged
 * seal's first sentence (said first, as reviewStateLine does; the review page holds the rest); or "sealed <date>" in the
 * reader's zone, then how many decisions and findings changed since, as one count linking to the review, which lists them.
 */
function ReviewState({ review: r, base, uses }: { review: StageReviewView; base: string; uses: FirstUses }): ReactElement {
  if (r.latestSeal === null) return <>{P.notSealedYet}</>;
  if (sealDamaged(r)) {
    const first = uses.seal !== 'share' && uses.seal.reviewId === r.id;
    return <>{used(first, TERM_SEAL, REVIEW_COPY.state.damagedShort)}{defined(first, TERM_SEAL)}</>;
  }
  const seal = r.latestSeal;
  const changed = r.changed === null ? 0 : r.changed.changedQuestions.length + r.changed.changedFindings.length;
  return (
    <>
      {P.sealed}{' '}<DeviceDateTime iso={seal.sealedAt} form="day" serverText={formatDay(seal.sealedAt)} />
      {changed > 0 ? <>{SEP}<ListLink href={`${base}/reviews/${r.id}`}>{P.changedSince(changed)}</ListLink></> : null}
    </>
  );
}

/** M11: for a review not sealed yet, what is still open in its stage, each above zero and each a link; or that nothing is. */
function BeforeSealing({ counts: c, base, stage }: { counts: StageCounts; base: string; stage: Stage }): ReactElement {
  const stageHref = stagePath(base, stage);
  const items: Array<{ key: string; href: string; words: string }> = [];
  if (c.noDecision > 0) items.push({ key: 'no-decision', href: `${stageHref}?show=no_decision`, words: C.noDecisionQuestions(c.noDecision) });
  if (c.doneWithoutEvidence > 0) items.push({ key: 'no-evidence', href: `${stageHref}?show=done_without_evidence`, words: P.doneNoEvidence(c.doneWithoutEvidence) });
  if (c.overdueMitigations > 0) items.push({ key: 'overdue', href: `${base}/findings?stage=${stage}`, words: P.overdueMitigations(c.overdueMitigations) });
  if (items.length === 0) return <p className="review-list__before">{P.nothingLeftOpen}</p>;
  return (
    <p className="review-list__before">
      {P.beforeSealing}
      {items.map((it, i) => <Fragment key={it.key}>{i === 0 ? ' ' : ', '}<ListLink href={it.href}>{it.words}</ListLink></Fragment>)}
    </p>
  );
}

/**
 * The next step (plan 1C C11; owner's ruling on C3): "Next question" and that question in words with its place in the
 * stage when the question has no decision yet, then the page's one primary action. When the person is sent to a question
 * already decided (C11's "last-saved" rule: a stage with nothing open), "Every question in this stage has a decision." (or,
 * should the counts still hold open questions, how many) and the button. Rendered in the target line's head stop, and once
 * above the lines for the stacked form (`where`), one of the two hidden by CSS at every width.
 */
export function NextStep({ target, base, route, counts, where }: {
  target: ContinueTarget; base: string; route: StageRoute; counts: StageCounts; where: 'line' | 'stacked';
}): ReactElement {
  const questionId = target.questionId;
  const at = questionId === null ? -1 : route.stops.findIndex((s) => s.id === questionId);
  const next = at !== -1 && route.stops[at].kind === 'no_decision' ? route.stops[at] : null;
  const href = questionId === null ? stagePath(base, target.stage) : `${stagePath(base, target.stage)}/questions/${questionId}`;
  // Above the stacked lines the block is not inside its stage's line, so it names the stage before the place in it. Below
  // 52rem that is the page's first use of the stage's term (N1): the name is marked as the term with lane 1's (i) beside
  // it, in the same p. The line's own head stop keeps its Definition under the heading.
  const term = STAGE_TERM[target.stage];
  const stagePrefix = where === 'stacked'
    ? <><Term of={term}>{P.stageNames[target.stage]}</Term><TermTip of={term} label={P.whatMeans(term.term)} />{SEP}</>
    : null;
  return (
    <div className={`next-step-block next-step-block--${where}`}>
      <p className="stage-line__next">
        {next !== null ? (
          <>
            {/* The label and the question, at most two lines (R7); the place in the stage under them, whole. */}
            <span className="stage-line__next-words">
              <b className="stage-line__next-label">{P.nextLabel}</b>{' '}
              <span className="stage-line__next-text">{next.title}</span>
            </span>{' '}
            <span className="stage-line__position">{stagePrefix}{positionWords(at + 1, route.stops.length)}</span>
          </>
        ) : <>{stagePrefix}{counts.noDecision > 0 ? P.noDecisionYet(counts.noDecision) : P.allDecided}</>}
      </p>
      <p className="stage-line__primary">
        <ButtonLink variant="primary" href={href}>{target.label === 'continue' ? P.continue : P.start}</ButtonLink>
      </p>
    </div>
  );
}

/** The last stop of every line: how many questions have no decision (or that none is left), then "All questions in this stage". */
function LastStop(p: StageLineProps & { headingId: string }): ReactElement {
  return (
    <div className="stage-line__stop stage-line__stop--last">
      <p className="stage-line__next">{p.counts.noDecision > 0 ? P.noDecisionYet(p.counts.noDecision) : P.allDecided}</p>
      <p>
        <ListLink href={stagePath(p.base, p.stage)} aria-describedby={p.headingId}>{C.allQuestions}</ListLink>
      </p>
    </div>
  );
}
