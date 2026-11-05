import type { OrgEventView } from '@/types/api';
import type { ActorRole, OrgEventAction } from '@/types/record';
import type { ReactElement } from 'react';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { formatDay, formatTime } from '@/lib/format/dates';

export type OrganisationEventsListProps = { events: OrgEventView[]; hasMore: boolean };

/**
 * Each action of FR-ORG-09 in plain words (SRS 7.5: no internal names, no dashes, no curly quotes). The
 * `Record` makes a new `OrgEventAction` a type error here until it has words; the test compares the keys
 * with the database's CHECK list of `organisation_events.action`.
 */
const ACTION_WORDS: Readonly<Record<OrgEventAction, string>> = {
  organisation_created: 'Created the organisation',
  agreement_recorded: 'Recorded the organisation agreement',
  owner_invitation_issued: 'Invited a first owner',
  owner_invitation_resent: 'Resent the first-owner invitation',
  owner_invitation_revoked: 'Revoked the first-owner invitation',
  organisation_name_corrected: 'Corrected the organisation name',
  account_deactivated: 'Deactivated an account',
  account_reactivated: 'Reactivated an account',
  member_invited: 'Invited a member',
  member_joined: 'Joined the organisation',
  member_role_changed: 'Changed a member\'s role',
  member_removed: 'Removed a member',
  member_left: 'Left the organisation',
};

export const ALL_ORG_EVENT_ACTIONS: readonly OrgEventAction[] = Object.keys(ACTION_WORDS) as OrgEventAction[];

export function actionWords(action: OrgEventAction): string {
  return ACTION_WORDS[action];
}

/** The actor's role at the time, as 7.5.2 names it: the platform role is "MAK-AI administrator". */
function roleWords(role: ActorRole): string {
  return role === 'platform_admin' ? 'MAK-AI administrator' : role;
}

/**
 * The organisation's platform and membership changes, a slot of S-30 (contract "Screens and slots"; MEM
 * renders the page, ORG fills the slot). One row per event, newest first: when, who with their role, what,
 * whom it concerned, the reason or request reference, and the earlier value (the earlier name of a name
 * correction, FR-ORG-10). Times are written in East Africa Time, the zone of the platform's teams, because
 * the slot is rendered on the server. "Show older" pages back by the last event's id.
 */
export function OrganisationEventsList({ events, hasMore }: OrganisationEventsListProps): ReactElement {
  const last = events.at(-1);
  return (
    <section aria-labelledby="org-events-heading">
      <h2 id="org-events-heading">Administrator and membership changes</h2>
      {events.length === 0 ? (
        <p>No changes recorded yet.</p>
      ) : (
        <div className="admin-table-wrapper card" tabIndex={0} role="region" aria-labelledby="org-events-caption">
          <table className="admin-table">
            <caption id="org-events-caption">Changes to this organisation and its members, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Concerning</th>
                <th scope="col">Reason or request reference</th>
                <th scope="col">Earlier value</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <time dateTime={e.at}>{`${formatDay(e.at, 'Africa/Kampala')}, ${formatTime(e.at, 'Africa/Kampala')}`}</time>
                  </td>
                  <td>{`${e.actorName} (${roleWords(e.actorRole)})`}</td>
                  <td>{actionWords(e.action)}</td>
                  <td>{e.targetName ?? ''}</td>
                  <td>{[e.reason, e.requestReference].filter((x): x is string => x !== null).join('; ')}</td>
                  <td>{e.previousValue ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && last ? <ShowMoreLink href={`?before=${encodeURIComponent(last.id)}`} label="Show older" /> : null}
    </section>
  );
}
