import { NonLoopbackRequestError, takeRefusals } from './helpers/loopbackGuard';
import { expect, test } from './helpers/loopbackOnly';

/**
 * FIX-2: the guard of helpers/loopbackOnly.ts in a real browser. route.fetch() and page.request are the two Node-side
 * calls V session 1's lost-reply case could have used; both must refuse a host off this machine before connecting.
 * Nothing here leaves the machine: the page's one request is intercepted by the route and fulfilled in the browser
 * (it never reaches the port), and guard.invalid (RFC 6761) never resolves. Each test takes the refusals it caused,
 * which loopbackOnly.ts would otherwise turn into a failure.
 */
const INVALID = 'https://guard.invalid/api/v1/orgs/x/projects/y/decisions';

test('NFR-SEC-17 FIX-2: route.fetch to a host off this machine throws before it is sent', async ({ page, baseURL }) => {
  const probe = `${baseURL}/fix-2-probe`;
  let refused: unknown;
  await page.route(probe, async (route) => {
    refused = await route.fetch({ url: INVALID, maxRedirects: 0 }).then(() => 'sent', (e: unknown) => e);
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'probe' });   // not 204: Chromium aborts a navigation answered 204
  });
  await page.goto(probe);
  expect(refused).toBeInstanceOf(NonLoopbackRequestError);
  expect(takeRefusals()).toHaveLength(1);
});

test('NFR-SEC-17 FIX-2: page.request, context.request and the request fixture refuse a host off this machine', async ({ page, request }) => {
  await expect(page.request.post(INVALID, { data: { reason: 'probe' }, maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
  await expect(request.get(INVALID, { maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
  await expect(page.context().request.get(INVALID, { maxRedirects: 0 })).rejects.toThrow(NonLoopbackRequestError);
  expect(takeRefusals()).toHaveLength(3);
});

test('NFR-SEC-17 FIX-2: a relative path and a redirect-following request are refused, whatever the host', async ({ request, baseURL }) => {
  await expect(request.get('/api/health', { maxRedirects: 0 })).rejects.toThrow(/not an absolute URL/);
  await expect(request.get(`${baseURL}/api/health`)).rejects.toThrow(/maxRedirects: 0/);
  expect(takeRefusals()).toHaveLength(2);
});

test('NFR-SEC-17 FIX-2: a test that catches a refusal still fails', async ({ request }) => {
  test.fail(true, 'loopbackOnly.ts fails a test that left a refusal untaken, so a spec cannot swallow one');
  await request.get(INVALID, { maxRedirects: 0 }).catch(() => undefined);
});
