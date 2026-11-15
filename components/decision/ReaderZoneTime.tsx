'use client';

import { useSyncExternalStore, type ReactElement } from 'react';
import { formatDay, formatTime } from '@/lib/format/dates';
import type { UtcInstant } from '@/types/record';

const subscribe = () => () => {};
const deviceZone = (): string | null => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = (): string | null => null;

/**
 * An instant as "12 Oct 2026, 10:42 EAT" in the reader's time zone, WITH the zone's name: the decision card writes the
 * saved time in the reader's zone (spec 7.3) beside "Entered by", which is in East Africa time (coordinator's ruling,
 * T3 item 9), so both name their zone and never read as a contradiction for a reader outside East Africa. As the kit's
 * LocalTime: the server render and the hydration pass have no reader's zone, so they write UTC and say so; the reader's
 * zone replaces it after hydration, and the two renders agree. `<time dateTime>` carries the instant itself.
 */
export function ReaderZoneTime({ at }: { at: UtcInstant }): ReactElement {
  const zone = useSyncExternalStore(subscribe, deviceZone, serverZone) ?? 'UTC';
  return <time dateTime={at}>{`${formatDay(at, zone)}, ${formatTime(at, zone)}`}</time>;
}
