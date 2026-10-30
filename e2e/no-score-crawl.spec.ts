import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import fs from 'node:fs';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoScoreShapes } from './helpers/noScore';

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

type Seat = { label: string; storageStatePath: string };

/**
 * INTERIM, removed by the unit that moves the About page (PUB, FR-PUB-05). FR-RM-01's allow-list is the
 * educational sentences about a model's "accuracy score" and "confidence score" on the About page, "by
 * element id" (SRS line 451), and PUB places the `data-claims-allowed` markers when it moves that page to
 * `/about`. Until then `/explore/about` has no marker, and its one such sentence ("a model's 60%
 * confidence score", app/(authenticated)/explore/about/page.tsx:310) would fail the crawl. This marks that
 * paragraph, in the DOM only, on that one path, so the rest of the page is still checked in full.
 */
async function markInterimAllowedSentences(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/explore/about') return;
  await page.evaluate(() => {
    for (const p of Array.from(document.querySelectorAll('main p'))) {
      if (/confidence score/i.test(p.textContent ?? '')) p.setAttribute('data-claims-allowed', 'interim: about-page confidence-score sentence');
    }
  });
}

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
    return { label: `${org.slug}/${role}`, storageStatePath: seat.storageStatePath };
  });
}

/**
 * Pages reachable from `start` by `a[href]` links, breadth first, same origin only, at most `max`.
 * Each entry is `pathname + search` of the page the browser ended on (after any redirect).
 */
async function sameOriginPages(page: Page, start: string, { max }: { max: number }): Promise<string[]> {
  const visited: string[] = [];
  const seen = new Set<string>();
  const queued = new Set<string>([start]);
  const queue = [start];
  let origin = '';
  while (queue.length > 0 && visited.length < max) {
    await page.goto(queue.shift()!);
    await page.waitForLoadState('networkidle');      // links that client components render after load are links too
    const here = new URL(page.url());
    origin ||= here.origin;
    const key = here.pathname + here.search;
    if (here.origin !== origin || seen.has(key)) continue;
    seen.add(key);
    visited.push(key);
    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    for (const href of hrefs) {
      if (!URL.canParse(href)) continue;
      const link = new URL(href);
      const next = link.pathname + link.search;
      if (link.origin !== origin || NOT_FOLLOWED.test(link.pathname) || seen.has(next) || queued.has(next)) continue;
      queued.add(next);
      queue.push(next);
    }
  }
  return visited;
}

test('FR-RM-01 FR-RM-04: no page a crawled seat can reach shows a score shape', async ({ browser, baseURL }) => {
  test.setTimeout(15 * 60_000);
  const manifest = readManifest();
  const slug = manifest.orgs[0].slug;

  // A project of the organisation, so that the dashboard, the projects list and a project page all have
  // something to link to. The owner of the first organisation creates it over the app's own API.
  const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error(`no-score-crawl: no owner seat for ${slug} in the fixture manifest`);
  const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath });
  const created = await api.post(`/api/v1/orgs/${slug}/projects`, {
    headers: { origin: baseURL ?? '' },
    data: { name: `No-score crawl project ${Date.now()}`, aiSystemType: 'classification' },
  });
  expect(created.status(), 'creating the crawl project').toBe(201);
  await api.dispose();

  for (const seat of [...oneSeatPerRole()]) {        // owner, admin, assessor, reviewer, viewer; ORG adds adminSeat() to this list (round 10)
    const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
    const page = await context.newPage();
    const pages = await sameOriginPages(page, '/', { max: MAX_PAGES_PER_SEAT });
    console.log(`[no-score-crawl] ${seat.label}: ${pages.length} pages: ${pages.join(' ')}`);

    // A crawl that stopped at the landing page would pass for having found nothing.
    for (const must of [`/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`]) {
      expect(pages, `${seat.label} reached ${must}`).toContain(must);
    }
    expect(pages.some((p) => /^\/orgs\/[^/]+\/projects\/[0-9a-f-]{36}$/.test(p)), `${seat.label} reached a project page`).toBe(true);
    expect(pages.filter((p) => REMOVED_PAGE.test(p)), `${seat.label}: links to pages unit RM removed (FR-RM-03)`).toEqual([]);

    for (const url of pages) {
      await page.goto(url);
      await page.waitForLoadState('networkidle');    // client components fetch after load; check what the seat sees
      await markInterimAllowedSentences(page);
      await expectNoScoreShapes(page, `${seat.label} ${url}`);
    }
    await context.close();
  }
});
