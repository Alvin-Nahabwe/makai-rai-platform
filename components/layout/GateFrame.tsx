import type { ReactElement, ReactNode } from 'react';
import { GateSignOut } from '@/components/layout/GateSignOut';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { MAKAI_LOGO } from '@/components/layout/logos';
import { GateRoute, type GateStop } from '@/components/layout/GateRoute';
import { GATE_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import './gate.css';

export type { GateStop };

type Shared = {
  route?: readonly GateStop[];
  /** In place of `route`: a client element that draws the route itself (GateRoute), for a page whose step changes in the browser. */
  routeSlot?: ReactNode;
  wide?: boolean;
  children: ReactNode;
};
export type GateFrameProps =
  /** `accountReachable`: whether this account may open My account now (false while gate 2 holds it on S-29); M-41's Go to them depends on it. */
  | ({ variant: 'signed-in'; userName: string; userId: string; accountReachable: boolean } & Shared)
  | ({ variant: 'public' } & Shared);

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
  const route = props.routeSlot !== undefined ? props.routeSlot
    : props.route !== undefined && props.route.length > 0 ? <GateRoute route={props.route} /> : null;
  const className = `gate gate--${props.variant}${props.wide ? ' gate--wide' : ''}`;
  const card = <div className="gate__card">{props.children}</div>;
  // The owner's ruling (I-3, 15 Nov): the MAK-AI logo with the platform's name under it, as the rail draws it (lane 3's
  // components/layout/logos.ts, the white variant, drawn only on navy). No link here: the frame links only to Help (T1.3).
  // The logo is decorative beside the visible name, so its alt is empty.
  const brand = (
    <div className="gate__brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- a file already sized for the drawn logo (logos.ts). */}
      <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height} alt=""
        decoding="async" className="gate__logo" />
      {/* Public pages: the light header above names the platform, so the column does not say it twice (ruling L5-26). */}
      {signedIn ? <p className="gate__product">{PRODUCT_NAME}</p> : null}
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
            {props.userName !== '' ? <p className="gate__name">{props.userName}</p> : null}
            <a className="gate__help" href="/help">{GATE_COPY.help}</a>
            <GateSignOut userId={props.userId} accountReachable={props.accountReachable} />
          </div>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="gate__main">{card}</main>
    </div>
  );
}
