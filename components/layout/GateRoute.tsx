import type { ReactElement } from 'react';
import { GATE_COPY } from '@/lib/shell/copy';
import { UI_COPY } from '@/lib/ui/copy';

/** One stop of the door the person is going through. A route has exactly one `current` stop. */
export type GateStop = { label: string; state: 'done' | 'current' | 'upcoming' };

/**
 * The route of this door's stops, drawn as the route column draws a stage (spec 5 principle 7, 7.2): a labelled list, a
 * line joining white marks, the current stop enlarged with "You are here" above its name. Marks are borders drawn by CSS
 * and hidden; a done stop carries the visually hidden "(done)", never a tick. Below 1024 px CSS shows the lines after it
 * instead: where the person is and, when the route lists one, the next stop. Never a count (ruling L5-21): gate 2 runs
 * before gate 3, so no page knows how many steps a person still has.
 *
 * Its own module, with no hook and no server import, so a page whose step changes in the browser (D16 on S-01, a used
 * reset link on S-03) draws it from its client code through GateFrame's `routeSlot`, without the frame's sign-out.
 */
export function GateRoute({ route }: { route: readonly GateStop[] }): ReactElement {
  const current = route.filter((s) => s.state === 'current');
  if (current.length !== 1) throw new Error(`GateFrame: a route has exactly one current stop, not ${current.length}`);
  const next = route.slice(route.indexOf(current[0]) + 1).find((s) => s.state === 'upcoming');
  return (
    <>
      <ol className="gate-route" role="list" aria-label={GATE_COPY.routeLabel}>
        {route.map((stop, i) => (
          <li key={`${i}-${stop.label}`} className={`gate-route__stop gate-route__stop--${stop.state}`}>
            <span className="gate-route__mark" aria-hidden="true"></span>
            {stop.state === 'current' ? (
              <span className="gate-route__label" aria-current="step">
                <span className="gate-route__here">{GATE_COPY.here}</span>{' '}{stop.label}
              </span>
            ) : (
              <span className="gate-route__label">
                {stop.label}
                {stop.state === 'done' ? <>{' '}<span className="visually-hidden">{UI_COPY.stepper.done}</span></> : null}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="gate__where">{GATE_COPY.where(current[0].label)}</p>
      {next !== undefined ? <p className="gate__next">{GATE_COPY.next(next.label)}</p> : null}
    </>
  );
}
