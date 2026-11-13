import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';
import { UI_COPY } from '@/lib/ui/copy';
import './Stepper.css';

export type StepperStep = {
  label: string;
  /** An application path, passed to the link as given: callers pass their own addresses. */
  href?: string;
  state: 'done' | 'current' | 'upcoming';
};

export type StepperProps = { label: string; steps: readonly StepperStep[] };

/**
 * The steps of a task in order (plan 1A Task 5): a labelled <ol>, never a progress element or a filled track. Each step
 * has a disc drawn by CSS and hidden: filled when done, with the visually hidden word "(done)" after the step's name (no
 * tick); ringed in the action colour when current, whose name carries aria-current="step"; a thin ring when upcoming.
 * A step with an address is a link that never prefetches (ListLink). The list keeps role="list" because Safari drops
 * the list role, and so its label, from a list styled `list-style: none`.
 */
export function Stepper({ label, steps }: StepperProps): ReactElement {
  return (
    <ol className="ui-stepper" role="list" aria-label={label}>
      {steps.map((step, i) => {
        const current = step.state === 'current' ? 'step' : undefined;
        const name = (
          <>
            {step.label}
            {step.state === 'done' ? <>{' '}<span className="visually-hidden">{UI_COPY.stepper.done}</span></> : null}
          </>
        );
        return (
          <li key={`${i}-${step.label}`} className={step.state === 'upcoming' ? 'ui-stepper__step' : `ui-stepper__step ui-stepper__step--${step.state}`}>
            <span className="ui-stepper__disc" aria-hidden="true"></span>
            {step.href === undefined
              ? <span className="ui-stepper__label" aria-current={current}>{name}</span>
              : <ListLink className="ui-stepper__label" aria-current={current} href={step.href}>{name}</ListLink>}
          </li>
        );
      })}
    </ol>
  );
}
