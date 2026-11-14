import './NextStepCard.css';
import type { ReactElement, ReactNode } from 'react';
import { ButtonLink } from '@/components/ui/Button';
import { LocalTime } from '@/components/ui/LocalTime';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { HOME_COPY } from '@/lib/home/copy';
import { positionWords } from '@/lib/ui/copy';
import type { NextStep } from '@/lib/home/types';
import type { UtcInstant } from '@/types/record';

/** Stands where a sentence of HOME_COPY takes a value that is rendered as an element; never shown. */
const SLOT = '\u0000';

/** A sentence of HOME_COPY with `node` placed where it took `SLOT`, so the words stay in the copy module alone. */
function withSlot(sentence: string, node: ReactNode): ReactNode {
  const [before, after] = sentence.split(SLOT);
  return <>{before}{node}{after}</>;
}

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
 * Home's "Your next step" (spec 9.1; plan 1B rule C2): one question, named in words with its code small after them, where
 * it is, why it was chosen, and two equal controls, one to the question and one to its stage's questions. A server
 * component: no state and no handler of its own.
 */
export function NextStepCard({ orgSlug, next }: { orgSlug: string; next: NextStep }): ReactElement {
  const stage = `/orgs/${orgSlug}/projects/${next.projectId}/stages/${next.stage}`;
  return (
    <section className="next-step" aria-labelledby="next-step">
      <h2 id="next-step">{HOME_COPY.nextStepHeading}</h2>
      <p className="next-step__where">
        <span>{withSlot(HOME_COPY.projectOf(SLOT), <bdi>{next.projectName}</bdi>)}</span>
        <span>{STAGE_NAME[next.stage]}</span>
      </p>
      <p className="next-step__question">
        <bdi>{next.questionText}</bdi> <span className="next-step__code">{next.questionId}</span>
      </p>
      <p>{positionWords(next.position.n, next.position.of)}</p>
      <p>{reasonOf(next)}</p>
      <div className="next-step__actions">
        <ButtonLink variant="secondary" href={`${stage}/questions/${next.questionId}`}>{HOME_COPY.continueRecording}</ButtonLink>
        <ButtonLink variant="secondary" href={stage}>{HOME_COPY.chooseAnother}</ButtonLink>
      </div>
    </section>
  );
}
