'use client';

import { useSyncExternalStore, type ReactElement } from 'react';
import { formatDay, formatTime } from '@/lib/format/dates';
import type { UtcInstant } from '@/types/record';

const subscribe = () => () => {};
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = () => 'UTC';

/**
 * An instant as "30 Oct 2026 10:42 EAT" in the device's zone with its abbreviation, as 7.5.8 (line 2589) writes times. The
 * server render and the hydration pass use UTC ("07:42 UTC"), and the device's zone replaces it after hydration, so the
 * two renders agree and no mismatch is reported. `<time dateTime>` carries the instant itself for anything that reads it.
 */
export function LocalTime({ at, dateOnly = false }: { at: UtcInstant; dateOnly?: boolean }): ReactElement {
  const zone = useSyncExternalStore(subscribe, deviceZone, serverZone);
  return <time dateTime={at}>{dateOnly ? formatDay(at, zone) : `${formatDay(at, zone)} ${formatTime(at, zone)}`}</time>;
}
