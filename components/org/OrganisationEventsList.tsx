import type { OrgEventView } from '@/types/api';
import type { ActorRole, OrgEventAction } from '@/types/record';
import type { ReactElement } from 'react';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { Table, type TableColumn } from '@/components/ui/Table';
import { formatDay, formatTime } from '@/lib/format/dates';
import { ORG_COPY, roleTerm } from '@/lib/org/copy';
import './OrgDetails.css';

export type OrganisationEventsListProps = { events: OrgEventView[]; hasMore: boolean };

const E = ORG_COPY.events;

/**
 * Each action of FR-ORG-09 in plain words (SRS 7.5: no internal names, no dashes, no curly quotes) is `E.actions`, from
 * the organisation screens' copy module, which `satisfies Record<OrgEventAction, string>`: a new `OrgEventAction` is an
 * error there until it has words; the test compares the keys with the database's CHECK list of
 * `organisation_events.action`.
 */
export const ALL_ORG_EVENT_ACTIONS: readonly OrgEventAction[] = Object.keys(E.actions) as OrgEventAction[];

export function actionWords(action: OrgEventAction): string {
  return E.actions[action];
}

/** The actor's role at the time, as 7.5.2 names it: the platform role is "MAK-AI administrator", a member's role the vocabulary's word. */
function roleWords(role: ActorRole): string {
  return role === 'platform_admin' ? E.administrator : roleTerm(role).term;
}

const COLUMNS = [
  { key: 'when', label: E.columns.when },
  { key: 'who', label: E.columns.who },
  { key: 'what', label: E.columns.what },
  { key: 'concerning', label: E.columns.concerning },
  { key: 'reason', label: E.columns.reason },
  { key: 'before', label: E.columns.before },
] as const satisfies ReadonlyArray<TableColumn>;

/**
 * The organisation's platform and membership changes, a slot of S-30 (contract "Screens and slots"; MEM
 * renders the page, ORG fills the slot). One row per event, newest first: when, who with their role, what,
 * whom it concerned, the reason or request reference, and the earlier value (the earlier name of a name
 * change, FR-ORG-10). Times are written in East Africa Time, the zone of the platform's teams, because
 * the slot is rendered on the server. "Show older" pages back by the last event's id. The table is the kit's
 * (plan 1A Task 19): under 640 px of its own width each row becomes a card.
 */
export function OrganisationEventsList({ events, hasMore }: OrganisationEventsListProps): ReactElement {
  const last = events.at(-1);
  const rows = events.map((e) => ({
    key: e.id,
    cells: {
      when: <time dateTime={e.at}>{`${formatDay(e.at, 'Africa/Kampala')}, ${formatTime(e.at, 'Africa/Kampala')}`}</time>,
      who: `${e.actorName} (${roleWords(e.actorRole)})`,
      what: actionWords(e.action),
      concerning: e.targetName ?? '',
      reason: [e.reason, e.requestReference].filter((x): x is string => x !== null).join('; '),
      before: e.previousValue ?? '',
    },
  }));
  return (
    <section aria-labelledby="org-events-heading" className="org-block">
      <h2 id="org-events-heading">{E.heading}</h2>
      {events.length === 0 ? <p>{E.none}</p> : <Table caption={E.caption} columns={COLUMNS} rows={rows} rowHeaderKey="when" />}
      {hasMore && last ? <ShowMoreLink href={`?before=${encodeURIComponent(last.id)}`} label={E.showOlder} /> : null}
    </section>
  );
}
