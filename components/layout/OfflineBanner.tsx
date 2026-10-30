'use client';

import { useSyncExternalStore } from 'react';

/** M-40, copied exactly from SRS 7.5 (records/plans/2026-10-28-v1-srs.md:2582). */
export const OFFLINE_MESSAGE =
  'You are offline. Pages already open stay readable. Answers you type are kept on this device until you are back online and press Save or Retry. Opening another question needs a connection. Your answer on this page is kept.';

/** True when the browser says it has no connection. Read only in the browser. */
export function readOffline(): boolean {
  return !navigator.onLine;
}

/** Calls `onChange` when the browser's connection state changes; returns the unsubscribe. */
export function subscribeConnection(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/**
 * The banner is a polite status region (WCAG 4.1.3) only while it has text; online it renders nothing. A permanent empty
 * `role="status"` would sit on every page beside the status messages of the screens (a saved or created confirmation), and a test
 * or a script that looks for "the" status region would find two. It is ordinary flow content: nothing fixed or sticky that could
 * cover a focused control, and nothing disabled, because the browser's offline flag can be wrong and a Save is still attempted
 * (SRS 7.4.1 "Offline or slow").
 */
export function OfflineBannerView({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return (
    <div role="status" className="offline-banner">
      <p className="offline-banner__text">{OFFLINE_MESSAGE}</p>
    </div>
  );
}

/**
 * M-40, the shell-wide offline banner (UX state "Offline or slow", SRS 7.4.1;
 * 7.6.4 rule 11). The server snapshot is "online", so the server render and the
 * first client render show nothing and hydration matches; the browser flag is
 * read after that.
 */
export default function OfflineBanner() {
  const offline = useSyncExternalStore(subscribeConnection, readOffline, () => false);
  return <OfflineBannerView offline={offline} />;
}
