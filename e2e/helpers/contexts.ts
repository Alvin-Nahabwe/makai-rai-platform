import type { Browser, BrowserContext } from '@playwright/test';

/**
 * After each test, closes every open browser context except the `context` fixture's, which Playwright closes after this
 * hook. That is what the test opened, plus any context a `beforeAll` left open (those only seed data, so closing them
 * after the first test changes nothing). Requesting `context` here builds the fixture's context for a test that never
 * used one; that costs one context per such test.
 *
 * Closed contexts still leave their trace files on disk until the worker exits: about 2.3 MB a test, measured locally
 * over 80 tests (497 MB and accelerating without this hook, 187 MB and linear with it).
 *
 * Why (PR 100, run 44891338626): an open context stays alive in the worker for the rest of the run. With
 * `trace: 'retain-on-first-failure'`, every later test records a trace chunk for every live context. One worker runs most
 * of the suite, so the chunks filled the CI runner's disk (ENOSPC) about three quarters of the way through. A failed
 * test's trace also carried every earlier test's pages: stage-end's held 94 contexts.
 *
 * A file that calls `browser.newContext` registers it once, at top level: `test.afterEach(closeOpenedContexts)`.
 * Closing an already closed context is harmless, so a test that closes its own contexts is unaffected.
 */
export async function closeOpenedContexts({ browser, context }: { browser: Browser; context: BrowserContext }): Promise<void> {
  await Promise.all(browser.contexts().filter((c) => c !== context).map((c) => c.close()));
}
