import { expect, type Page } from '@playwright/test';
import { pendingTargetFor } from './pendingLinks';

/**
 * The page discovery of e2e/claims-crawl.spec.ts, moved here unchanged so that another spec can walk the same pages
 * (plan 1A Task 9, e2e/vocabulary-first-use.spec.ts) without importing a spec file. `reachablePages` and `routePattern`
 * (for a worklist keyed by route) are exported; the rest is what they need.
 */

/**
 * Not followed: API routes, a sign-out or log-out path segment, and files served from public/ (a path ending
 * in an extension). The segment form is anchored, so "design-outputs" is still followed.
 */
const NOT_FOLLOWED = /^\/api\/|(^|\/)(sign-?out|log-?out)(\/|$)|\.[a-z0-9]{2,5}$/i;

/** A uuid, or any segment with a digit in it (an organisation slug, a question id), stands for an id. */
const ID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|\d/i;

/** The route a path belongs to: its ids replaced by [id], and the names (not the values) of its query parameters. */
export function routePattern(pathAndSearchOf: string): string {
  const url = new URL(pathAndSearchOf, 'http://pattern.invalid');
  const p = url.pathname.split('/').map((segment) => (ID_SEGMENT.test(segment) ? '[id]' : segment)).join('/');
  const params = [...new Set(url.searchParams.keys())].sort();
  return params.length > 0 ? `${p}?${params.join('&')}` : p;
}

/** Goes to `url` and fails on no response or a status of 400 or more: a dead link is a finding. */
async function gotoOk(page: Page, url: string, who: string): Promise<void> {
  const response = await page.goto(url);
  const status = response?.status() ?? 0;
  // A shell link whose page another unit has not built yet (e2e/helpers/pendingLinks.ts) must answer exactly 404: a page that
  // was built, or any other answer, fails, and the message names the entry to delete.
  const pending = pendingTargetFor(new URL(url, 'http://path.invalid').pathname);
  if (pending) {
    expect(status, `${who} ${url}: a pending link target (${pending.producer}) must answer exactly 404; if its page was built, delete the entry in e2e/helpers/pendingLinks.ts (${pending.pageFile})`).toBe(404);
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
export async function reachablePages(
  page: Page,
  starts: string[],
  { max, label, follows = () => true }: { max: number; label: string; follows?: (pathname: string) => boolean },
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
    if (!pendingTargetFor(here.pathname)) visited.push(key);   // a 404 page is read for claims, but it does not stand for the page file
    await onPage(key);
    const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));
    for (const href of hrefs) {
      const link = new URL(href);                      // an href that is not a URL throws: a broken link fails the crawl
      const next = link.pathname + link.search;
      if (link.origin !== origin || NOT_FOLLOWED.test(link.pathname) || !follows(link.pathname) || queued.has(routePattern(next))) continue;
      queued.add(routePattern(next));
      queue.push(next);
    }
  }
  if (queue.length > 0) {
    throw new Error(`${label}: the crawl stopped at ${max} route patterns with ${queue.length} left unvisited, first: ${queue.slice(0, 5).join(', ')}`);
  }
  return visited;
}
