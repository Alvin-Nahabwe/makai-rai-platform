import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { abortIfPendingBackground } from './helpers/pendingLinks';

/**
 * NFR-PERF-02 (SRS line 3195): every public page transfers at most 220 KB on a first visit, 220000 bytes. S-04, the
 * invitation page, shows the inviter's name in Source Sans 3 (app/(public)/invitations/[token]/page.tsx). Ugandan
 * and other African names are written with latin-ext letters such as U+014B (Luganda's eng); one such letter used to
 * fetch the whole 60,048 B Source Sans latin-ext file and put the page at 264 KB. The letters names commonly carry now sit in a small
 * face of their own (app/fonts/source-sans-3-latin-ext-common.woff2, scripts/fonts/subset.sh), and this spec measures
 * the page with such a name.
 *
 * The count is every byte the browser received from navigation to `networkidle` in a fresh context, Link prefetches
 * included, as e2e/first-visit-transfer.spec.ts counts it: CDP `Network.loadingFinished` `encodedDataLength` for a
 * request that finished. A Link prefetch can also end aborted (`net::ERR_ABORTED`): on CI's Chrome Headless Shell every
 * prefetch of S-04's links did (run 41948739222), on a local Chrome none did. Such a request gets no
 * `loadingFinished`, so the bytes it did receive are counted from its `responseReceived` header bytes and
 * `dataReceived` chunks (which sum to the `loadingFinished` figure, to within 5 B, for the prefetches that finish).
 * An abandoned prefetch is not a failure of the page; any other failed request is, because its bytes may be missing
 * from the count. A background request to a link whose page is not built yet is aborted by the spec
 * (e2e/helpers/pendingLinks.ts), as every networkidle spec does. Meaningful only on the production build (CI=1 serves
 * `next start`).
 */

/**
 * Whether a failed request is a Link prefetch the browser aborted: `net::ERR_ABORTED`, and either the router's own
 * `next-router-prefetch` header (Next 16.4.2 sets it on every prefetch, node_modules/next/dist/client/components/
 * segment-cache/cache.js) or the `_rsc` query every router request carries.
 */
function isAbandonedPrefetch(url: string, headers: Record<string, string>, errorText: string | undefined): boolean {
  if (errorText !== 'net::ERR_ABORTED') return false;
  return headers['next-router-prefetch'] !== undefined || new URL(url).searchParams.has('_rsc');
}

const PUBLIC_BUDGET = 220_000;
/**
 * Inviter names in three orthographies whose letters sit in the common latin-ext face: Luganda (U+014B), Kikuyu
 * (U+0169, U+0129) and Hausa (U+018A, U+0181). The sign-in rate limit keys on the client address
 * (e2e/fixtures/auth.setup.ts), so each sign-in gets its own.
 */
const CASES = [
  { language: 'Luganda', inviter: 'Ssekandi Nnaŋŋa', letters: 'U+014B', clientIp: '10.66.0.1' },
  { language: 'Kikuyu', inviter: 'Mũthoni Gĩtau', letters: 'U+0169 U+0129', clientIp: '10.66.0.2' },
  { language: 'Hausa', inviter: 'Ɗanjuma Ɓello', letters: 'U+018A U+0181', clientIp: '10.66.0.3' },
] as const;

test.afterAll(async () => {
  await testDb.$disconnect();
});

for (const { language, inviter, letters, clientIp } of CASES) test(`NFR-PERF-02: S-04 with a ${language} inviter name (${letters}) transfers at most 220 KB on first visit, fetching the small latin-ext face only`, async ({ browser }) => {
  test.setTimeout(120_000);
  const baseURL = test.info().project.use.baseURL!;
  const fx = await buildOrg({ label: `name-transfer-${language.toLowerCase()}` });
  await testDb.user.update({ where: { id: fx.members.owner.userId }, data: { name: inviter } });

  // Sign the owner in on the form and create the invitation over route 25, the only place the raw token appears.
  const signIn = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  let token: string;
  try {
    const page = await signIn.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(fx.members.owner.email);
    await page.getByLabel('Password').fill(fx.members.owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => /^\/(orgs\/[^/]+\/dashboard)?$/.test(u.pathname), { timeout: 15_000 });
    const api = await pwRequest.newContext({ baseURL, storageState: await signIn.storageState() });
    try {
      const res = await api.post(`/api/v1/orgs/${fx.org.slug}/members`, {
        data: { requestId: randomUUID(), email: `name-transfer-${language.toLowerCase()}-${Date.now()}@fixture.test`, role: 'viewer', showLink: true },
      });
      expect(res.status(), await res.text()).toBe(201);
      const { acceptUrl } = (await res.json()) as { acceptUrl: string };
      const found = /^\/invitations\/([^/]+)$/.exec(new URL(acceptUrl, baseURL).pathname);
      expect(found, 'acceptUrl is /invitations/<token>').not.toBeNull();
      token = found![1];
    } finally {
      await api.dispose();
    }
  } finally {
    await signIn.close();
  }

  // The first visit, in a fresh context with an empty cache.
  const context = await browser.newContext({ baseURL });
  try {
    const aborted = new Set<string>();
    await context.route('**/*', async (route) => {
      if (await abortIfPendingBackground(route)) aborted.add(route.request().url());
      else await route.fallback();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const urls = new Map<string, string>();
    /** Bytes received so far by each request that has not finished: response headers, then each body chunk. */
    const received = new Map<string, number>();
    let total = 0;
    cdp.on('Network.requestWillBeSent', (e) => { urls.set(e.requestId, e.request.url); });
    cdp.on('Network.responseReceived', (e) => { received.set(e.requestId, (received.get(e.requestId) ?? 0) + e.response.encodedDataLength); });
    cdp.on('Network.dataReceived', (e) => { received.set(e.requestId, (received.get(e.requestId) ?? 0) + e.encodedDataLength); });
    cdp.on('Network.loadingFinished', (e) => { total += e.encodedDataLength; received.delete(e.requestId); });
    // A request that ends without finishing still transferred what it received before it ended.
    cdp.on('Network.loadingFailed', (e) => { total += received.get(e.requestId) ?? 0; received.delete(e.requestId); });
    const failed: string[] = [];
    const abandonedPrefetches: string[] = [];
    page.on('requestfailed', (r) => {
      const errorText = r.failure()?.errorText;
      if (aborted.has(r.url())) return;
      if (isAbandonedPrefetch(r.url(), r.headers(), errorText)) abandonedPrefetches.push(r.url());
      else failed.push(`${r.url()} ${errorText ?? ''}`);
    });
    const path = `/invitations/${token}`;
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    expect(res?.status(), 'the invitation page answered').toBe(200);
    expect(new URL(page.url()).pathname, 'landed on S-04').toBe(path);
    await expect(page.getByText(inviter)).toBeVisible();
    expect(failed, 'requests that failed').toEqual([]);
    const fonts = [...urls.values()].filter((u) => u.endsWith('.woff2')).map((u) => u.split('/').pop()!);
    console.log(`route=/invitations/[token] inviter=${language} bytes=${total} budget=${PUBLIC_BUDGET} abandoned_prefetches=${abandonedPrefetches.length} fonts=${fonts.join(',')}`);
    // The name's letters come from the small face; the large remainder face is not fetched.
    expect(fonts.some((f) => f.startsWith('source_sans_3_latin_ext_common'))).toBe(true);
    expect(fonts.some((f) => f.startsWith('source_sans_3_latin_ext_rest'))).toBe(false);
    expect(total, `first-visit bytes of S-04 with a ${language} inviter name`).toBeLessThanOrEqual(PUBLIC_BUDGET);
  } finally {
    await context.close();
  }
});

test('(harness) NFR-PERF-02: only a prefetch the browser aborted is set aside; any other failure is a failure', () => {
  const prefetch = { 'next-router-prefetch': '1', rsc: '1' };
  // The case CI saw (run 41948739222): Next's Link prefetches, aborted.
  expect(isAbandonedPrefetch('http://localhost:3000/about?_rsc=hdgmOKhmcHuha3Zk', prefetch, 'net::ERR_ABORTED')).toBe(true);
  expect(isAbandonedPrefetch('http://localhost:3000/login?_rsc=AA3', {}, 'net::ERR_ABORTED')).toBe(true);
  // A prefetch that failed some other way, a page asset that was aborted, and the document itself are failures.
  expect(isAbandonedPrefetch('http://localhost:3000/about?_rsc=x', prefetch, 'net::ERR_CONNECTION_REFUSED')).toBe(false);
  expect(isAbandonedPrefetch('http://localhost:3000/_next/static/chunks/a.js', {}, 'net::ERR_ABORTED')).toBe(false);
  expect(isAbandonedPrefetch('http://localhost:3000/invitations/abc', {}, 'net::ERR_ABORTED')).toBe(false);
  expect(isAbandonedPrefetch('http://localhost:3000/_next/static/media/x.woff2', {}, undefined)).toBe(false);
});
