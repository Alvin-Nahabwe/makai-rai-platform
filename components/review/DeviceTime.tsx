'use client';

import { useSyncExternalStore, type ReactElement } from 'react';
import type { StageReviewView } from '@/types/api';
import { formatDay, formatTime } from '@/lib/format/dates';
import { reviewStateLine } from './reviewText';

/**
 * Times in the device's zone (7.5.8, G-11; C4 CR-3). A server page can format only in the server's zone, so these
 * render the server's text first, which hydration matches exactly, and the browser's own text once hydrated
 * (useSyncExternalStore: the server snapshot during hydration, then the client's).
 */
const noSubscribe = () => () => {};

/** A date ("2 Nov 2026") or a date and time ("2 Nov 2026 10:42 EAT") as a `<time>` element. */
export function DeviceDateTime({ iso, form, serverText }: { iso: string; form: 'day' | 'dayTime'; serverText: string }): ReactElement {
  const text = useSyncExternalStore(noSubscribe, () => (form === 'day' ? formatDay(iso) : `${formatDay(iso)} ${formatTime(iso)}`), () => serverText);
  return <time dateTime={iso}>{text}</time>;
}

/** `reviewStateLine` in the device's zone (its "Sealed as seal N on <date>." names a date). */
export function ReviewStateLine({ view, serverText }: { view: StageReviewView; serverText: string }): ReactElement {
  const text = useSyncExternalStore(noSubscribe, () => reviewStateLine(view), () => serverText);
  return <>{text}</>;
}
