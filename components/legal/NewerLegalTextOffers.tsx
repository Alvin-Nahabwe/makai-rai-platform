'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { formatDay } from '@/lib/format/dates';
import type { AcceptedKind } from '@/types/legal';

/**
 * The client half of M-39 (SRS 7.5.7; FR-ACC-04): one notice per newer offered text, with Read and accept (S-05 in
 * offer mode) and Not now. Not now hides that notice for this account, kind and version for the rest of the browser
 * session (sessionStorage), so a still newer version shows again. Every storage access is in a try: a storage that is
 * blocked or full only means the notice shows again. NewerLegalTextNotice (the server half) reads what is offered.
 */

export interface OfferedText { kind: AcceptedKind; version: string; publishedOn: string }

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

const TARGET: CSSProperties = { minWidth: '24px', minHeight: '24px', display: 'inline-block' };
const NOTICE: CSSProperties = {
  marginBottom: 'var(--space-3)', padding: 'var(--space-3) var(--space-4)', background: 'var(--tint-info-bg)', color: 'var(--tint-info-fg)',
  borderRadius: 'var(--border-radius-sm)', fontSize: 'var(--font-size-sm)',
};
const LINK_AS_BUTTON: CSSProperties = {
  ...TARGET, background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', textDecoration: 'underline', cursor: 'pointer',
};

/** The notices for a given state: every offer not in `hidden`, each with Read and accept and Not now. */
export function NewerLegalTextOffersView({ offers, hidden, onNotNow }: {
  offers: OfferedText[]; hidden: ReadonlySet<string>; onNotNow: (offer: OfferedText) => void;
}) {
  const shown = offers.filter((o) => !hidden.has(`${o.kind}:${o.version}`));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((o) => (
        <div key={`${o.kind}:${o.version}`} role="status" style={NOTICE}>
          {`A new version of the ${LEGAL_KIND_NAMES[o.kind]} was published on ${formatDay(o.publishedOn)}. `}
          <a href="/acceptances" style={{ ...TARGET, color: 'inherit' }}>Read and accept</a>{' '}
          <button type="button" style={LINK_AS_BUTTON} onClick={() => onNotNow(o)}>Not now</button>
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
