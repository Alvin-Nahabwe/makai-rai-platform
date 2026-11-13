/**
 * Whether the development gallery `/dev/ui-kit` is served (plan 1A Task 3; register row "development-only route
 * `/dev/ui-kit`"). It is shown only where NODE_ENV says development or test, or where the test seam is open; a
 * production build, and an unset or unknown NODE_ENV, are refused (it fails closed). Playwright's server sets
 * `MAKRAI_TEST_SEAMS=1` (playwright.config.ts), CI runs that server as a production build, and only the exact string
 * '1' opens the seam, as `lib/auth/idle.ts` and `lib/content/root.ts` read it. `__tests__/lint/test-seams.test.ts`
 * keeps the variable out of every file that builds or deploys the production image, so the page is 404 there.
 *
 * Takes the environment as an argument so the page reads it per request (after `connection()`), never at build.
 */
export function devGalleryShown(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NODE_ENV === 'development' || env.NODE_ENV === 'test' || env.MAKRAI_TEST_SEAMS === '1';
}
