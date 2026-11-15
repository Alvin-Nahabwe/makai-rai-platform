import type { ReactElement } from 'react';
import { GateRoute, type GateStop } from '@/components/layout/GateRoute';
import { INVITATION_COPY } from '@/lib/invitations/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { INVITATION_ROUTE_ID, type InvitationStep } from './invitationStep';

const FIRST: InvitationStep = 'details';

/** S-04's new-account route for each step: Your details, Accept the terms, Join (ruling L5-14). */
const ROUTES: Readonly<Record<InvitationStep, readonly GateStop[]>> = {
  details: [
    { label: INVITATION_COPY.stops.details, state: 'current' },
    { label: GATE_COPY.stops.accept, state: 'upcoming' },
    { label: INVITATION_COPY.stops.join, state: 'upcoming' },
  ],
  acceptances: [
    { label: INVITATION_COPY.stops.details, state: 'done' },
    { label: GATE_COPY.stops.accept, state: 'current' },
    { label: INVITATION_COPY.stops.join, state: 'upcoming' },
  ],
};

/**
 * S-04's route in the gate frame's column when signed out, following the new-account form's step (ruling L5-28). Drawn on
 * the server, once per step, so the browser downloads no route code (the lean frame, owner, 15 Nov 15:35): the wrapper's
 * `data-step` names the step, the first one in the page's HTML, and the frame's public sheet draws only that step's route
 * (`.gate-steps`). The form names its step there as it changes (showInvitationStep). The route not shown is `display:
 * none`, so its list, its "You are here" and its aria-current are out of the accessibility tree; each route is GateRoute's,
 * with the band's "You are here" and "Next" lines, and the wrappers are `display: contents`, so the column lays them out
 * as its own children.
 */
export function InvitationRoute(): ReactElement {
  return (
    <div id={INVITATION_ROUTE_ID} className="gate-steps" data-step={FIRST}>
      {(Object.keys(ROUTES) as InvitationStep[]).map((step) => (
        <div key={step} className="gate-steps__step" data-for={step}><GateRoute route={ROUTES[step]} /></div>
      ))}
    </div>
  );
}
