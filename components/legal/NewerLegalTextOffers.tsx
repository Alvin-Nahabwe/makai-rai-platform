'use client';

import { useEffect, useState } from 'react';
import { NOTICE_COPY } from '@/lib/legal/notice/copy';
import { formatDay } from '@/lib/format/dates';
import type { AcceptedKind } from '@/types/legal';
import { Banner } from '@/components/ui/Banner';
import { Button, ButtonLink } from '@/components/ui/Button';

/**
 * The client half of M-39 (SRS 7.5.7; FR-ACC-04): one notice per newer offered text, with Read and accept (S-05 in
 * offer mode) and Not now. Not now hides that notice for this account, kind and version for the rest of the browser
 * session (sessionStorage), so a still newer version shows again. Every storage access is in a try: a storage that is
 * blocked or full only means the notice shows again. NewerLegalTextNotice (the server half) reads what is offered.
 */

/** `name` is the text's name as running text ("privacy notice"), read on the server so this client file imports no list of names. */
export interface OfferedText { kind: AcceptedKind; name: string; version: string; publishedOn: string }

/** The sessionStorage key of one Not now choice. */
export function notNowKey(userId: string, kind: string, version: string): string {
  return `makrai.legal.notNow:${userId}:${kind}:${version}`;
}

/** Whether Not now was chosen for this text in this session; false when storage is missing or throws. */
export function isNotNow(storage: Storage | null, userId: string, kind: string, version: string): boolean {
  try {
    return storage?.getItem(notNowKey(userId, kind, version)) === '1';
  } catch {
    return false;   // storage unavailable: the notice shows again
  }
}

/** Keeps the Not now choice; a storage that throws keeps nothing, and the notice shows again next page. */
export function rememberNotNow(storage: Storage | null, userId: string, kind: string, version: string): void {
  try {
    storage?.setItem(notNowKey(userId, kind, version), '1');
  } catch {
    // storage unavailable: nothing is kept
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The notices for a given state: every offer not in `hidden`, each with Read and accept and Not now. */
export function NewerLegalTextOffersView({ offers, hidden, onNotNow }: {
  offers: OfferedText[]; hidden: ReadonlySet<string>; onNotNow: (offer: OfferedText) => void;
}) {
  const shown = offers.filter((o) => !hidden.has(`${o.kind}:${o.version}`));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((o) => (
        <div key={`${o.kind}:${o.version}`} role="status">
          <Banner kind="info" action={(
            <>
              <ButtonLink variant="secondary" href="/acceptances">{NOTICE_COPY.readAndAccept}</ButtonLink>{' '}
              <Button variant="quiet" onClick={() => onNotNow(o)}>{NOTICE_COPY.notNow}</Button>
            </>
          )}>
            {NOTICE_COPY.published(o.name, formatDay(o.publishedOn))}
          </Banner>
        </div>
      ))}
    </>
  );
}

/**
 * Renders nothing until mounted: sessionStorage exists only in the browser, so the server cannot know a notice was turned
 * down. Waiting means a turned-down notice never paints; a notice not turned down appears just after hydration (a polite
 * status, so the delay costs nothing a reader needs).
 */
export function NewerLegalTextOffers({ userId, offers }: { userId: string; offers: OfferedText[] }) {
  const [state, setState] = useState<{ mounted: boolean; hidden: ReadonlySet<string> }>(() => ({ mounted: false, hidden: new Set() }));
  useEffect(() => {
    const storage = sessionStorageOrNull();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage exists only in the browser, after hydration
    setState({ mounted: true, hidden: new Set(offers.filter((o) => isNotNow(storage, userId, o.kind, o.version)).map((o) => `${o.kind}:${o.version}`)) });
  }, [userId, offers]);

  if (!state.mounted) return null;
  return (
    <NewerLegalTextOffersView offers={offers} hidden={state.hidden} onNotNow={(o) => {
      rememberNotNow(sessionStorageOrNull(), userId, o.kind, o.version);
      setState((prev) => ({ mounted: true, hidden: new Set(prev.hidden).add(`${o.kind}:${o.version}`) }));
    }} />
  );
}
