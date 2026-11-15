import type { ReactElement, ReactNode } from 'react';
import { MAKAI_LOGO } from '@/components/layout/logos';
import { GateRoute, type GateStop } from '@/components/layout/GateRoute';
import './gate.css';

/** What both variants of the gate frame take (components/layout/GateFrame.tsx). */
export type GateFrameShared = {
  route?: readonly GateStop[];
  /** In place of `route`: an element that draws the route itself, for a page whose step changes in the browser. */
  routeSlot?: ReactNode;
  wide?: boolean;
  children: ReactNode;
};

/** The column's route: the page's own element, else the list of `route`, else nothing. */
export function gateRouteOf(props: Pick<GateFrameShared, 'route' | 'routeSlot'>): ReactNode {
  return props.routeSlot !== undefined ? props.routeSlot
    : props.route !== undefined && props.route.length > 0 ? <GateRoute route={props.route} /> : null;
}

/**
 * The column's brand. The owner's ruling (I-3, 15 Nov): the MAK-AI logo with the platform's name under it, as the rail
 * draws it (lane 3's components/layout/logos.ts, the white variant, drawn only on navy). No link here: the frame links only
 * to Help (T1.3). The logo is decorative beside the visible name, so its alt is empty. `name` is the signed-in frame's;
 * public pages have the light header's name instead, so the column does not say it twice (ruling L5-26).
 */
export function GateBrand({ name }: { name?: ReactNode }): ReactElement {
  return (
    <div className="gate__brand">
      {/* eslint-disable-next-line @next/next/no-img-element -- a file already sized for the drawn logo (logos.ts). */}
      <img src={MAKAI_LOGO.src} srcSet={MAKAI_LOGO.srcSet} width={MAKAI_LOGO.width} height={MAKAI_LOGO.height} alt=""
        decoding="async" className="gate__logo" />
      {name}
    </div>
  );
}

/**
 * The gate frame's public variant (GateFrame variant="public"), in a module of its own so that a public page can draw it
 * without the signed-in frame (the owner's ruling of 15 Nov 15:35, the lean frame): this module brings only the public
 * sheet, ./gate.css, and no client code. GateFrame draws its public variant with it, so the two cannot drift; S-04 imports
 * it directly and so loads neither the signed-in sheet nor the sign-out's code.
 *
 * It sits inside the (public) layout, which already has the light header and the <main>: it renders neither, only the
 * column and the card area.
 */
export function GatePublicFrame(props: GateFrameShared): ReactElement {
  return (
    <div className={`gate gate--public${props.wide ? ' gate--wide' : ''}`}>
      <div className="gate__header">
        <div className="gate__column">
          <GateBrand />
          {gateRouteOf(props)}
        </div>
      </div>
      <div className="gate__main"><div className="gate__card">{props.children}</div></div>
    </div>
  );
}
