/**
 * S-04's signed-out step, shared by the server-drawn route (InvitationRoute.tsx) and the new-account form that changes it
 * (AcceptInvitationClient.tsx). No import: the client brings this module and nothing else for the route (the lean frame,
 * owner, 15 Nov 15:35), so GateRoute, the shell's copy and a step store stay off S-04's first visit.
 */
export type InvitationStep = 'details' | 'acceptances';

/** The id of the route's wrapper in the frame's column; its `data-step` names the step whose route is shown. */
export const INVITATION_ROUTE_ID = 'invitation-route';

/**
 * Shows the route of `step`: the wrapper's `data-step` selects it in the frame's public sheet (components/layout/gate.css,
 * `.gate-steps`). The page draws the wrapper whenever it draws the new-account form, so a missing one is a fault of the
 * page; it is logged and the form goes on, since the card's own heading and fields still say which step this is.
 */
export function showInvitationStep(doc: Pick<Document, 'getElementById'>, step: InvitationStep): void {
  const route = doc.getElementById(INVITATION_ROUTE_ID);
  if (route === null) {
    console.warn('invitation: the frame has no route for the step', step);
    return;
  }
  route.setAttribute('data-step', step);
}
