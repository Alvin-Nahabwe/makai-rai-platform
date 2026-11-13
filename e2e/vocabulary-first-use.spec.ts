import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './helpers/loopbackOnly';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { abortPendingBackgroundRequests } from './helpers/pendingLinks';
import { reachablePages } from './helpers/reachablePages';
import { firstUseViolations, type TextNodeInfo } from '../lib/vocabulary/firstUse';
import * as terms from '../lib/vocabulary/terms';

/**
 * Plan 1A, Task 9: a screen's first use of a defined term sits beside its definition (lib/vocabulary/firstUse.ts holds
 * the rule and its unit tests). Signed in as one seat of each role of the first fixture organisation, and as the platform
 * administrator, the crawl walks the pages reachable by links (e2e/helpers/reachablePages.ts, the claims crawl's
 * discovery) and, on each page, reads the text nodes of `main` outside `nav` in document order.
 *
 * Two tests in a serial block, so that an expected failure cannot hide a broken crawl: the first crawls and collects and
 * must pass (every seat reached its landing page, and the Projects page where it has one, and every page gave at least
 * one text node); only the second, which asserts that no page has a violation, is marked `test.fail()`. No screen uses
 * Term and Definition yet, so it fails until the copy tasks do; Task 20 removes the mark (the same deferral as the
 * vocabulary lint's worklist case in __tests__/lint/vocabulary.test.ts).
 *
 * Unlike e2e/claims-crawl.spec.ts this spec seeds nothing: it crawls what the fixture organisation already holds, so the
 * project pages it reaches are those of whichever project the organisation lists first.
 */

const MAX_PAGES = 60;

/** The elements that make a block: a term's definition must sit in the same one (plan 1A Task 9). */
const BLOCK_SELECTOR = 'p, li, dt, dd, label, legend, th, td, h1, h2, h3, h4, h5, h6, .ui-field, .ui-callout';

/** Every concept of the vocabulary; the rule checks those whose `defineOnFirstUse` is true. */
const CONCEPTS = Object.values(terms);

/**
 * Not given as starts: `/acceptances` renders only for an account missing an acceptance, and every fixture seat holds
 * all of them (the reason e2e/claims-crawl.spec.ts's NOT_CRAWLED gives).
 */
const NOT_STARTED = new Set(['/acceptances']);

/**
 * The authenticated page files with no dynamic segment, read from `app/` as the claims crawl reads its starts: the
 * pages no sidebar link may lead to.
 */
function staticAuthenticatedPages(): string[] {
  const root = path.join(process.cwd(), 'app', '(authenticated)');
  const found: string[] = [];
  const walk = (dir: string, segments: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), [...segments, entry.name]);
      else if (/^page\.(tsx|ts|jsx|js)$/.test(entry.name)) {
        const route = segments.filter((s) => !/^\(.+\)$/.test(s));
        if (!route.some((s) => s.includes('['))) found.push(`/${route.join('/')}`);
      }
    }
  };
  walk(root, []);
  return found.filter((p) => !NOT_STARTED.has(p)).sort();
}

/**
 * Runs in the page (page.evaluate), so it imports nothing: the text nodes of the first `main`, outside `nav` and
 * outside script and style, whitespace collapsed, empty ones dropped, in document order. `null` when the page has no
 * `main`. A node in no block gets a key of its own and no definitions.
 */
function collectTextNodes(blockSelector: string): TextNodeInfo[] | null {
  const main = document.querySelector('main');
  if (main === null) return null;
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const blockKeys = new Map<Element, string>();
  const nodes: TextNodeInfo[] = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || skip.has(parent.tagName) || parent.closest('nav') !== null) continue;
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const termIds: string[] = [];
    for (let el: Element | null = parent; el !== null && el !== main.parentElement; el = el.parentElement) {
      const id = el.getAttribute('data-term');
      if (id) termIds.push(id);
    }
    const block = parent.closest(blockSelector);
    let blockKey = `none-${nodes.length}`;
    let definitionIdsInBlock: string[] = [];
    if (block !== null) {
      if (!blockKeys.has(block)) blockKeys.set(block, `block-${blockKeys.size}`);
      blockKey = blockKeys.get(block) as string;
      definitionIdsInBlock = [block, ...Array.from(block.querySelectorAll('[data-definition]'))]
        .map((el) => el.getAttribute('data-definition'))
        .filter((id): id is string => Boolean(id));
    }
    nodes.push({ text, termIds, blockKey, definitionIdsInBlock, inRoleChoice: parent.closest('[data-role-choice]') !== null });
  }
  return nodes;
}

test('vocabulary first use (helper): the collector reads main outside nav, in order, with terms, blocks, definitions and role choices', async ({ page }) => {
  await page.setContent(`<!doctype html><title>t</title><nav><a>Outside main</a></nav><main>
    <nav><a>Findings</a></nav>
    <p><span data-term="finding">finding</span> <span data-definition="finding">A gap your team has noted.</span></p>
    <ul><li>Open the finding <script>var x = 'finding';</script></li></ul>
    <fieldset data-role-choice><legend>Role</legend><label>Owner</label></fieldset>
    <div>Loose text</div>
  </main>`);
  const nodes = await page.evaluate(collectTextNodes, BLOCK_SELECTOR);
  expect(nodes?.map((n) => n.text)).toEqual(['finding', 'A gap your team has noted.', 'Open the finding', 'Role', 'Owner', 'Loose text']);
  const [term, definition, later, legend, owner, loose] = nodes!;
  expect(term).toEqual({ text: 'finding', termIds: ['finding'], blockKey: 'block-0', definitionIdsInBlock: ['finding'], inRoleChoice: false });
  expect(definition.blockKey).toBe('block-0');
  expect(later).toMatchObject({ termIds: [], blockKey: 'block-1', definitionIdsInBlock: [], inRoleChoice: false });
  expect(legend.inRoleChoice).toBe(true);
  expect(owner).toMatchObject({ blockKey: 'block-3', inRoleChoice: true });
  expect(loose).toMatchObject({ blockKey: 'none-5', definitionIdsInBlock: [] });
  expect(firstUseViolations(nodes!, CONCEPTS)).toEqual([{ id: 'owner', text: 'Owner' }]);
  await page.setContent('<!doctype html><title>t</title><div>No main here</div>');
  expect(await page.evaluate(collectTextNodes, BLOCK_SELECTOR)).toBeNull();
});

/** `seat page: id "text"`, one per violation, filled by the crawl and asserted by the expected failure. */
const violations: string[] = [];
let crawled = false;

test.describe.serial('vocabulary first use', () => {
  test('vocabulary first use: every seat\'s crawl reaches its pages and reads their main text', async ({ browser, baseURL }) => {
    test.setTimeout(15 * 60_000);
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
    const slug = manifest.orgs[0].slug;
    const starts = ['/', ...staticAuthenticatedPages()];
    const seats: Array<{ label: string; storageStatePath: string; starts: string[]; mustReach: string[] }> = FIXTURE_ROLES.map((role) => {
      const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === role && u.index === 0);
      if (!seat) throw new Error(`vocabulary-first-use: no ${role} seat for ${slug} in the fixture manifest`);
      return { label: `${slug}/${role}`, storageStatePath: seat.storageStatePath, starts, mustReach: [`/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`] };
    });
    // The platform administrator is in no organisation, so it has no Projects page: `/` sends it to S-23.
    seats.push({ label: 'platform administrator', storageStatePath: adminSeat().storageStatePath, starts: ['/'], mustReach: ['/admin/organisations'] });

    const byId = new Map<string, number>();
    for (const seat of seats) {
      const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
      await abortPendingBackgroundRequests(context);
      const page = await context.newPage();
      failOnDialog(page);
      let found = 0;
      const pages = await reachablePages(page, seat.starts, { max: MAX_PAGES, label: seat.label }, async (key) => {
        const nodes = await page.evaluate(collectTextNodes, BLOCK_SELECTOR);
        expect(nodes, `${seat.label} ${key}: the page has no main`).not.toBeNull();
        expect(nodes!.length, `${seat.label} ${key}: no text node in main outside nav`).toBeGreaterThan(0);
        for (const v of firstUseViolations(nodes!, CONCEPTS)) {
          violations.push(`${seat.label} ${key}: ${v.id} "${v.text}"`);
          byId.set(v.id, (byId.get(v.id) ?? 0) + 1);
          found += 1;
        }
      });
      for (const must of seat.mustReach) expect(pages, `${seat.label} reached ${must}`).toContain(must);
      console.log(`[vocabulary-first-use] ${seat.label}: ${pages.length} pages, ${found} violations: ${pages.join(' ')}`);
      await context.close();
    }
    const ranked = [...byId].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log(`[vocabulary-first-use] ${violations.length} violations by id: ${ranked.map(([id, n]) => `${id} ${n}`).join(', ')}`);
    crawled = true;
  });

  test('vocabulary first use (worklist until Task 20)', () => {
    test.skip(!crawled, 'the crawl test did not finish, so there is nothing to judge');
    test.fail();
    expect(violations, `first uses not beside their definition:\n${violations.join('\n')}`).toEqual([]);
  });
});
