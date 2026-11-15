import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
// The loopback guard: an image config runs this file, and a Node-side request there would reach the public makrai.org.
import { test, expect } from './helpers/loopbackOnly';
import { testDb } from '../__tests__/helpers/db';
import { addProject, buildOrg } from '../__tests__/helpers/recordFixture';
import { abortIfPendingBackground } from './helpers/pendingLinks';
import { signInWith } from './helpers/session';
import type { PerfManifest } from '../scripts/load/seed-perf-fixture';

/**
 * NFR-PERF-02 (SRS line 3195): the full first-visit transfer (HTML, page data, CSS, JavaScript, fonts, images) is at
 * most 300 KB for S-11 and S-12 with a stage of 28 questions, and at most 220 KB for every public page; KB is decimal
 * (SRS 7.5.8), so 300000 and 220000 bytes.
 *
 * Each page is opened in a fresh context, so the cache is empty, and measured from navigation to `networkidle`. The
 * count is every byte the browser received, Link prefetches included, the rule PERF's e2e/invitation-name-transfer.spec.ts
 * uses: CDP `Network.loadingFinished` `encodedDataLength` for a request that finished (headers included), and, for one
 * that ended without finishing, the bytes it did receive (its `responseReceived` header bytes and `dataReceived` chunks).
 * A Link prefetch the browser aborted (`net::ERR_ABORTED` with the router's prefetch header or `_rsc` query; CI's Chrome
 * Headless Shell aborts them, a local Chrome does not) is an abandoned prefetch, not a failure; any other failed request
 * is a failure, because its bytes may be missing from the count. Playwright's `sizes()` total over finished requests and a
 * bodies-only figure are printed beside it. A background request to a shell link whose page is not built yet
 * (e2e/helpers/pendingLinks.ts) is aborted by the spec, as every networkidle spec does.
 *
 * Budgets as the owner ruled them (owner-questions.md, decision of 6 Nov, verbatim "Production + 1 KB (Recommended)",
 * which supersedes the earlier figures): 220000 for every public page with the fixture's plain names; S-04 with an
 * accented organisation name (set in Overpass, which then fetches its latin_rest file) and S-05 are accepted risks with
 * their own limits, below (LIMITS). S-05 is not a public page (it renders only for a signed-in account missing an
 * acceptance), so no SRS budget binds it; the owner's limit does.
 *
 * Run on the production build (`npm run build`, then Playwright with CI=1, which serves `next start`); a dev build's
 * bundles are not what ships. Each case first checks the page it landed on, so a redirect to /login cannot pass a
 * budget (R16-1). The same file runs behind the production nginx configuration under playwright.perf-nginx.config.ts
 * (baseURL https://makrai.org, mapped to the local nginx by the browser), which counts what nginx sends; the log line
 * names the document's protocol (h2 once default.conf enables HTTP/2 on 443). So that no request can leave the machine
 * by resolving makrai.org through DNS, every request here goes through the browser, the setup calls included (`apiPost`).
 */

const S11_BUDGET = 300_000;
// The owner's ruling of 15 Nov 2026, 20:50 EAT (box): S-12, the question page, may transfer 315,000 B on first visit; S-11
// keeps 300,000. S-12 measured 312,535 B on lane 8's head e422129c, over 300,000 since lane 2's decision card (integration
// 70460e70: JS +7,886, CSS +4,839, HTML +784); nothing was trimmed.
const S12_BUDGET = 315_000;
const PUBLIC_BUDGET = 220_000;
/** S-04's own first-visit limit, plain names: owner's ruling of 15 Nov 2026 15:35 (box: "Raise the limit ~4 KB"): 224,000 B. */
const S04_BUDGET = 224_000;
/** The /help page's own first-visit limit: owner's ruling of 15 Nov 2026 18:28: 223,000 B. */
const HELP_BUDGET = 223_000;
/** The sign-in rate limit keys on the client address (e2e/fixtures/auth.setup.ts), so these sign-ins get their own. */
const SIGN_IN_IP = '10.47.0.1';
const ACCEPTANCES_IP = '10.47.0.2';
const ACCENTS_IP = '10.47.0.3';
const PUBLIC_OWNER_IP = '10.47.0.4';
/** Where a sign-in lands: the dashboard, or the organisation picker for an account with no last organisation. */
const SIGNED_IN = /^\/(orgs\/[^/]+\/dashboard)?$/;

/**
 * The accepted-risk limits (owner-questions.md, decision of 6 Nov 2026, verbatim "Production + 1 KB (Recommended)").
 * The production limits are the owner's: through nginx on HTTP/2, S-04 with an accented organisation name up to 243700 B
 * (measured 242652 B) and S-05 up to 227800 B (measured 226715 B), each the production figure plus 1 KB for run-to-run
 * spread. The nginx run (playwright.perf-nginx.config.ts, project `perf-nginx`) asserts them. CI's direct run to next
 * start cannot pass through nginx, so it holds the same pages to the direct figures plus 1 KB, 237700 B and 221500 B, as a
 * regression guard (the controller's implementation of the same ruling); those are not the owner's limits.
 */
const LIMITS = {
  nginx: { s04Accented: 243_700, s05: 227_800 },     // the owner's production limits, through nginx on HTTP/2 (6 Nov)
  direct: { s04Accented: 241_500, s05: 221_500 },    // regression guard for the direct run; S-04 accented raised by the owner, 15 Nov 15:35 (box: Raise the limit ~4 KB); S-05 as of 6 Nov
} as const;
/** S-04 rendered the invitation: its heading, not the "Invitation" page of an unusable link (app/(public)/invitations/[token]/page.tsx). */
async function invitedHeading(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: /^You are invited to / })).toBeVisible();
}

/**
 * A failure of the S-04 accented or S-05 case against these limits is a page-weight change, which goes to the owner; it is
 * not a flake to retry or a limit to raise (the ruling above).
 */
/** The limits for the run in progress: the nginx config's project, or any other (the direct run). */
const limits = () => (test.info().project.name === 'perf-nginx' ? LIMITS.nginx : LIMITS.direct);

type Measured = {
  landed: string; status: number; protocol: string; total: number; sizes: number; bodies: number; failed: string[];
  abandonedPrefetches: number; fonts: string[]; redirectHops: number;
};

/**
 * A POST from inside the signed-in context's page, so it goes through the browser's resolver (and, behind nginx, its
 * host mapping) with the page's own origin and cookies; a Node request context would resolve the name through DNS.
 */
async function apiPost(context: BrowserContext, path: string, data: unknown): Promise<{ status: number; body: unknown; text: string }> {
  const page = await context.newPage();
  try {
    await page.goto('/api/health');
    return await page.evaluate(async ({ path, data }) => {
      const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      const text = await r.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { /* not JSON: the caller reports the status and the text */ }
      return { status: r.status, body, text };
    }, { path, data });
  } finally {
    await page.close();
  }
}

/** An invitation over route 25 from `context` (an owner's session); the raw token is only in the create response. */
async function invitationPath(context: BrowserContext, slug: string, label: string): Promise<string> {
  const res = await apiPost(context, `/api/v1/orgs/${slug}/members`,
    { requestId: randomUUID(), email: `${label}-${Date.now()}@fixture.test`, role: 'viewer', showLink: true });
  if (res.status !== 201) throw new Error(`invitation create answered ${res.status}: ${res.text}`);
  const acceptUrl = (res.body as { acceptUrl?: string | null } | null)?.acceptUrl;
  if (typeof acceptUrl !== 'string') throw new Error(`invitation create answered acceptUrl ${JSON.stringify(acceptUrl)}: stop and report`);
  const found = /^\/invitations\/([^/]+)$/.exec(new URL(acceptUrl).pathname);
  if (!found) throw new Error('invitation create answered an acceptUrl whose path is not /invitations/<token>: stop and report');
  return `/invitations/${found[1]}`;
}

/**
 * Whether a failed request is a Link prefetch the browser aborted: `net::ERR_ABORTED`, and either the router's own
 * `next-router-prefetch` header or the `_rsc` query every router request carries. The same rule as PERF's
 * e2e/invitation-name-transfer.spec.ts (unit/perf-ci 127f1b4); a spec file cannot be imported without running its tests.
 */
function isAbandonedPrefetch(url: string, headers: Record<string, string>, errorText: string | undefined): boolean {
  if (errorText !== 'net::ERR_ABORTED') return false;
  return headers['next-router-prefetch'] !== undefined || new URL(url).searchParams.has('_rsc');
}

/**
 * Opens `path` in a fresh context and counts every byte it received until the network was idle. A request that failed,
 * other than a pending-link request this function aborted or a prefetch the browser abandoned, is returned in `failed`.
 */
async function measure(browser: Browser, baseURL: string, path: string, storageState?: string,
  check?: (page: Page) => Promise<void>): Promise<Measured> {
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
    const urls = new Map<string, string>();
    let protocol = 'unknown';
    /** Bytes received so far by each request that has not finished: response headers, then each body chunk. */
    const received = new Map<string, number>();
    let total = 0;
    let redirectHops = 0;
    cdp.on('Network.requestWillBeSent', (e) => {
      urls.set(e.requestId, e.request.url);
      // A redirect's own response is reported here, and loadingFinished then covers only the final hop.
      if (e.redirectResponse) { total += e.redirectResponse.encodedDataLength; redirectHops++; }
    });
    cdp.on('Network.responseReceived', (e) => {
      received.set(e.requestId, (received.get(e.requestId) ?? 0) + e.response.encodedDataLength);
      if (e.type === 'Document') protocol = e.response.protocol ?? 'unknown';   // the last document: a redirect's target, where there is one
    });
    cdp.on('Network.dataReceived', (e) => { received.set(e.requestId, (received.get(e.requestId) ?? 0) + e.encodedDataLength); });
    cdp.on('Network.loadingFinished', (e) => { total += e.encodedDataLength; received.delete(e.requestId); });
    // A request that ends without finishing still transferred what it received before it ended.
    cdp.on('Network.loadingFailed', (e) => { total += received.get(e.requestId) ?? 0; received.delete(e.requestId); });
    const sizes: Promise<{ body: number; headers: number }>[] = [];
    page.on('requestfinished', (r) => { sizes.push(r.sizes().then((s) => ({ body: s.responseBodySize, headers: s.responseHeadersSize }))); });
    const failed: string[] = [];
    let abandonedPrefetches = 0;
    page.on('requestfailed', (r) => {
      const errorText = r.failure()?.errorText;
      if (aborted.has(r.url())) return;
      if (isAbandonedPrefetch(r.url(), r.headers(), errorText)) abandonedPrefetches++;
      else failed.push(`${r.url()} ${errorText ?? ''}`);
    });
    const res = await page.goto(path, { waitUntil: 'networkidle' });
    if (!res) throw new Error(`${path}: the navigation returned no response`);
    const landed = new URL(page.url()).pathname;
    if (check) await check(page);
    const each = await Promise.all(sizes);
    const bodies = each.reduce((a, b) => a + b.body, 0);
    const fonts = [...urls.values()].filter((u) => u.endsWith('.woff2')).map((u) => u.split('/').pop()!);
    return { landed, status: res.status(), protocol, total, sizes: bodies + each.reduce((a, b) => a + b.headers, 0), bodies, failed,
      abandonedPrefetches, fonts, redirectHops };
  } finally {
    await context.close();
  }
}

/** The checks every measurement passes before its bytes are compared: the page asked for, rendered, with nothing failed. */
function expectRendered(m: Measured, path: string, expected: string, shown: string): void {
  expect(m.landed, `${shown}: landed on the measured page, not /login`).toBe(expected);
  expect(m.status, `${shown}: the document status (a not-found or error page renders at the same address)`).toBe(200);
  expect(m.failed, `${shown}: requests that failed`).toEqual([]);
  expect(m.total, `${shown}: CDP counted bytes`).toBeGreaterThan(0);
  expect(m.total, `${shown}: CDP counted at least the bodies Playwright saw`).toBeGreaterThanOrEqual(m.bodies);
  // The nginx run measures what production serves, which is HTTP/2 (default.conf, `http2 on`).
  if (test.info().project.name === 'perf-nginx') expect(m.protocol, `${shown}: the protocol through nginx`).toBe('h2');
}

/** `shown` is the route template where the address holds a token, so the log carries no live invitation token. */
function report(shown: string, m: Measured, budget: number): void {
  console.log(`route=${shown} bytes=${m.total} budget=${budget} status=${m.status} protocol=${m.protocol} playwright_sizes=${m.sizes} bodies_only=${m.bodies}`
    + ` abandoned_prefetches=${m.abandonedPrefetches} redirect_hops=${m.redirectHops} fonts=${m.fonts.join(',')}`);
}

/** Signs `account` in on the form in a context of its own and saves its storage state at `path`. */
async function signInAndSave(browser: Browser, baseURL: string, account: { email: string; password: string }, path: string,
  clientIp: string, landsOn: RegExp): Promise<void> {
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    // A press before hydration posts the form natively and leaves the page on /login (seen on the first sign-in after nginx
    // started), so session.ts's signInWith waits until the typed values survive hydration before it presses Sign in.
    await signInWith(page, account.email, account.password);
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
    // yet (app/(gate)/page.tsx, lib/org-dispatch.ts:17-31), as a fresh fixture owner has not.
    await signInAndSave(browser, baseURL, fx.members.owner, storageState, SIGN_IN_IP, SIGNED_IN);
    s11 = `/orgs/${fx.org.slug}/projects/${project.id}/stages/post-processing`;
    s12 = `${s11}/questions/Q-PO-01`;
  });

  test('NFR-PERF-02: S-11 of a 28-question stage transfers at most 300 KB and S-12 at most 315 KB on first visit', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    for (const [path, budget] of [[s11, S11_BUDGET], [s12, S12_BUDGET]] as const) {
      const m = await measure(browser, baseURL, path, storageState);
      report(path, m, budget);
      expectRendered(m, path, path, path);
      expect(m.total, `${path} first-visit bytes`).toBeLessThanOrEqual(budget);
    }
  });
});

test.describe('the public budget', () => {
  /** Page files that answer with a permanent redirect; the visit lands on the target (ACC-a). */
  const REDIRECTS_TO: Record<string, string> = { '/terms': '/legal/terms', '/privacy': '/legal/privacy' };
  const S05 = 'app/(gate)/acceptances/page.tsx';
  let token: string;
  let acceptancesState: string;

  /** Every public page file git knows: generated from disk so a new public page is measured without an edit. */
  function publicPages(): string[] {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'app/(public)/**/page.tsx'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    if (files.length === 0) throw new Error('git ls-files found no page under app/(public)');
    // Help (plan 1A Task 12): a public page outside the route group, measured signed out like the others (ruling T12-xi).
    return [...files, 'app/help/page.tsx'];
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
    // [token]: an invitation made over route 25 by this file's own fixture owner (plain ASCII names).
    const fx = await buildOrg({ label: 'first-visit-public' });
    const ownerState = 'test-results/first-visit-public-owner.json';
    await signInAndSave(browser, baseURL, fx.members.owner, ownerState, PUBLIC_OWNER_IP, SIGNED_IN);
    const owner = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ownerState });
    try {
      token = (await invitationPath(owner, fx.org.slug, 'first-visit')).replace(/^\/invitations\//, '');
    } finally {
      await owner.close();
    }
    // S-05 renders only for an account missing a v1 acceptance (FR-ACC-04); any other visitor is sent elsewhere, so it
    // is measured signed in as such an account, and the landing check below makes sure it was S-05 that was counted.
    const unaccepted = (await buildOrg({ label: 'first-visit-s05', acceptances: 'pre-v1' })).members.viewer;
    acceptancesState = 'test-results/first-visit-unaccepted.json';
    await signInAndSave(browser, baseURL, unaccepted, acceptancesState, ACCEPTANCES_IP, /^\/acceptances$/);
  });

  test('NFR-PERF-02: every public page transfers at most 220 KB on first visit, and S-04 at most 224 KB', async ({ browser }) => {
    const baseURL = test.info().project.use.baseURL!;
    const over: string[] = [];
    for (const file of publicPages()) {
      const path = pathFor(file);
      const shown = path.includes(token) ? path.replace(token, '[token]') : path;
      // S-04 must be the invitation itself, not its "Invitation" error page, which renders at the same address.
      const check = path.startsWith('/invitations/') ? invitedHeading : undefined;
      const m = await measure(browser, baseURL, path, undefined, check);
      // S-04 has its own limit, raised by the owner (15 Nov 15:35, box: Raise the limit ~4 KB), and /help has its own
      // (owner's ruling of 15 Nov 2026 18:28, 223,000 B); every other page keeps 220,000.
      const budget = path.startsWith('/invitations/') ? S04_BUDGET : path === '/help' ? HELP_BUDGET : PUBLIC_BUDGET;
      report(shown, m, budget);
      expectRendered(m, path, REDIRECTS_TO[path] ?? path, shown);
      if (m.total > budget) over.push(`${shown} ${m.total} (limit ${budget})`);
    }
    expect(over, 'public pages over their limits (220000 B; S-04 224000 B; /help 223000 B)').toEqual([]);
  });

  test('NFR-PERF-02 (ACCEPTED-RISK): S-05, signed in without a v1 acceptance, stays within the owner\'s limit on first visit', async ({ browser }) => {
    // NFR-PERF-02 binds S-11, S-12 and the public pages; S-05 is a signed-in page, so the SRS gives it no transfer budget
    // (NFR-PERF-01's 160 KB first-load JavaScript does, scripts/measure_first_load.mjs). The owner's ruling of 6 Nov
    // ("Production + 1 KB (Recommended)") gives it one: 227800 B through nginx on HTTP/2; 221500 B on the direct run (LIMITS).
    const baseURL = test.info().project.use.baseURL!;
    const path = pathFor(S05);
    const m = await measure(browser, baseURL, path, acceptancesState);
    const limit = limits().s05;
    report(path, m, limit);
    expectRendered(m, path, path, path);
    expect(m.total, `${path} first-visit bytes against the ${test.info().project.name === 'perf-nginx' ? 'production limit' : 'direct-run guard'}`).toBeLessThanOrEqual(limit);
  });
});

test.describe('S-04 with accented names, against the accepted risk', () => {
  test('NFR-PERF-02 (ACCEPTED-RISK): S-04 with an accented organisation name and a Latin-1 plus latin-ext inviter name stays within the owner\'s limit', async ({ browser }) => {
    test.setTimeout(120_000);
    const baseURL = test.info().project.use.baseURL!;
    // The owner's ruling names "José Nnaŋŋa" (U+00E9 from Latin-1, U+014B from the common latin-ext face); the organisation
    // name carries Latin-1 letters too, so both strings S-04 shows are non-ASCII (queue item PERF-SF-1).
    const fx = await buildOrg({ label: 'first-visit-accents' });
    await testDb.organization.update({ where: { id: fx.org.id }, data: { name: 'Coopérative Agrícola de Mbarara' } });
    await testDb.user.update({ where: { id: fx.members.owner.userId }, data: { name: 'José Nnaŋŋa' } });
    const ownerState = 'test-results/first-visit-accents-owner.json';
    await signInAndSave(browser, baseURL, fx.members.owner, ownerState, ACCENTS_IP, SIGNED_IN);
    const owner = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, storageState: ownerState });
    let path: string;
    try {
      path = await invitationPath(owner, fx.org.slug, 'first-visit-accents');
    } finally {
      await owner.close();
    }
    const m = await measure(browser, baseURL, path, undefined, invitedHeading);
    // The owner's ruling of 6 Nov ("Production + 1 KB (Recommended)"): 243700 B through nginx on HTTP/2; 237700 B on the
    // direct run as a regression guard (LIMITS).
    const limit = limits().s04Accented;
    report('/invitations/[token] (accented names)', m, limit);
    expectRendered(m, path, path, '/invitations/[token] (accented names)');
    // The reason this case exists: the accented organisation name, set in Overpass, fetches that face's latin_rest file.
    expect(m.fonts.some((f) => /^overpass_latin_rest/.test(f)), `fonts: ${m.fonts.join(',')}`).toBe(true);
    const page = `measured ${m.total} B: ${m.total <= PUBLIC_BUDGET ? 'within the 220000 B budget' : `${m.total - PUBLIC_BUDGET} B over the 220000 B budget`}`;
    test.info().annotations.push({ type: 'NFR-PERF-02 accepted risk', description: page });
    expect(m.total, `${page}; the limit for this run is ${limit} B`).toBeLessThanOrEqual(limit);
  });
});
