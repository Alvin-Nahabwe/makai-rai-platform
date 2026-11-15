import type { ReactElement } from 'react';
import { GateSignOut } from '@/components/layout/GateSignOut';
import { MAIN_CONTENT_ID } from '@/components/layout/SkipLink';
import { GateBrand, GatePublicFrame, gateRouteOf, type GateFrameShared } from '@/components/layout/GatePublicFrame';
import type { GateStop } from '@/components/layout/GateRoute';
import { GATE_COPY } from '@/lib/shell/copy';
import { PRODUCT_NAME } from '@/lib/ui/title';
import './gate-signed-in.css';

export type { GateStop };

type Shared = GateFrameShared;
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
  // The public variant is GatePublicFrame's, which a public page may also draw directly without this module's signed-in
  // sheet and sign-out (S-04, the lean frame, owner, 15 Nov 15:35).
  if (props.variant !== 'signed-in') {
    return <GatePublicFrame route={props.route} routeSlot={props.routeSlot} wide={props.wide}>{props.children}</GatePublicFrame>;
  }

  return (
    <div className={`gate gate--signed-in${props.wide ? ' gate--wide' : ''}`}>
      <header className="gate__header">
        <div className="gate__column">
          <GateBrand name={<p className="gate__product">{PRODUCT_NAME}</p>} />
          {gateRouteOf(props)}
          <div className="gate__footer">
            {props.userName !== '' ? <p className="gate__name">{props.userName}</p> : null}
            <a className="gate__help" href="/help">{GATE_COPY.help}</a>
            <GateSignOut userId={props.userId} accountReachable={props.accountReachable} />
          </div>
        </div>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="gate__main"><div className="gate__card">{props.children}</div></main>
    </div>
  );
}
