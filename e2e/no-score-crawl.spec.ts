import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import fs from 'node:fs';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { expectNoScoreShapes } from './helpers/noScore';
import {
  PENDING_LINK_TARGETS,
  abortPendingBackgroundRequests,
  assertNoStalePendingTargets,
  pendingTargetFor,
  type PendingLinkTarget,
} from './helpers/pendingLinks';

/**
 * FR-RM-01 (SRS line 451) and FR-RM-04: a crawl signed in as one seat of each role visits every page
 * reachable by links from `/` and runs the shared no-score check (e2e/helpers/noScore.ts) on each.
 * It runs on the pages that exist when unit RM merges; V-prog and V repeat it on the release candidate,
 * with decisions in all three stages, findings and a sealed review in the fixture (SRS line 4985).
 *
 * It only navigates (GET). It never follows an `/api/` link or a sign-out link, and it stays on the
 * origin it started on, so a link cannot take a seat off the app or change state.
 */

const MAX_PAGES_PER_SEAT = 60;

/** A link to a page unit RM deleted (the report, the compare page, the questionnaire) is a dangling link (FR-RM-03). */
const REMOVED_PAGE = /\/orgs\/[^/]+\/(assessment\/[^/]+(\/report)?|projects\/[^/]+\/compare)\/?$/;

/**
 * Not followed: API routes, anything that signs the seat out, and files served from public/ (a path that
 * ends in an extension, such as the /templates/*.html downloads). Those are documents, not pages of the
 * app: they have no <main> and no layout, which the check requires.
 */
const NOT_FOLLOWED = /^\/api\/|sign-?out|log-?out|\.[a-z0-9]{2,5}$/i;

/**
 * `mustReach` is what a crawl of this seat must have visited, so that a crawl which stopped early cannot
 * pass for having found nothing. An organisation seat lists its dashboard, its projects list and a project
 * page; a seat without a membership (the platform administrator, which ORG adds) lists its own pages.
 */
type Seat = { label: string; storageStatePath: string; mustReach: Array<string | RegExp> };

/** Read when the test runs, not when the file loads: `setup` writes the manifest after Playwright has collected the specs. */
function readManifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
}

/** One seat of each of the five organisation roles, from the first fixture organisation (e2e/fixtures/manifest.ts). */
function oneSeatPerRole(): Seat[] {
  const manifest = readManifest();
  const org = manifest.orgs[0];
  return FIXTURE_ROLES.map((role) => {
    const seat = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === 0);
    if (!seat) throw new Error(`no-score-crawl: no ${role} seat for ${org.slug} in the fixture manifest`);
    return {
      label: `${org.slug}/${role}`,
      storageStatePath: seat.storageStatePath,
      mustReach: [`/orgs/${org.slug}/dashboard`, `/orgs/${org.slug}/projects`, /^\/orgs\/[^/]+\/projects\/[0-9a-f-]{36}$/],
    };
  });
}

/** A uuid, or any segment with a digit in it (an organisation slug, a question id, a numeric id), stands for an id. */
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|\d/i;

/** The route a path belongs to: its ids replaced by [id], and the names (not the values) of its query parameters. */
function routePattern(pathAndSearch: string): string {
  const url = new URL(pathAndSearch, 'http://pattern.invalid');
  const path = url.pathname.split('/').map((segment) => (ID_SEGMENT.test(segment) ? '[id]' : segment)).join('/');
  const params = [...new Set(url.searchParams.keys())].sort();
  return params.length > 0 ? `${path}?${params.join('&')}` : path;
}

/**
 * Goes to `url` and fails on a missing response or a status of 400 or more: a dead link is a finding. The exception is a link
 * to a shell target whose page another unit has not built yet (e2e/helpers/pendingLinks.ts): it must answer exactly 404, so a
 * page that was built, or any other answer, still fails, and the entry names itself in the message.
 */
async function gotoOk(page: Page, url: string, who: string, pending: readonly PendingLinkTarget[] = PENDING_LINK_TARGETS): Promise<void> {
  const response = await page.goto(url);
  const pathname = new URL(url, 'http://path.invalid').pathname;
  const status = response?.status() ?? 0;
  const target = pendingTargetFor(pathname, pending);
  if (target) {
    expect(status, `${who} ${url}: a pending link target (${target.producer}) must answer exactly 404 but answered ${status}; if its page was built, delete the entry in e2e/helpers/pendingLinks.ts (${target.pageFile})`).toBe(404);
    return;
  }
  expect(status, `${who} ${url}`).toBeGreaterThanOrEqual(200);
  expect(status, `${who} ${url}`).toBeLessThan(400);
}

/**
 * Pages reachable from `start` by `a[href]` links, breadth first, same origin only: one page per route
 * pattern (a path with its ids replaced by [id] is visited once), at most `max` patterns. Each entry is
 * `pathname + search` of the page the browser ended on (after any redirect). A page that answers 400 or
 * more fails the crawl. If `max` patterns have been visited and others are still queued, the crawl fails
 * and names the first of them, so a cap can never hide pages.
 */
async function sameOriginPages(
  page: Page,
  start: string,
  { max, label, pending = PENDING_LINK_TARGETS }: { max: number; label: string; pending?: readonly PendingLinkTarget[] },
): Promise<string[]> {
  const visited: string[] = [];
  const seen = new Set<string>();
  const queuedPatterns = new Set<string>([routePattern(start)]);
  const queue = [start];
  let origin = '';
  while (queue.length > 0 && visited.length < max) {
    await gotoOk(page, queue.shift()!, label, pending);
    await page.waitForLoadState('networkidle');      // links that client components render after load are links too
    const here = new URL(page.url());
    origin ||= here.origin;
    const key = here.pathname + here.search;
    const pattern = routePattern(key);
    if (here.origin !== origin || seen.has(pattern)) continue;
    seen.add(pattern);
    queuedPatterns.add(pattern);
    visited.push(key);
    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    for (const href of hrefs) {
      const link = new URL(href);                    // an href that is not a URL throws: a broken link fails the crawl, it is not skipped
      const next = link.pathname + link.search;
      if (link.origin !== origin || NOT_FOLLOWED.test(link.pathname) || queuedPatterns.has(routePattern(next))) continue;
      queuedPatterns.add(routePattern(next));
      queue.push(next);
    }
  }
  if (queue.length > 0) {
    throw new Error(`${label}: the crawl stopped at ${max} route patterns with ${queue.length} left unvisited, first: ${queue.slice(0, 5).join(', ')}`);
  }
  return visited;
}

/**
 * Self-tests of the crawl itself, on pages the test serves from `page.route` under a path no real route has,
 * so they need no fixture and no application page.
 */
const SELFTEST = '/__crawl-selftest';
const questionLinks = Array.from({ length: 30 }, (_, i) => `${SELFTEST}/patterns/q/${i + 1}`);
const SELFTEST_PAGES: Record<string, { status?: number; links?: string[] }> = {
  [`${SELFTEST}/patterns/`]: { links: [...questionLinks, `${SELFTEST}/patterns/about`] },
  [`${SELFTEST}/patterns/about`]: {},
  ...Object.fromEntries(questionLinks.map((q) => [q, {}])),
  [`${SELFTEST}/cap/`]: { links: ['a', 'b', 'c', 'd', 'e'].map((x) => `${SELFTEST}/cap/page-${x}`) },
  ...Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((x) => [`${SELFTEST}/cap/page-${x}`, {}])),
  [`${SELFTEST}/status/`]: { links: [`${SELFTEST}/status/gone`] },
  [`${SELFTEST}/status/gone`]: { status: 404 },
  [`${SELFTEST}/pending/`]: { links: [`${SELFTEST}/pending/not-built`] },
  [`${SELFTEST}/pending/not-built`]: { status: 404 },
  [`${SELFTEST}/pending-alive/`]: { links: [`${SELFTEST}/pending-alive/built`] },
  [`${SELFTEST}/pending-alive/built`]: {},
};

async function serveSelftestPages(page: Page): Promise<void> {
  await page.route(`**${SELFTEST}/**`, async (route) => {
    const def = SELFTEST_PAGES[new URL(route.request().url()).pathname];
    const links = (def?.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join(' ');
    await route.fulfill({ status: def ? (def.status ?? 200) : 404, contentType: 'text/html', body: `<main>${links}</main>` });
  });
}

test('FR-RM-01 (helper): the crawl visits one page per route pattern, not one per id', async ({ page }) => {
  await serveSelftestPages(page);
  const pages = await sameOriginPages(page, `${SELFTEST}/patterns/`, { max: 5, label: 'selftest' });
  expect(pages).toEqual([`${SELFTEST}/patterns/`, `${SELFTEST}/patterns/q/1`, `${SELFTEST}/patterns/about`]);
});

test('FR-RM-01 (helper): the crawl fails a seat whose queue is not empty at the cap, naming the first unvisited paths', async ({ page }) => {
  await serveSelftestPages(page);
  await expect(sameOriginPages(page, `${SELFTEST}/cap/`, { max: 3, label: 'selftest' })).rejects.toThrow(
    /selftest: the crawl stopped at 3 route patterns with 3 left unvisited, first: .*page-c.*page-d.*page-e/,
  );
  // Room for all of them: no failure.
  expect(await sameOriginPages(page, `${SELFTEST}/cap/`, { max: 6, label: 'selftest' })).toHaveLength(6);
});

test('FR-RM-01 (helper): the crawl fails on a page that answers 400 or more', async ({ page }) => {
  await serveSelftestPages(page);
  await expect(sameOriginPages(page, `${SELFTEST}/status/`, { max: 5, label: 'selftest' })).rejects.toThrow(/selftest .*status\/gone/);
});

test('FR-RM-01 (helper): a link to a pending target must answer exactly 404, and anything else fails', async ({ page }) => {
  await serveSelftestPages(page);
  const pending = [{ pattern: /^\/__crawl-selftest\/pending(-alive)?\/(not-built|built)$/, pageFile: 'no/such/page.tsx', producer: 'SELFTEST' }];
  // The 404 is expected there, so the crawl goes on and visits the page.
  const visited = await sameOriginPages(page, `${SELFTEST}/pending/`, { max: 5, label: 'selftest', pending });
  expect(visited).toEqual([`${SELFTEST}/pending/`, `${SELFTEST}/pending/not-built`]);
  // A pending page that answers 200 means the page was built and its entry was not deleted.
  await expect(sameOriginPages(page, `${SELFTEST}/pending-alive/`, { max: 5, label: 'selftest', pending })).rejects.toThrow(
    /selftest \/__crawl-selftest\/pending-alive\/built: a pending link target \(SELFTEST\) must answer exactly 404 but answered 200/,
  );
});

test('FR-RM-01 (helper): a background request to a pending target is aborted, a navigation to it is not, and other requests go on', async ({ page }) => {
  const pending = [{ pattern: /^\/__crawl-selftest\/pending\/not-built$/, pageFile: 'no/such/page.tsx', producer: 'SELFTEST' }];
  await serveSelftestPages(page);
  const aborted: string[] = [];
  await abortPendingBackgroundRequests(page, (t) => aborted.push(t.producer), pending); // after the pages, so it runs first
  await page.goto(`${SELFTEST}/patterns/about`);
  const outcome = (url: string) =>
    page.evaluate(async (u) => fetch(u).then((r) => `answered ${r.status}`, () => 'aborted'), url);
  expect(await outcome(`${SELFTEST}/pending/not-built?_rsc=x`)).toBe('aborted');
  expect(await outcome(`${SELFTEST}/patterns/about`)).toBe('answered 200');
  expect(aborted).toEqual(['SELFTEST']);
  const navigation = await page.goto(`${SELFTEST}/pending/not-built`);
  expect(navigation?.status(), 'a navigation to a pending target is not aborted').toBe(404);
  expect(aborted).toEqual(['SELFTEST']);
});

test('FR-RM-01 (helper): every seat carries its own must-reach list', () => {
  const seats = oneSeatPerRole();
  expect(seats.map((s) => s.label.split('/').pop())).toEqual([...FIXTURE_ROLES]);
  for (const seat of seats) {
    expect(seat.mustReach.length, seat.label).toBeGreaterThan(0);
    expect(seat.mustReach.some((m) => typeof m === 'string' && m.endsWith('/dashboard')), `${seat.label} must reach its dashboard`).toBe(true);
  }
});

test('FR-RM-01 FR-RM-04: no page a crawled seat can reach shows a score shape', async ({ browser, baseURL }) => {
  test.setTimeout(15 * 60_000);
  assertNoStalePendingTargets();                     // a page that now exists must not stay on the allow-list
  const manifest = readManifest();
  const slug = manifest.orgs[0].slug;

  // A project of the organisation, so that the dashboard, the projects list and a project page all have
  // something to link to. The owner of the first organisation creates it over the app's own API.
  const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error(`no-score-crawl: no owner seat for ${slug} in the fixture manifest`);
  // connection: close, because Node's server destroys an idle keep-alive socket 6 s after its last response, and Playwright's
  // pooled socket has no idle timer: a GET sent just then, while the server is busy, is reset (read ECONNRESET).
  const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath, extraHTTPHeaders: { connection: 'close' } });
  const created = await api.post(`/api/v1/orgs/${slug}/projects`, {
    headers: { origin: baseURL ?? '' },
    data: { requestId: crypto.randomUUID(), name: `No-score crawl project ${Date.now()}`, aiSystemType: 'classification' },
  });
  expect(created.status(), 'creating the crawl project').toBe(201);
  await api.dispose();

  // The five role seats, then the platform administrator (units/ORG.md Task 8b), who must reach S-23 and S-25.
  for (const seat of [...oneSeatPerRole(), adminSeat()]) {
    const mustReach = 'mustReach' in seat ? seat.mustReach : ['/admin/organisations', '/admin/accounts'];
    const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
    // A Link prefetch of a pending shell target never settles in a production build, so `networkidle` below would wait for ever
    // (Playwright's default navigation timeout is none). The links themselves are still followed and must answer exactly 404.
    await abortPendingBackgroundRequests(context);
    const page = await context.newPage();
    const pages = await sameOriginPages(page, '/', { max: MAX_PAGES_PER_SEAT, label: seat.label });
    console.log(`[no-score-crawl] ${seat.label}: ${pages.length} pages: ${pages.join(' ')}`);

    // A crawl that stopped at the landing page would pass for having found nothing.
    for (const must of mustReach) {
      const reached = typeof must === 'string' ? pages.includes(must) : pages.some((p) => must.test(p));
      expect(reached, `${seat.label} reached ${must}`).toBe(true);
    }
    expect(pages.filter((p) => REMOVED_PAGE.test(p)), `${seat.label}: links to pages unit RM removed (FR-RM-03)`).toEqual([]);

    for (const url of pages) {
      await gotoOk(page, url, seat.label);
      await page.waitForLoadState('networkidle');    // client components fetch after load; check what the seat sees
      await expectNoScoreShapes(page, `${seat.label} ${url}`);
    }
    await context.close();
  }
});
