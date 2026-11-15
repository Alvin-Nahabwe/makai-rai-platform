import type { ReactElement, ReactNode } from 'react';
import { GateSignOut } from '@/components/layout/GateSignOut';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { GATE_COPY } from '@/lib/shell/copy';
import { UI_COPY } from '@/lib/ui/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import './gate.css';

/** One stop of the door the person is going through. A route has exactly one `current` stop. */
export type GateStop = { label: string; state: 'done' | 'current' | 'upcoming' };

type Shared = { route?: readonly GateStop[]; wide?: boolean; children: ReactNode };
export type GateFrameProps =
  /** `accountReachable`: whether this account may open My account now (false while gate 2 holds it on S-29); M-41's Go to them depends on it. */
  | ({ variant: 'signed-in'; userName: string; userId: string; accountReachable: boolean } & Shared)
  | ({ variant: 'public' } & Shared);

/**
 * The route of this door's stops, drawn as the route column draws a stage (spec 5 principle 7, 7.2): a labelled list, a
 * line joining white marks, the current stop enlarged with "You are here" above its name. Marks are borders drawn by CSS
 * and hidden; a done stop carries the visually hidden "(done)", never a tick. Below 1024 px CSS shows the lines after it
 * instead: where the person is and, when the route lists one, the next stop. Never a count (ruling L5-21): gate 2 runs
 * before gate 3, so no page knows how many steps a person still has.
 */
function GateRoute({ route }: { route: readonly GateStop[] }): ReactElement {
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

/**
 * The gate frame (plan 1B Task 1, lead's ruling L5-1): the Route's rail with no navigation in it. From 1024 px a navy
 * column at the rail's width holds the product name (text, not a link), the route of this door and, signed in, the person's
 * name, Help and Sign out; beside it, on the ground, the page's content in a white card. Below 1024 px the column is a navy
 * band above the card. Nothing in it is orange (spec 7.1), and it links nowhere a gated account cannot go (T1.3): Help is
 * public and shows a gated account the public header, not the rail (R7), and Sign out is the person's own.
 *
 * `signed-in` is the page's frame in app/(gate): its column is the page's banner and the card sits in the page's one <main>,
 * the skip link's target. Each page renders the frame itself, with its own route, because a layout is not rendered again on
 * a client navigation between its pages (layout.md, "Layouts do not rerender"). `public` sits inside the (public) layout,
 * which already has the light header and the <main>: it renders neither, only the column and the card area.
 */
export function GateFrame(props: GateFrameProps): ReactElement {
  const signedIn = props.variant === 'signed-in';
  const route = props.route !== undefined && props.route.length > 0 ? <GateRoute route={props.route} /> : null;
  const className = `gate gate--${props.variant}${props.wide ? ' gate--wide' : ''}`;
  const card = <div className="gate__card">{props.children}</div>;
  // The owner's ruling (I-3): the MAK-AI logo sits above the platform's name, in the rail and here. The logo component is
  // another lane's; its slot is this empty element, which takes no room until the logo is put in it.
  const brand = (
    <div className="gate__brand">
      <div className="gate__logo" data-slot="logo"></div>
      <p className="gate__product">{PRODUCT_NAME}</p>
    </div>
  );

  if (!signedIn) {
    return (
      <div className={className}>
        <div className="gate__header">
          <div className="gate__column">
            {brand}
            {route}
          </div>
        </div>
        <div className="gate__main">{card}</div>
      </div>
    );
  }

  return (
    <div className={className}>
      <header className="gate__header">
        <div className="gate__column">
          {brand}
          {route}
          <div className="gate__footer">
            <p className="gate__name">{props.userName}</p>
            <a className="gate__help" href="/help">{GATE_COPY.help}</a>
            <GateSignOut userId={props.userId} accountReachable={props.accountReachable} />
          </div>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="gate__main">{card}</main>
    </div>
  );
}
