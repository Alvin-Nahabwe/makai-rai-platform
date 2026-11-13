import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UiKitPage, { metadata } from '@/app/dev/ui-kit/page';
import { devGalleryShown } from '@/lib/ui/devGallery';

/** Outside a request Next's `connection()` throws; here it stands for the request and records that the page waited for one. */
const connection = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('next/server', async (actual) => ({ ...(await actual<typeof import('next/server')>()), connection }));

/**
 * Plan 1A Task 3, lane ruling L1: the development gallery /dev/ui-kit answers 404 in production. The test server
 * Playwright starts sets MAKRAI_TEST_SEAMS=1 (playwright.config.ts), which only the exact string '1' opens, as
 * lib/auth/idle.ts and lib/content/root.ts read it; __tests__/lint/test-seams.test.ts keeps it out of the production image.
 */

describe('devGalleryShown', () => {
  it('production without the seam is refused', () => expect(devGalleryShown({ NODE_ENV: 'production' })).toBe(false));
  it('production with the seam set to 1 is shown', () => expect(devGalleryShown({ NODE_ENV: 'production', MAKRAI_TEST_SEAMS: '1' })).toBe(true));
  it('production with any other seam value is refused', () => {
    for (const value of ['true', '', '0', ' 1', '1 ']) expect(devGalleryShown({ NODE_ENV: 'production', MAKRAI_TEST_SEAMS: value }), JSON.stringify(value)).toBe(false);
  });
  it('development and test are shown', () => {
    expect(devGalleryShown({ NODE_ENV: 'development' })).toBe(true);
    expect(devGalleryShown({ NODE_ENV: 'test' })).toBe(true);
  });
  it('an unset or unknown NODE_ENV is refused without the seam, and shown with it', () => {
    for (const value of [undefined, '', 'staging', 'Production', 'prod']) {
      expect(devGalleryShown({ NODE_ENV: value }), JSON.stringify(value)).toBe(false);
      expect(devGalleryShown({ NODE_ENV: value, MAKRAI_TEST_SEAMS: '1' }), JSON.stringify(value)).toBe(true);
    }
  });
});

/**
 * The page module is imported once, under the test environment, and NODE_ENV is changed only around each call: the page
 * reads the environment when it renders, not when it is loaded (importing React's JSX runtime under 'production' would
 * load its production build, which the test transform does not target).
 */
describe('/dev/ui-kit page', () => {
  afterEach(() => { vi.unstubAllEnvs(); connection.mockClear(); });

  it('in production with no seam the page is Next\'s not-found', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MAKRAI_TEST_SEAMS', undefined);
    await expect(UiKitPage()).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(connection).toHaveBeenCalledOnce();      // the refusal is decided per request, after connection()
  });

  it('with the seam the page renders, with one main landmark and one h1', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MAKRAI_TEST_SEAMS', '1');
    const html = renderToStaticMarkup(await UiKitPage());
    expect(html.match(/<main /g)).toHaveLength(1);
    expect(html).toMatch(/<main [^>]*id="main-content"/);
    expect(html.match(/<h1[ >]/g)).toHaveLength(1);
    expect(metadata.robots).toEqual({ index: false });
  });
});
