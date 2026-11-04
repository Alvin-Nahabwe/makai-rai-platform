'use client';

import { useSyncExternalStore } from 'react';

/** M-40, copied exactly from SRS 7.5 (the offline message, line 2582 of the SRS). */
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
 * The banner is a polite status region (WCAG 4.1.3). The region is always in the page, empty while online, and the text is put
 * inside it when the connection is lost: a live region that is inserted already holding its text is often not announced. Pages
 * with a status message of their own (a saved or created confirmation) therefore have two `role="status"` elements; a test that
 * looks for one scopes itself to its own message. The banner is ordinary flow content: nothing fixed or sticky that could cover a
 * focused control, and nothing disabled, because the browser's offline flag can be wrong and a Save is still attempted
 * (SRS 7.4.1 "Offline or slow").
 */
export function OfflineBannerView({ offline }: { offline: boolean }) {
  return (
    <div role="status" className="offline-banner-region">
      {offline ? (
        <div className="offline-banner">
          <p className="offline-banner__text">{OFFLINE_MESSAGE}</p>
        </div>
      ) : null}
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
