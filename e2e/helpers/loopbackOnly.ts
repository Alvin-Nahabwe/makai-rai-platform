import { test as base, expect } from '@playwright/test';
import { installLoopbackGuard, takeRefusals } from './loopbackGuard';

/**
 * Playwright's `test`, with e2e/helpers/loopbackGuard.ts installed for the whole worker before any test or hook runs:
 * a request from Playwright's Node side (route.fetch, page.request, context.request, the request fixture,
 * request.newContext) or Node's fetch that could leave this machine throws NonLoopbackRequestError instead of being
 * sent. A test during which any request was refused fails at its end, even if the spec caught the error. Every file an
 * image config runs takes `test` from here (__tests__/lint/e2e-loopback-guard.test.ts).
 */
export const test = base.extend<{ loopbackRefusals: void }, { loopbackGuard: void }>({
  loopbackGuard: [
    async ({ playwright }, use) => {
      const restore = await installLoopbackGuard(playwright.request);
      await use();
      restore();
    },
    { scope: 'worker', auto: true },
  ],
  loopbackRefusals: [
    async ({}, use) => {
      await use();
      const refused = takeRefusals();
      if (refused.length > 0) throw new Error(`Node-side requests were refused during this test:\n${refused.join('\n')}`);
    },
    { auto: true },
  ],
});

export { expect };
