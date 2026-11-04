import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, expect, request as pwRequest, type Browser } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { addProject, buildOrg } from '../__tests__/helpers/recordFixture';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { abortIfPendingBackground } from './helpers/pendingLinks';
import type { PerfManifest } from '../scripts/load/seed-perf-fixture';

/**
 * NFR-PERF-02 (SRS line 3195): the full first-visit transfer (HTML, page data, CSS, JavaScript, fonts, images) is at
 * most 300 KB for S-11 and S-12 with a stage of 28 questions, and at most 220 KB for every public page; KB is decimal
 * (SRS 7.5.8), so 300000 and 220000 bytes.
 *
 * Each page is opened in a fresh context, so the cache is empty, and measured from navigation to `networkidle`. The
 * count is the sum of CDP `Network.loadingFinished` `encodedDataLength` over the page's requests (ASSUMPTION, stated for
 * the reviewer: the field counts the bytes received including headers); the sum of Playwright's per-request
 * `sizes()` (body plus headers) is printed beside it so the two can be compared. A background request to a shell link
 * whose page is not built yet (e2e/helpers/pendingLinks.ts) is aborted, as every networkidle spec does while the list
 * has entries: a Link prefetch of a 404 never settles in a production build, and an aborted request transfers no body.
 *
 * Run on the production build (`npm run build`, then Playwright with CI=1, which serves `next start`); a dev build's
 * bundles are not what ships. Each case first checks the page it landed on, so a redirect to /login cannot pass a
 * budget (R16-1).
 */

const S11_BUDGET = 300_000;
const PUBLIC_BUDGET = 220_000;
/** The sign-in rate limit keys on the client address (e2e/fixtures/auth.setup.ts), so these sign-ins get their own. */
const SIGN_IN_IP = '10.47.0.1';
const ACCEPTANCES_IP = '10.47.0.2';
/** Where a sign-in lands: the dashboard, or the organisation picker for an account with no last organisation. */
const SIGNED_IN = /^\/(orgs\/[^/]+\/dashboard)?$/;

type Measured = { landed: string; status: number; total: number; sizes: number; bodies: number; failed: string[] };

/**
 * Opens `path` in a fresh context and counts every byte it received until the network was idle. A request that failed,
 * other than a background request this function aborted on purpose, is returned in `failed`: its bytes are not counted,
 * so a page whose chunks did not load would otherwise come in under budget because it broke.
 */
async function measure(browser: Browser, baseURL: string, path: string, storageState?: string): Promise<Measured> {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, storageState });
  try {
    const aborted = new Set<string>();
    await context.route('**/*', async (route) => {
      if (await abortIfPendingBackground(route)) aborted.add(route.request().url());
      else await route.fallback();
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    let total = 0;
    cdp.on('Network.loadingFinished', (e) => { total += e.encodedDataLength; });
    const sizes: Promise<{ body: number; headers: number }>[] = [];
    page.on('requestfinished', (r) => { sizes.push(r.sizes().then((s) => ({ body: s.responseBodySize, headers: s.responseHeadersSize }))); });
    const failed: string[] = [];
    page.on('requestfailed', (r) => { if (!aborted.has(r.url())) failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`); });
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    if (!res) throw new Error(`${path}: the navigation returned no response`);
    const landed = new URL(page.url()).pathname;
    const each = await Promise.all(sizes);
    const bodies = each.reduce((a, b) => a + b.body, 0);
    return { landed, status: res.status(), total, sizes: bodies + each.reduce((a, b) => a + b.headers, 0), bodies, failed };
  } finally {
    await context.close();
  }
}

/** The checks every measurement passes before its bytes are compared: the page asked for, rendered, with nothing failed. */
function expectRendered(m: Measured, path: string, expected: string, shown: string): void {
  expect(m.landed, `${shown}: landed on the measured page, not /login`).toBe(expected);
  expect(m.status, `${shown}: the document status (a not-found or error page renders at the same address)`).toBe(200);
  expect(m.failed, `${shown}: requests that failed`).toEqual([]);
}

/** `shown` is the route template where the address holds a token, so the log carries no live invitation token. */
function report(shown: string, m: Measured, budget: number): void {
  console.log(`route=${shown} bytes=${m.total} budget=${budget} status=${m.status} playwright_sizes=${m.sizes} bodies_only=${m.bodies}`);
}

/** Signs `account` in on the form in a context of its own and saves its storage state at `path`. */
async function signInAndSave(browser: Browser, baseURL: string, account: { email: string; password: string }, path: string,
  clientIp: string, landsOn: RegExp): Promise<void> {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    try {
      await page.waitForURL((u) => landsOn.test(u.pathname), { timeout: 15_000 });   // inside the hook's time, so the reason below is reported
    } catch (e) {
      const alert = await page.getByRole('alert').allTextContents();
      throw new Error(`sign-in did not reach ${landsOn} (at ${new URL(page.url()).pathname}; alert: ${JSON.stringify(alert)}): ${String(e)}`);
    }
    await context.storageState({ path });
  } finally {
    await context.close();
  }
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('the signed-in budget', () => {
  let storageState: string;
  let s11: string;
  let s12: string;

  test.beforeAll(async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    if (process.env.PERF_S11_PATH) {
      // The image run (V Task 3 Step 2): the seeded organisation of scripts/load/seed-perf-fixture.ts and the real content.
      if (!process.env.PERF_S12_PATH || !process.env.PERF_MANIFEST) throw new Error('PERF_S11_PATH needs PERF_S12_PATH and PERF_MANIFEST');
      const m = JSON.parse(readFileSync(process.env.PERF_MANIFEST, 'utf8')) as PerfManifest;
      const owner = m.users.find((u) => u.role === 'owner');
      if (!owner) throw new Error(`${process.env.PERF_MANIFEST} has no owner user`);
      if (!existsSync(owner.storageStatePath)) throw new Error('run the image-setup project first');
      storageState = owner.storageStatePath;
      s11 = process.env.PERF_S11_PATH;
      s12 = process.env.PERF_S12_PATH;
      return;
    }
    // The default run: a fixture organisation on the fixture content, whose 28-question stage is post-processing (SRS line 365).
    const fx = await buildOrg({ label: 'first-visit' });
    const project = await addProject(fx, { name: 'First visit' });
    storageState = 'test-results/first-visit-owner.json';
    // A signed-in account lands on its dashboard, or on the organisation picker at `/` when it has no last organisation
    // yet (app/page.tsx, lib/org-dispatch.ts:17-31), as a fresh fixture owner has not.
    await signInAndSave(browser, baseURL, fx.members.owner, storageState, SIGN_IN_IP, SIGNED_IN);
    s11 = `/orgs/${fx.org.slug}/projects/${project.id}/stages/post-processing`;
    s12 = `${s11}/questions/Q-PO-01`;
  });

  test('NFR-PERF-02: S-11 and S-12 of a 28-question stage transfer at most 300 KB on first visit', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    for (const path of [s11, s12]) {
      const m = await measure(browser, baseURL, path, storageState);
      report(path, m, S11_BUDGET);
      expectRendered(m, path, path, path);
      expect(m.total, `${path} first-visit bytes`).toBeLessThanOrEqual(S11_BUDGET);
    }
  });
});

test.describe('the public budget', () => {
  /** Page files that answer with a permanent redirect; the visit lands on the target (ACC-a). */
  const REDIRECTS_TO: Record<string, string> = { '/terms': '/legal/terms', '/privacy': '/legal/privacy' };
  const S05 = 'app/(authenticated)/acceptances/page.tsx';
  let token: string;
  let acceptancesState: string;

  /** Every public page file git knows, plus S-05: generated from disk so a new public page is measured without an edit. */
  function publicPages(): string[] {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'app/(public)/**/page.tsx'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    if (files.length === 0) throw new Error('git ls-files found no page under app/(public)');
    return [...files, S05];
  }

  function pathFor(file: string): string {
    const template = '/' + file.replace(/^app\//, '').replace(/\/?page\.tsx$/, '').split('/').filter((s) => s && !/^\(.+\)$/.test(s)).join('/');
    return template.replace(/\[([^\]]+)\]/g, (_w, name: string) => {
      if (name === 'token') return token;
      if (name === 'kind') return 'terms';
      if (name === 'version') return '1';
      throw new Error(`${file}: dynamic segment [${name}] has no value in this spec`);
    });
  }

  test.beforeAll(async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    // [token]: an invitation made over route 25 by a fixture owner; the raw token is only in the create response.
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
    const org = manifest.orgs[0];
    const owner = manifest.users.find((u) => u.orgSlug === org.slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error(`no owner seat for ${org.slug} in ${MANIFEST_PATH}`);
    const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath });
    try {
      const res = await api.post(`/api/v1/orgs/${org.slug}/members`, {
        data: { requestId: randomUUID(), email: `first-visit-${Date.now()}@fixture.test`, role: 'viewer', showLink: true },
      });
      if (res.status() !== 201) throw new Error(`invitation create answered ${res.status()}: ${await res.text()}`);
      const body = (await res.json()) as { acceptUrl?: string | null };
      if (typeof body.acceptUrl !== 'string') throw new Error(`invitation create answered acceptUrl ${JSON.stringify(body.acceptUrl)}: stop and report`);
      const found = /^\/invitations\/([^/]+)$/.exec(new URL(body.acceptUrl, baseURL).pathname);
      if (!found) throw new Error('invitation create answered an acceptUrl whose path is not /invitations/<token>: stop and report');
      token = found[1];
    } finally {
      await api.dispose();
    }
    // S-05 renders only for an account missing a v1 acceptance (FR-ACC-04); any other visitor is sent elsewhere, so it
    // is measured signed in as such an account, and the landing check below makes sure it was S-05 that was counted.
    const unaccepted = (await buildOrg({ label: 'first-visit-s05', acceptances: 'pre-v1' })).members.viewer;
    acceptancesState = 'test-results/first-visit-unaccepted.json';
    await signInAndSave(browser, baseURL, unaccepted, acceptancesState, ACCEPTANCES_IP, /^\/acceptances$/);
  });

  test('NFR-PERF-02: every public page transfers at most 220 KB on first visit', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const over: string[] = [];
    for (const file of publicPages()) {
      const path = pathFor(file);
      const shown = path.includes(token) ? path.replace(token, '[token]') : path;
      const m = await measure(browser, baseURL, path, file === S05 ? acceptancesState : undefined);
      report(shown, m, PUBLIC_BUDGET);
      expectRendered(m, path, REDIRECTS_TO[path] ?? path, shown);
      if (m.total > PUBLIC_BUDGET) over.push(`${shown} ${m.total}`);
    }
    expect(over, 'public pages over 220000 bytes').toEqual([]);
  });
});
