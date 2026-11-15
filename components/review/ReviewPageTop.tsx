import type { ReactElement } from 'react';
import type { BreadcrumbItem } from '@/components/ui/types';
import { ReviewPageHeader } from '@/components/review/ReviewPageHeader';
import { DeviceDateTime } from '@/components/review/DeviceTime';
import { formatDay } from '@/lib/format/dates';
import { REVIEW_COPY, STAGE_TERMS } from '@/lib/review/copy';
import { TERM_FINDING, TERM_FINGERPRINT, TERM_SEAL } from '@/lib/vocabulary/terms';
import type { StageReviewView } from '@/types/api';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import './review.css';

type FactsView = Pick<StageReviewView, 'stage' | 'preparedFor' | 'preparedForErased' | 'openedBy' | 'openedAt'>;

/**
 * S5 (audit C 7): the facts of a stage review as a description list, Stage, Prepared for (when a note was given or
 * erased) and Opened by, in place of one line joined with middle dots. The note is what the team typed, as text.
 */
export function ReviewFacts({ view }: { view: FactsView }): ReactElement {
  const F = REVIEW_COPY.review.facts;
  const note = view.preparedForErased !== null ? REVIEW_COPY.mounted.noteErased(formatDay(view.preparedForErased.erasedOn))
    : view.preparedFor !== null ? <bdi>{view.preparedFor}</bdi> : null;
  return (
    <dl className="review-facts">
      <dt>{F.stage}</dt><dd>{REVIEW_COPY.stageNames[view.stage]}</dd>
      {note === null ? null : <><dt>{F.preparedFor}</dt><dd>{note}</dd></>}
      <dt>{F.openedBy}</dt>
      <dd><bdi>{view.openedBy.name}</bdi> {F.on} <DeviceDateTime iso={view.openedAt} form="day" serverText={formatDay(view.openedAt)} /></dd>
    </dl>
  );
}

/**
 * The top of S-16 (W-7): the breadcrumb, the review's name as its heading, the definitions of the terms the page uses
 * (spec 6), then its facts. The name holds the stage's first use ("Pre-processing review 1"). The page's first "seal"
 * is the state line under Status, so seal is introduced here; "finding" only when the page lists changed findings, and
 * "fingerprint" only when it lists a seal, whose fingerprint it shows.
 */
export function ReviewPageTop({ name, breadcrumb, view, hasSeals, changedFindings }: {
  name: string; breadcrumb: readonly BreadcrumbItem[]; view: FactsView; hasSeals: boolean; changedFindings: boolean;
}): ReactElement {
  const more: DefinedEntry[] = [TERM_SEAL];
  if (changedFindings) more.push(TERM_FINDING);
  if (hasSeals) more.push(TERM_FINGERPRINT);
  return (
    <ReviewPageHeader idPrefix="review-term" breadcrumb={breadcrumb} title={name} titleTerms={[STAGE_TERMS[view.stage]]} moreTerms={more} lead={<ReviewFacts view={view} />} />
  );
}
