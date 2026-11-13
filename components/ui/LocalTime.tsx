'use client';

import { useSyncExternalStore, type ReactElement } from 'react';
import { formatDay, formatDayTime } from '@/lib/format/dates';
import type { UtcInstant } from '@/types/record';

const subscribe = () => () => {};
const deviceZone = (): string | null => Intl.DateTimeFormat().resolvedOptions().timeZone;
const serverZone = (): string | null => null;

/**
 * An instant as "11 Nov 2026, 11:23" in the reader's time zone, with no zone name (voice rule 10; plan 1A, LocalTime).
 * The server render and the hydration pass have no reader's zone, so they write UTC and say so ("11 Nov 2026, 08:23 UTC");
 * the reader's zone replaces it after hydration, so the two renders agree and no mismatch is reported. `dateOnly` writes
 * the day alone, with no zone name: until hydration that is the UTC day, as before the move (components/findings). `<time
 * dateTime>` carries the instant itself for anything that reads it.
 */
export function LocalTime({ at, dateOnly = false }: { at: UtcInstant; dateOnly?: boolean }): ReactElement {
  const zone = useSyncExternalStore(subscribe, deviceZone, serverZone);
  const written = dateOnly ? formatDay(at, zone ?? 'UTC') : zone === null ? `${formatDayTime(at, 'UTC')} UTC` : formatDayTime(at, zone);
  return <time dateTime={at}>{written}</time>;
}
