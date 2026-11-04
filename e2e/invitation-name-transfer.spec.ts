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
 * The count is the sum of CDP `Network.loadingFinished` `encodedDataLength` over every request from navigation to
 * `networkidle` in a fresh context, as e2e/first-visit-transfer.spec.ts counts it. A background request to a link whose
 * page is not built yet is aborted (e2e/helpers/pendingLinks.ts), as every networkidle spec does. Meaningful only on the
 * production build (CI=1 serves `next start`).
 */

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
    let total = 0;
    cdp.on('Network.requestWillBeSent', (e) => { urls.set(e.requestId, e.request.url); });
    cdp.on('Network.loadingFinished', (e) => { total += e.encodedDataLength; });
    const failed: string[] = [];
    // A failed request's bytes are not counted, so a page whose chunks did not load would pass by breaking.
    page.on('requestfailed', (r) => { if (!aborted.has(r.url())) failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`); });
    const path = `/invitations/${token}`;
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    expect(res?.status(), 'the invitation page answered').toBe(200);
    expect(new URL(page.url()).pathname, 'landed on S-04').toBe(path);
    await expect(page.getByText(inviter)).toBeVisible();
    expect(failed, 'requests that failed').toEqual([]);
    const fonts = [...urls.values()].filter((u) => u.endsWith('.woff2')).map((u) => u.split('/').pop()!);
    console.log(`route=/invitations/[token] inviter=${language} bytes=${total} budget=${PUBLIC_BUDGET} fonts=${fonts.join(',')}`);
    // The name's letters come from the small face; the large remainder face is not fetched.
    expect(fonts.some((f) => f.startsWith('source_sans_3_latin_ext_common'))).toBe(true);
    expect(fonts.some((f) => f.startsWith('source_sans_3_latin_ext_rest'))).toBe(false);
    expect(total, `first-visit bytes of S-04 with a ${language} inviter name`).toBeLessThanOrEqual(PUBLIC_BUDGET);
  } finally {
    await context.close();
  }
});
