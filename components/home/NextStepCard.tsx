import type { ReactElement, ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { LocalTime } from '@/components/ui/LocalTime';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { HOME_COPY } from '@/lib/home/copy';
import { positionWords } from '@/lib/ui/copy';
import { questionHref } from '@/lib/question/draft';
import type { NextStep } from '@/lib/home/types';
import type { UtcInstant } from '@/types/record';
import { SLOT, withSlot } from '@/components/home/parts';

/** The day of the person's last save, in the reader's zone once hydrated. Rules next-open and last-saved always carry it. */
function savedDay(at: UtcInstant | null): ReactNode {
  if (at === null) throw new Error('NextStepCard: a next step chosen from a last save has no saved day');
  return <LocalTime at={at} dateOnly />;
}

function reasonOf(next: NextStep): ReactNode {
  if (next.rule === 'first-open') return HOME_COPY.reasonFirstOpen;
  if (next.rule === 'last-saved') return withSlot(HOME_COPY.reasonLastSaved(SLOT), savedDay(next.lastSavedOn));
  return withSlot(HOME_COPY.reasonNextOpen(STAGE_NAME[next.stage], SLOT), savedDay(next.lastSavedOn));
}

/**
 * Home's "Your next step" (spec 9.1; sketch home.png): the "you are here" ring, then where the question is (its stage, its
 * place in the stage, its project), the question in words with its code small after them, why it was chosen, and two
 * controls of one size (plan C7; the spec's two equal controls in place of the sketch's small link): the primary to the
 * question, the secondary to its stage's questions, in that order on every width. A server component.
 */
export function NextStepCard({ orgSlug, next }: { orgSlug: string; next: NextStep }): ReactElement {
  const stage = `/orgs/${orgSlug}/projects/${next.projectId}/stages/${next.stage}`;
  return (
    <section className="home-next" aria-labelledby="next-step">
      <svg className="home-next__here" width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
        <circle cx="20" cy="20" r="17" fill="none" stroke="currentColor" strokeWidth="4" />
        <circle className="home-next__here-dot" cx="20" cy="20" r="5" />
      </svg>
      <div className="home-next__body">
        <h2 id="next-step" className="home-next__heading">{HOME_COPY.nextStepHeading}</h2>
        <p className="home-next__where">
          {STAGE_NAME[next.stage]} · {positionWords(next.position.n, next.position.of)} · <bdi>{next.projectName}</bdi>
        </p>
        <p className="home-next__question">
          <bdi>{next.questionText}</bdi> <span className="home-next__code">{next.questionId}</span>
        </p>
        <p className="home-next__reason">{reasonOf(next)}</p>
        <div className="home-next__actions">
          <ButtonLink variant="primary" href={questionHref({ orgSlug, projectId: next.projectId, stage: next.stage }, next.questionId)}>{HOME_COPY.continueRecording}</ButtonLink>
          <ButtonLink variant="secondary" href={stage}>{HOME_COPY.chooseAnother}</ButtonLink>
        </div>
      </div>
    </section>
  );
}
