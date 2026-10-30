import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import OfflineBanner, { OfflineBannerView, OFFLINE_MESSAGE, readOffline, subscribeConnection } from '@/components/layout/OfflineBanner';

/**
 * M-40, the offline banner (SRS 7.4.1 "Offline or slow", line 2359; 7.6.4 rule
 * 11; the text at SRS line 2582). A shell-wide, polite status message that
 * never blocks a Save, because the browser's offline flag can be wrong.
 */

const M40 =
  'You are offline. Pages already open stay readable. Answers you type are kept on this device until you are back online and press Save or Retry. Opening another question needs a connection. Your answer on this page is kept.';

afterEach(() => vi.unstubAllGlobals());

describe('OfflineBanner', () => {
  it('M-40: the banner text is M-40 exactly, in a polite status region', () => {
    expect(OFFLINE_MESSAGE).toBe(M40);
    const html = renderToStaticMarkup(<OfflineBannerView offline />);
    expect(html).toMatch(/^<div[^>]*role="status"/);
    expect(html).toContain(M40);
    // Polite, never assertive: a lost connection is not a failed action.
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('aria-live="assertive"');
  });

  it('M-40: online, the banner renders nothing, so a page has no status region of its own for another message to share', () => {
    // An always-present empty role="status" made `[role="status"]` match two elements on every page, and e2e/auth.spec.ts
    // (strict mode) failed on "Account created. Please sign in." beside it. The banner is the region only while it has text.
    expect(renderToStaticMarkup(<OfflineBannerView offline={false} />)).toBe('');
    expect(renderToStaticMarkup(<OfflineBanner />)).toBe('');
  });

  it('M-40: the server render shows nothing, because the browser flag is read after mount', () => {
    expect(renderToStaticMarkup(<OfflineBanner />)).not.toContain('You are offline');
  });

  it('M-40: the browser flag decides, and the online and offline events re-read it', () => {
    const fakeWindow = new EventTarget();
    const nav = { onLine: true };
    vi.stubGlobal('window', fakeWindow);
    vi.stubGlobal('navigator', nav);

    expect(readOffline()).toBe(false);
    nav.onLine = false;
    expect(readOffline()).toBe(true);

    const seen: string[] = [];
    const unsubscribe = subscribeConnection(() => seen.push(readOffline() ? 'offline' : 'online'));
    fakeWindow.dispatchEvent(new Event('offline'));
    nav.onLine = true;
    fakeWindow.dispatchEvent(new Event('online'));
    expect(seen).toEqual(['offline', 'online']);

    unsubscribe();
    fakeWindow.dispatchEvent(new Event('offline'));
    expect(seen).toEqual(['offline', 'online']);
  });

  it('M-40: the banner is plain flow content, so it cannot cover a focused control or block a Save', () => {
    const html = renderToStaticMarkup(<OfflineBannerView offline />);
    expect(html).not.toMatch(/position:\s*(fixed|sticky)/);
    expect(html).not.toContain('<button');
    expect(html).not.toContain('disabled');
  });
});
