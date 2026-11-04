import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { expectNoScoreShapes } from './helpers/noScore';
import { CLAIMS, STATUS_LABEL } from '../lib/claims/pattern';

/**
 * FR-PUB-01 (SRS line 1103, and 12.2 step 5, SRS line 4985): no page shows a claim of compliance, audit
 * readiness, certification, approval, accreditation or alignment with a standard, a score, or the words
 * "cannot see your records". Signed out, and signed in as one seat of each organisation role, the crawl
 * visits every page reachable by links, reads the words a person reads (the text of the page, its title and
 * description, and the aria-label, aria-description, title, alt, placeholder and button values), drops the
 * elements that carry `data-claims-allowed` (the About page's sentences that explain why there is no score,
 * SRS 7.5.3's allow-list), and fails on a match. On each page it also runs RM's `expectNoScoreShapes`, the
 * score half. A page that crashed in the browser shows the error page with status 200, so a script error or
 * the error page's heading fails the visit too.
 *
 * What it reads is the markup the page has on load, and anything React mounts without a click. Text that
 * only appears after an interaction (a dialog, a menu, a panel opened by a button) is not read; the unit
 * tests of the components that own it read it.
 *
 * Every page file under `app/` is accounted for: read by a crawl, or named in NOT_CRAWLED with the reason
 * and what picks it up. A new page file therefore fails here until it is reached or named.
 *
 * This is the rendered counterpart of `__tests__/lint/no-product-claims.test.ts`, which reads source and
 * content; both import the pattern from `lib/claims/pattern.ts`. The crawl follows
 * RM's `e2e/no-score-crawl.spec.ts`: GET only, same origin, never an `/api/` or a sign-out link, one visit per
 * route pattern, and a cap that fails and names what it left unvisited.
 *
 * The server this runs against serves the fixture content bundle (playwright.config.ts), never
 * `data/content`, so the words on a page are the application's own and not content that C-TXT rewords.
 * Generated documents are not pages; DOC-a and DOC-b run the phrase test over their output.
 */


const MAX_PAGES = 60;

/**
 * At the release candidate (the content gate's own condition, RELEASE_CANDIDATE=1) no interim exemption applies:
 * not OWNED_ELSEWHERE, not KNOWN_DEAD_LINKS, and not the skip of the score-shape check on `/`. They are known
 * findings of other units, listed so the branch can merge; a candidate that still needs them is not a candidate.
 */
const RELEASE_CANDIDATE = process.env.RELEASE_CANDIDATE === '1';

/**
 * Not followed: API routes, a sign-out or log-out path segment, and files served from public/ (a path ending
 * in an extension). The segment form is anchored, so "design-outputs" is still followed.
 */
const NOT_FOLLOWED = /^\/api\/|(^|\/)(sign-?out|log-?out)(\/|$)|\.[a-z0-9]{2,5}$/i;

/** A uuid, or any segment with a digit in it (an organisation slug, a question id), stands for an id. */
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|\d/i;

/** The heading of `app/error.tsx`, which a page that crashed in the browser shows with status 200. */
const ERROR_PAGE_HEADING = 'This page could not be loaded';

/**
 * Page files this crawl does not read, by route template (route groups removed), each with why and what
 * picks it up. A key that is not a page file, or that a crawl did reach, fails the completeness check, so
 * the list cannot go stale.
 */
const NOT_CRAWLED: Record<string, string> = {
  '/admin/users': 'platform administrator only; no seat of the fixture is one until ORG adds adminSeat() (RM\'s no-score crawl has the same gap); then add that seat to the roles below',
  '/admin/settings': 'platform administrator only, as /admin/users',
  '/invitations/[token]': 'needs an invitation token that only a member invitation makes (csp.spec.ts makes one); ACC-a and ORG rebuild invitations',
  '/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]': 'no link leads to it and its loader is still a CONTRACT_STUB for DEC-b (PENDING_PAGES in csp.spec.ts); DEC-b takes it off this list when it fills the loader and links the page',
};

/**
 * INTERIM. Rendered text of pages that another unit owns and rebuilds, which the widened pattern flags and which
 * PUB does not reword, by route template; the same finding as OWNED_ELSEWHERE in
 * __tests__/lint/no-product-claims.test.ts. Each text is one text node of the page, and only that node is
 * dropped from the check. The page must still show the text, or the entry is stale and the visit fails; delete
 * the entry with the fix.
 *
 * `/explore/controls` shows the control cards of `data/assessmentAreas.json`, the 4.0.0 file the page imports
 * (app/(authenticated)/explore/controls/page.tsx:6), not the content bundle; CNT and SUG rebuild the page onto
 * the bundle. The phrase test does not read that file.
 */
const OWNED_ELSEWHERE: Record<string, string[]> = {
  '/privacy': ['There is no self-service export or account deletion in the interface yet. Consent records are stored with a timestamp for audit purposes.'],
  '/orgs/[slug]/dashboard': ['Completed'],       // the project cards' count of completed assessments (RM, UI)
  '/orgs/[slug]/projects': ['Completed'],        // the same count on the projects list (PRJ)
  '/explore/controls': [
    'Data Quality & Representativeness Audit',
    'Break down model performance by subgroup. A model that works well on average can fail specific populations.',
    'Write a model card: what the model does, how well it performs, where it fails, and who might be affected.',
    'Define when to retrain: what performance thresholds trigger it, who approves it, and how you validate the new version.',
  ],
};

/** The route a path belongs to: its ids replaced by [id], and the names (not the values) of its query parameters. */
function routePattern(pathAndSearchOf: string): string {
  const url = new URL(pathAndSearchOf, 'http://pattern.invalid');
  const p = url.pathname.split('/').map((segment) => (ID_SEGMENT.test(segment) ? '[id]' : segment)).join('/');
  const params = [...new Set(url.searchParams.keys())].sort();
  return params.length > 0 ? `${p}?${params.join('&')}` : p;
}

type Words = { head: string[]; body: string[] };

/**
 * The words on the page that a person reads or hears, one entry per text node or attribute value, outside the
 * elements that carry `data-claims-allowed`: every text node of the body (a mounted but closed panel
 * included, because text in the DOM is still on the page), the title and the description (`head`), and the
 * attributes a screen reader speaks. A page whose body has no words is refused: the title alone would
 * otherwise make an empty page pass for one with no claim.
 */
async function readWords(page: Page, who: string): Promise<Words> {
  const words = await page.evaluate(() => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const outside = (el: Element) => el.closest('[data-claims-allowed]') === null;
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const head: string[] = [document.title];
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
    if (description) head.push(description);
    const body: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName) || !outside(parent)) continue;
      body.push(node.nodeValue ?? '');
    }
    const spoken = ['aria-label', 'aria-description', 'title', 'alt', 'placeholder'];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (!outside(el)) continue;
      for (const name of spoken) {
        const value = el.getAttribute(name);
        if (value) body.push(value);
      }
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type) && el.value) body.push(el.value);
    }
    return { head: head.map(clean).filter(Boolean), body: body.map(clean).filter(Boolean) };
  });
  if (words.body.length === 0) throw new Error(`${who}: the page has no words to check`);
  return words;
}

/**
 * Every claim in `words`, with a little of what is around it. `teamText` is what people of the organisation
 * typed (a project's name and description): it is theirs and not the platform's. Another spec's project called
 * "No-score crawl project" sits in the same organisation, and a team may name a project anything. Only a text
 * node or attribute whose whole value is one of those strings is dropped, so a name that is one letter, or that
 * is part of a longer platform sentence, changes nothing else on the page.
 */
function claimsIn(words: Words, teamText: readonly string[] = []): string[] {
  const team = new Set(teamText);
  const own = [...words.head, ...words.body.filter((segment) => !team.has(segment))].join(' ');
  const found: string[] = [];
  for (const m of own.matchAll(new RegExp(CLAIMS.source, CLAIMS.flags.replace('g', '') + 'g'))) {
    const at = m.index ?? 0;
    found.push(`"${m[0]}" in "${own.slice(Math.max(0, at - 30), at + m[0].length + 30)}"`);
  }
  // A text node that is only a status label ("Complete") is anchored, so it is tested alone, before nodes are joined.
  for (const segment of words.body) {
    if (!team.has(segment) && STATUS_LABEL.test(segment)) found.push(`"${segment}" as a whole text node`);
  }
  return found;
}

/**
 * INTERIM, removed by ORG together with the `/orgs/new` page (units/ORG.md Task 1), as in
 * e2e/no-score-crawl.spec.ts. components/layout/Sidebar.tsx resolves its organisation links against the
 * `/orgs/<x>/` it is in, so on `/orgs/new` it links to these three paths, which answer 404. They are still
 * read for claims; they must answer 404 exactly, so a page that starts to answer 500, or that works, fails.
 */
const KNOWN_DEAD_LINKS = /^\/orgs\/new\/(dashboard|projects|settings\/members)$/;

/** Goes to `url` and fails on no response or a status of 400 or more: a dead link is a finding. */
async function gotoOk(page: Page, url: string, who: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? 0;
  if (!RELEASE_CANDIDATE && KNOWN_DEAD_LINKS.test(new URL(url, 'http://path.invalid').pathname)) {
    expect(status, `${who} ${url} is a known dead link and must answer 404 (remove it from KNOWN_DEAD_LINKS when ORG deletes /orgs/new)`).toBe(404);
    return;
  }
  expect(status, `${who} ${url}`).toBeGreaterThanOrEqual(200);
  expect(status, `${who} ${url}`).toBeLessThan(400);
}

/**
 * Pages reachable by `a[href]` links from `starts`, breadth first, same origin: one page per route pattern,
 * at most `max`. Each entry is `pathname + search` of the page the browser ended on (after any redirect).
 * A page that answers 400 or more, or that ends on another origin, fails the crawl. If the cap is reached
 * with links still queued, the crawl fails and names the first of them, so a cap can never hide pages.
 * `onPage` runs once on each page kept, while the browser is on it, so the page that is read is the page
 * that was reached, not one asked for again later (an address such as `/` sends a seat to its organisation
 * only once it has one).
 */
async function reachablePages(
  page: Page,
  starts: string[],
  { max, label }: { max: number; label: string },
  onPage: (key: string) => Promise<void> = async () => {},
): Promise<string[]> {
  const visited: string[] = [];
  const seen = new Set<string>();
  const queued = new Set<string>(starts.map(routePattern));
  const queue = [...starts];
  let origin = '';
  while (queue.length > 0 && visited.length < max) {
    const target = queue.shift()!;
    await gotoOk(page, target, label);
    await page.waitForLoadState('networkidle');        // links that client components render after load are links too
    const here = new URL(page.url());
    origin ||= here.origin;
    expect(here.origin, `${label}: ${target} ended on another origin`).toBe(origin);
    const key = here.pathname + here.search;
    const pattern = routePattern(key);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    queued.add(pattern);
    visited.push(key);
    await onPage(key);
    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    for (const href of hrefs) {
      const link = new URL(href);                      // an href that is not a URL throws: a broken link fails the crawl
      const next = link.pathname + link.search;
      if (link.origin !== origin || NOT_FOLLOWED.test(link.pathname) || queued.has(routePattern(next))) continue;
      queued.add(routePattern(next));
      queue.push(next);
    }
  }
  if (queue.length > 0) {
    throw new Error(`${label}: the crawl stopped at ${max} route patterns with ${queue.length} left unvisited, first: ${queue.slice(0, 5).join(', ')}`);
  }
  return visited;
}

/** A page file: its route template (route groups removed, `/` for the root) and the group it sits in, if any. */
type PageFile = { template: string; group: string | null };

/** Every page file under `app/`, from the files themselves (the source `e2e/csp.spec.ts` reads its routes from). */
function pageFiles(): PageFile[] {
  const root = path.join(process.cwd(), 'app');
  const files: PageFile[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        const group = segments.find((s) => /^\(.+\)$/.test(s)) ?? null;
        const route = segments.filter((s) => !/^\(.+\)$/.test(s));
        files.push({ template: `/${route.join('/')}`, group });
      }
    }
  };
  walk(root, []);
  return files.sort((a, b) => a.template.localeCompare(b.template));
}

/** The page files with no dynamic segment in a route group: the pages a crawl can be told to visit. */
function staticPagesIn(group: string): string[] {
  return pageFiles().filter((f) => f.group === group && !f.template.includes('[')).map((f) => f.template);
}

/** A regular expression for the paths a route template covers: each `[segment]` stands for one path segment. */
function templateRegExp(template: string): RegExp {
  const body = template.split('/').map((s) => (/^\[.+\]$/.test(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${body}$`);
}

/** True when some visited `pathname + search` is a path the template covers. */
function reachedBy(template: string, visited: string[]): boolean {
  return visited.some((v) => templateRegExp(template).test(new URL(v, 'http://path.invalid').pathname));
}

/**
 * The page files of `group` that no visited path matches and that `notCrawled` does not name, plus the
 * `notCrawled` keys that are not page files or that a visited path matches (a stale or reached entry).
 */
function unaccounted(group: string, visited: string[], notCrawled: Record<string, string>): string[] {
  const files = pageFiles();
  const templates = files.filter((f) => f.group === group).map((f) => f.template);
  const problems: string[] = [];
  for (const t of templates) {
    if (!reachedBy(t, visited) && !(t in notCrawled)) problems.push(`${t}: no crawl reached this page file and NOT_CRAWLED does not name it`);
  }
  for (const key of Object.keys(notCrawled)) {
    if (!files.some((f) => f.template === key)) problems.push(`${key}: NOT_CRAWLED names a page file that does not exist`);
    else if (templates.includes(key) && reachedBy(key, visited)) problems.push(`${key}: NOT_CRAWLED names a page a crawl reached; remove the entry`);
  }
  return problems;
}

/** Read when the test runs, because `setup` writes the manifest after Playwright has collected the specs. */
function readManifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
}

/** Lists the projects of the organisation over the owner's API. */
type ProjectList = () => Promise<Array<{ name: string; description: string | null }>>;

/**
 * The names and descriptions of the organisation's projects, with the whitespace collapsed the way
 * `readWords` collapses it. It fails when the list is empty, because an empty list would pass for an
 * organisation with nothing in it (the crawl creates a project first, so there is one).
 */
async function projectTexts(list: ProjectList): Promise<string[]> {
  const projects = await list();
  expect(projects.length, 'the organisation has the crawl project at least').toBeGreaterThan(0);
  return projects
    .flatMap((p) => [p.name, p.description ?? ''])
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
}

/**
 * What to run on each page the crawl keeps: collects every claim, and fails on a score shape, a script error
 * or the error page. `teamText` gives what the organisation's people typed; it is asked only for pages under
 * `/orgs/`, where that text is shown, and after the page's words are read, never before: another spec may name
 * a project while this one crawls (two workers share the organisation), and a list read later than the page
 * holds every project the page can show.
 */
function pageChecker(page: Page, who: string, teamText: () => Promise<string[]>): { claims: string[]; check: (url: string) => Promise<void> } {
  const claims: string[] = [];
  const scriptErrors: string[] = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));
  const check = async (url: string): Promise<void> => {
    const words = await readWords(page, `${who} ${url}`);
    expect(await page.locator('h1', { hasText: ERROR_PAGE_HEADING }).count(), `${who} ${url} shows the error page`).toBe(0);
    expect(scriptErrors, `${who} ${url} threw in the browser`).toEqual([]);
    const pathname = new URL(page.url()).pathname;
    const owned = Object.entries(OWNED_ELSEWHERE).filter(([template]) => !RELEASE_CANDIDATE && !KNOWN_DEAD_LINKS.test(pathname) && templateRegExp(template).test(pathname)).flatMap(([, texts]) => texts);
    for (const text of owned) expect(words.body, `${who} ${url} no longer shows an OWNED_ELSEWHERE text; delete its entry`).toContain(text);
    const own = pathname.startsWith('/orgs/') ? await teamText() : [];
    for (const found of claimsIn(words, [...own, ...owned])) claims.push(`${who} ${url}: ${found}`);
    // INTERIM: the organisation picker that `/` shows a seat with no last organisation (app/page.tsx) has no
    // <main> landmark, which expectNoScoreShapes refuses. Its words are still read above. UI fixes the page;
    // from then on the check runs here too.
    if (!RELEASE_CANDIDATE && pathname === '/' && (await page.locator('main').count()) === 0) return;
    await expectNoScoreShapes(page, `${who} ${url}`);
  };
  return { claims, check };
}

test('FR-PUB-01 (helper): the word reader and the claim pattern flag a claim and skip an allowed element', async ({ page }) => {
  await page.setContent(`<!doctype html><title>t</title><main>
    <p>Audit-ready reports.</p>
    <p>Aligned to ISO/IEC 42001 clauses</p>
    <p data-claims-allowed="why-no-score"><span>The score was never calibrated.</span></p>
    <button aria-label="Responsible AI compliance">x</button>
    <input type="submit" value="Certified submit">
    <p>Cannot see your records.</p>
  </main>`);
  const claims = claimsIn(await readWords(page, 'self-test'));
  expect(claims.length, claims.join('; ')).toBe(5);
  expect(claims.some((c) => /score/i.test(c)), 'the allowed element is skipped').toBe(false);
  expect(claims.some((c) => /compliance/i.test(c)), 'an aria-label is read').toBe(true);
  expect(claims.some((c) => /certified/i.test(c)), 'a button value is read').toBe(true);
});

test('FR-PUB-01 (helper): only a whole text node a team typed is dropped; one letter or part of a platform sentence hides nothing', () => {
  const words = (body: string[]): Words => ({ head: ['t'], body });
  // The team's text is dropped when it is the whole node, and the platform's own claim beside it is still found.
  expect(claimsIn(words(['Projects', 'No-score crawl project 17', 'audit-ready reports']), ['No-score crawl project 17']).join(';')).toMatch(/audit-ready/i);
  expect(claimsIn(words(['No-score crawl project 17']), ['No-score crawl project 17'])).toEqual([]);
  // A project named "e" does not break "compliance" apart (a substring mask would).
  expect(claimsIn(words(['Full compliance']), ['e', 'c', 'o']).length).toBe(1);
  // A project named like a claim word hides only a node that is exactly that word.
  expect(claimsIn(words(['We guarantee compliance']), ['compliance']).length).toBe(1);
  expect(claimsIn(words(['compliance']), ['compliance'])).toEqual([]);
});

test('FR-PUB-01 (helper): the word reader refuses a page whose body has no words, a title alone is not words', async ({ page }) => {
  await page.setContent('<!doctype html><main></main>');
  await expect(readWords(page, 'self-test')).rejects.toThrow(/self-test: the page has no words to check/);
  await page.setContent('<!doctype html><title>A page with a title</title><main></main>');
  await expect(readWords(page, 'self-test')).rejects.toThrow(/self-test: the page has no words to check/);
});

test('FR-PUB-01 (helper): the page list comes from the files, and a page file nobody reads or names is reported', () => {
  const files = pageFiles();
  expect(files.some((f) => f.template === '/about' && f.group === '(public)')).toBe(true);
  expect(staticPagesIn('(public)')).toContain('/terms');
  expect(staticPagesIn('(public)').every((p) => !p.includes('['))).toBe(true);
  // Visiting nothing leaves every page file of the group unaccounted for except those named.
  const none = unaccounted('(public)', [], { '/invitations/[token]': 'x' });
  expect(none.some((p) => p.startsWith('/about:'))).toBe(true);
  expect(none.some((p) => p.startsWith('/invitations/[token]:'))).toBe(false);
  // A dynamic template matches a path of its shape; a stale or reached entry is reported.
  expect(templateRegExp('/orgs/[slug]/dashboard').test('/orgs/acme-1/dashboard')).toBe(true);
  expect(templateRegExp('/orgs/[slug]/dashboard').test('/orgs/acme-1/dashboard/x')).toBe(false);
  expect(unaccounted('(public)', ['/about'], { '/nowhere': 'x' }).some((p) => p.startsWith('/nowhere:'))).toBe(true);
  expect(unaccounted('(public)', ['/about', '/terms', '/login'], { '/about': 'x' }).some((p) => p.startsWith('/about:'))).toBe(true);
});

test('FR-PUB-01: no interim exemption is left at the release candidate', () => {
  test.skip(!RELEASE_CANDIDATE, 'the exemptions apply until RELEASE_CANDIDATE=1');
  expect(Object.keys(OWNED_ELSEWHERE), 'rendered text other units still have to reword').toEqual([]);
});

test('FR-PUB-01: no page reachable signed out shows a product claim', async ({ browser, baseURL }) => {
  test.setTimeout(5 * 60_000);
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  failOnDialog(page);
  const mustReach = staticPagesIn('(public)');
  const signedOut = pageChecker(page, 'signed out', async () => []);   // a signed-out page shows no team text
  const pages = await reachablePages(page, ['/', ...mustReach], { max: MAX_PAGES, label: 'signed out' }, signedOut.check);
  console.log(`[claims-crawl] signed out: ${pages.length} pages: ${pages.join(' ')}`);
  // These were also given as starts, so this proves each answers 200 signed out and is not sent to /login.
  for (const must of mustReach) expect(pages, `signed out answered ${must} without sending it elsewhere`).toContain(must);
  expect(unaccounted('(public)', pages, NOT_CRAWLED), 'public page files no crawl reads').toEqual([]);

  expect(signedOut.claims, 'claims on pages reachable signed out').toEqual([]);
  await context.close();
});

test('FR-PUB-01: no page reachable as any organisation role shows a product claim', async ({ browser, baseURL }) => {
  test.setTimeout(15 * 60_000);
  const manifest = readManifest();
  const slug = manifest.orgs[0].slug;

  // A project, so the dashboard, the projects list and a project page have something to link to.
  const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error(`claims-crawl: no owner seat for ${slug} in the fixture manifest`);
  const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath });
  const created = await api.post(`/api/v1/orgs/${slug}/projects`, {
    headers: { origin: baseURL ?? '' },
    data: { name: `Claims crawl project ${Date.now()}`, aiSystemType: 'classification' },
  });
  expect(created.status(), 'creating the crawl project').toBe(201);
  const list: ProjectList = async () => {
    const response = await api.get(`/api/v1/orgs/${slug}/projects`);
    expect(response.status(), 'listing the projects of the organisation').toBe(200);
    return (await response.json()) as Array<{ name: string; description: string | null }>;
  };
  const teamText = () => projectTexts(list);

  // Pages no sidebar link leads to are started from their files: the authenticated pages with no dynamic
  // segment, but not those NOT_CRAWLED names, so a deleted page leaves the list by itself.
  const starts = ['/', ...staticPagesIn('(authenticated)').filter((p) => !(p in NOT_CRAWLED))];
  const reachedBySomeSeat: string[] = [];
  const claims: string[] = [];
  for (const role of FIXTURE_ROLES) {
    const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === role && u.index === 0);
    if (!seat) throw new Error(`claims-crawl: no ${role} seat for ${slug} in the fixture manifest`);
    const label = `${slug}/${role}`;
    const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
    const page = await context.newPage();
    failOnDialog(page);
    const seatChecker = pageChecker(page, label, teamText);
    const pages = await reachablePages(page, starts, { max: MAX_PAGES, label }, seatChecker.check);
    reachedBySomeSeat.push(...pages);
    console.log(`[claims-crawl] ${label}: ${pages.length} pages: ${pages.join(' ')}`);

    // A crawl that stopped at the landing page would pass for having found nothing. The sidebar leads to
    // the explore pages and to About (through its redirect until UI points the link at /about).
    const mustReach: Array<string | RegExp> = [
      `/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`, /^\/orgs\/[^/]+\/projects\/[0-9a-f-]{36}$/,
      '/explore/framework', '/explore/controls', '/about',
    ];
    for (const must of mustReach) {
      const reached = typeof must === 'string' ? pages.includes(must) : pages.some((p) => must.test(p));
      expect(reached, `${label} reached ${must}`).toBe(true);
    }
    claims.push(...seatChecker.claims);
    await context.close();
  }
  await api.dispose();
  expect(unaccounted('(authenticated)', reachedBySomeSeat, NOT_CRAWLED), 'authenticated page files no seat crawl reads').toEqual([]);
  expect(claims, 'claims on pages reachable as a seat').toEqual([]);
});
