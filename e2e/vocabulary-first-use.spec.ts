import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './helpers/loopbackOnly';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { abortPendingBackgroundRequests } from './helpers/pendingLinks';
import { reachablePages, routePattern } from './helpers/reachablePages';
import { isLegalTextRoute, staticPagesIn, unaccounted } from './helpers/pageFiles';
import { ownProject, seedCrawlProject } from './helpers/crawlProject';
import { firstUseViolations, type TextNodeInfo } from '../lib/vocabulary/firstUse';
import * as terms from '../lib/vocabulary/terms';

/**
 * Plan 1A, Task 9: a screen's first use of a defined term sits beside its definition (lib/vocabulary/firstUse.ts holds
 * the rule and its unit tests). Signed in as one seat of each role of the first fixture organisation, and as the platform
 * administrator, the crawl walks the pages reachable by links (e2e/helpers/reachablePages.ts, the claims crawl's
 * discovery) and, on each page, reads the visible text nodes of `main` outside `nav` in document order.
 *
 * Like e2e/claims-crawl.spec.ts, it first seeds its OWN project (a decision, a finding, a sealed stage review:
 * e2e/helpers/crawlProject.ts), starts from it, and follows links into no other project, so what it reaches does not
 * depend on what other specs wrote. Every authenticated page file must be reached by some seat or named in NOT_CRAWLED.
 *
 * Two tests in a serial block, so that an expected failure cannot hide a broken crawl: the first crawls and collects and
 * must pass (its floors: the claims crawl's must-reach lists, the page-file gate, a text node on every page, all 26
 * first-use concepts checked), and prints the worklist; only the second, which asserts that no page has a violation, is
 * marked `test.fail()`. No screen uses Term and Definition yet, so it fails until the copy tasks do; Task 20 removes the
 * mark (the same deferral as the vocabulary lint's worklist case in __tests__/lint/vocabulary.test.ts). With
 * VOCABULARY_HITS_DIR set, the worklist is also written to vocabulary-first-use-hits.txt in that directory.
 */

const MAX_PAGES = 60;

/** The elements that make a block: a term's definition must sit beside it (plan 1A Task 9; ruling L2-29). */
const BLOCK_SELECTOR = 'p, li, dt, dd, label, legend, th, td, h1, h2, h3, h4, h5, h6, .ui-field, .ui-callout';

/** Every concept of the vocabulary; the rule checks those whose `defineOnFirstUse` is true. */
const CONCEPTS = Object.values(terms);

/**
 * Authenticated page files this crawl does not read, each with why. A key that is not a page file, or that a seat
 * reached, fails the coverage gate (`unaccounted`), so the list cannot go stale.
 */
const NOT_CRAWLED: Record<string, string> = {
  '/acceptances': 'renders only for an account missing an acceptance, and every fixture seat holds all of them (FR-ACC-04); e2e/acceptances.spec.ts renders it',
};

/** One violation, kept with the seat and page that showed it. */
type Hit = { seat: string; page: string; id: string; text: string };

/**
 * The worklist: one line per (route pattern, concept id), sorted, with the seats that saw it and one example text
 * (cut at 160 characters).
 */
function worklist(hits: readonly Hit[]): string[] {
  const groups = new Map<string, { seats: Set<string>; example: string }>();
  for (const h of hits) {
    const key = `${routePattern(h.page)} ${h.id}`;
    const group = groups.get(key) ?? { seats: new Set<string>(), example: h.text };
    group.seats.add(h.seat);
    groups.set(key, group);
  }
  const cut = (s: string) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
  return [...groups].map(([key, g]) => `${key}: ${[...g.seats].join(', ')}: "${cut(g.example)}"`).sort();
}

/**
 * Runs in the page (page.evaluate), so it imports nothing. The text nodes of the first `main`, in document order,
 * whitespace collapsed, empty ones dropped, `null` when the page has no `main`. Not collected: a node inside `nav`, a
 * script or a style; one the reader cannot see (its parent fails `checkVisibility()`, L2-30); a definition's own text
 * (inside `[data-definition]`, L2-27); and, on S-06's legal routes only, the quoted legal text (`[data-legal-text]`,
 * L2-25). A node's definitions (L2-29) are those inside, or being, its block; inside, or being, the element right
 * after its block; inside its closest `.ui-field` or `.ui-callout`; and an element named by `aria-describedby` on the
 * block or on a control inside it. A node in no block gets a key of its own.
 */
function collectTextNodes({ blockSelector, legalRoute }: { blockSelector: string; legalRoute: boolean }): TextNodeInfo[] | null {
  const main = document.querySelector('main');
  if (main === null) return null;
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const definitionsIn = (el: Element | null): string[] => (el === null ? [] : [el, ...Array.from(el.querySelectorAll('[data-definition]'))]
    .map((d) => d.getAttribute('data-definition'))
    .filter((id): id is string => Boolean(id)));
  const describedBy = (block: Element): string[] => [block, ...Array.from(block.querySelectorAll('[aria-describedby]'))]
    .flatMap((el) => (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean))
    .map((id) => document.getElementById(id)?.getAttribute('data-definition'))
    .filter((id): id is string => Boolean(id));
  const blockKeys = new Map<Element, string>();
  const nodes: TextNodeInfo[] = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || skip.has(parent.tagName) || parent.closest('nav') !== null) continue;
    if (!parent.checkVisibility() || parent.closest('[data-definition]') !== null) continue;
    if (legalRoute && parent.closest('[data-legal-text]') !== null) continue;
    const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    const termIds: string[] = [];
    for (let el: Element | null = parent; el !== null && el !== main.parentElement; el = el.parentElement) {
      const id = el.getAttribute('data-term');
      if (id) termIds.push(id);
    }
    const block = parent.closest(blockSelector);
    let blockKey = `none-${nodes.length}`;
    const ids = new Set(definitionsIn(parent.closest('.ui-field, .ui-callout')));
    if (block !== null) {
      if (!blockKeys.has(block)) blockKeys.set(block, `block-${blockKeys.size}`);
      blockKey = blockKeys.get(block) as string;
      for (const id of [...definitionsIn(block), ...definitionsIn(block.nextElementSibling), ...describedBy(block)]) ids.add(id);
    }
    nodes.push({ text, termIds, blockKey, definitionIdsInBlock: [...ids], inRoleChoice: parent.closest('[data-role-choice]') !== null });
  }
  return nodes;
}

/** Sets `html` as the page and runs the collector on it, as on `legalRoute` or not. */
async function collect(page: Page, html: string, legalRoute = false): Promise<TextNodeInfo[] | null> {
  await page.setContent(`<!doctype html><title>t</title>${html}`);
  return page.evaluate(collectTextNodes, { blockSelector: BLOCK_SELECTOR, legalRoute });
}

test('vocabulary first use (helper): the collector reads main outside nav, in order, with terms, blocks, definitions and role choices', async ({ page }) => {
  await page.setContent(`<!doctype html><title>t</title><nav><a>Outside main</a></nav><main>
    <nav><a>Findings</a></nav>
    <p><span data-term="finding">finding</span> <span data-definition="finding">A gap your team has noted.</span></p>
    <ul><li>Open the finding <script>var x = 'finding';</script></li></ul>
    <fieldset data-role-choice><legend>Role</legend><label>Owner</label></fieldset>
    <div>Loose text</div>
  </main>`);
  const nodes = await page.evaluate(collectTextNodes, { blockSelector: BLOCK_SELECTOR, legalRoute: false });
  expect(nodes?.map((n) => n.text)).toEqual(['finding', 'Open the finding', 'Role', 'Owner', 'Loose text']);
  const [term, later, legend, owner, loose] = nodes!;
  expect(term).toEqual({ text: 'finding', termIds: ['finding'], blockKey: 'block-0', definitionIdsInBlock: ['finding'], inRoleChoice: false });
  expect(later).toMatchObject({ termIds: [], blockKey: 'block-1', definitionIdsInBlock: [], inRoleChoice: false });
  expect(legend.inRoleChoice).toBe(true);
  expect(owner).toMatchObject({ blockKey: 'block-3', inRoleChoice: true });
  expect(loose).toMatchObject({ blockKey: 'none-4', definitionIdsInBlock: [] });
  expect(firstUseViolations(nodes!, CONCEPTS)).toEqual([{ id: 'owner', text: 'Owner' }]);
  await page.setContent('<!doctype html><title>t</title><div>No main here</div>');
  expect(await page.evaluate(collectTextNodes, { blockSelector: BLOCK_SELECTOR, legalRoute: false })).toBeNull();
});

test('vocabulary first use (helper): legal text on a legal route, a definition\'s own text and hidden text are not uses (L2-25, L2-27, L2-30)', async ({ page }) => {
  const legal = '<main><div data-legal-text><p>Each seal is final.</p></div><p>After it.</p></main>';
  expect((await collect(page, legal, true))?.map((n) => n.text)).toEqual(['After it.']);
  // Off S-06's routes the marker exempts nothing, as in the claims crawl.
  expect((await collect(page, legal, false))?.map((n) => n.text)).toEqual(['Each seal is final.', 'After it.']);
  // A definition's sentence names other terms; it is not a use, and its element still defines its block.
  const definition = await collect(page, '<main><p><span data-term="assessor">Assessor</span> <span data-definition="assessor">Raises findings and opens stage reviews.</span></p></main>');
  expect(definition?.map((n) => n.text)).toEqual(['Assessor']);
  expect(definition?.[0].definitionIdsInBlock).toEqual(['assessor']);
  // Text the reader cannot see is not where a term first appears on a screen.
  const hidden = await collect(page, '<main><p hidden>A seal, hidden.</p><p style="display:none">A seal, not shown.</p><details><summary>More</summary><p>A seal, folded.</p></details><p>A seal, shown.</p></main>');
  expect(hidden?.map((n) => n.text)).toEqual(['More', 'A seal, shown.']);
});

test('vocabulary first use (helper): a definition is beside its term in the block, the next element, the field or callout, or by aria-describedby; two siblings away it is not (L2-29)', async ({ page }) => {
  const idsOf = async (html: string) => (await collect(page, `<main>${html}</main>`))![0].definitionIdsInBlock;
  // In the block, as the plan has it.
  expect(await idsOf('<p><span data-term="seal">seal</span> <span data-definition="seal">d</span></p>')).toEqual(['seal']);
  // The element right after the block: a heading and its hint line.
  expect(await idsOf('<h2><span data-term="seal">Seal</span></h2><p data-definition="seal">d</p>')).toEqual(['seal']);
  expect(await idsOf('<h2><span data-term="seal">Seal</span></h2><div><p data-definition="seal">d</p></div>')).toEqual(['seal']);
  // The closest .ui-field: a label whose hint sits outside it, in the same field.
  expect(await idsOf('<div class="ui-field"><label><span data-term="seal">Seal</span></label><input><p data-definition="seal">d</p></div>')).toEqual(['seal']);
  // aria-describedby on a control inside the block names the definition's id.
  expect(await idsOf('<label><span data-term="seal">Seal</span> <input aria-describedby="x hint"></label><div></div><p id="hint" data-definition="seal">d</p>')).toEqual(['seal']);
  // Two siblings away is not beside.
  expect(await idsOf('<h2><span data-term="seal">Seal</span></h2><p>Other</p><p data-definition="seal">d</p>')).toEqual([]);
});

/** Filled by the crawl and asserted by the expected failure; reset when the crawl starts. */
let hits: Hit[] = [];
let crawled = false;

test.describe.serial('vocabulary first use', () => {
  test('vocabulary first use: every seat\'s crawl reaches its pages and reads their main text', async ({ browser, baseURL, playwright }) => {
    test.setTimeout(15 * 60_000);
    hits = [];
    crawled = false;
    const defined = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'vocabulary.json'), 'utf8')) as { concepts: Array<{ defineOnFirstUse: boolean }> })
      .concepts.filter((c) => c.defineOnFirstUse).length;
    expect(defined, 'data/vocabulary.json has concepts to check').toBeGreaterThan(0);
    expect(CONCEPTS.filter((c) => c.defineOnFirstUse).length, 'the crawl checks every first-use concept of data/vocabulary.json').toBe(defined);

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8')) as FixtureManifest;
    const slug = manifest.orgs[0].slug;
    const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
    if (!owner) throw new Error(`vocabulary-first-use: no owner seat for ${slug} in the fixture manifest`);
    // connection: close, for the reason e2e/claims-crawl.spec.ts gives (an idle keep-alive socket reset by the server).
    const api = await playwright.request.newContext({ baseURL, storageState: owner.storageStatePath, extraHTTPHeaders: { connection: 'close' } });
    // The loopback guard of e2e/helpers/loopbackOnly.ts refuses a relative path and a request that may redirect, so the
    // seeding posts go out as absolute URLs on the test server with maxRedirects: 0.
    const post: Pick<typeof api, 'post'>['post'] = (url, options) => api.post(new URL(url, baseURL).href, { ...options, maxRedirects: 0 });
    const crawlProject = await seedCrawlProject({ post }, baseURL, slug, `Vocabulary first-use crawl project ${Date.now()}`);
    await api.dispose();

    const starts = ['/', `/orgs/${slug}/projects/${crawlProject.id}`, ...staticPagesIn('(authenticated)').filter((p) => !(p in NOT_CRAWLED))];
    const follows = (pathname: string) => ownProject(pathname, crawlProject);
    const seats: Array<{ label: string; storageStatePath: string; starts: string[]; mustReach: Array<string | RegExp> }> = FIXTURE_ROLES.map((role) => {
      const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === role && u.index === 0);
      if (!seat) throw new Error(`vocabulary-first-use: no ${role} seat for ${slug} in the fixture manifest`);
      return {
        label: role,
        storageStatePath: seat.storageStatePath,
        starts,
        mustReach: [`/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`, `/orgs/${slug}/projects/${crawlProject.id}`, '/explore/framework', '/explore/controls', '/about'],
      };
    });
    // The platform administrator is in no organisation: `/` sends it to S-23, and its list is the claims crawl's.
    seats.push({
      label: 'platform administrator',
      storageStatePath: adminSeat().storageStatePath,
      starts: ['/'],
      mustReach: ['/admin/organisations', '/admin/accounts', '/admin/organisations/new', /^\/admin\/organisations\/[0-9a-f-]{36}$/],
    });

    const reachedBySomeSeat: string[] = [];
    for (const seat of seats) {
      const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
      await abortPendingBackgroundRequests(context);
      const page = await context.newPage();
      failOnDialog(page);
      let found = 0;
      const pages = await reachablePages(page, seat.starts, { max: MAX_PAGES, label: seat.label, follows }, async (key) => {
        const legalRoute = isLegalTextRoute(new URL(page.url()).pathname);
        const nodes = await page.evaluate(collectTextNodes, { blockSelector: BLOCK_SELECTOR, legalRoute });
        expect(nodes, `${seat.label} ${key}: the page has no main`).not.toBeNull();
        expect(nodes!.length, `${seat.label} ${key}: no visible text node in main outside nav`).toBeGreaterThan(0);
        for (const v of firstUseViolations(nodes!, CONCEPTS)) {
          hits.push({ seat: seat.label, page: key, id: v.id, text: v.text });
          found += 1;
        }
      });
      for (const must of seat.mustReach) {
        const reached = typeof must === 'string' ? pages.includes(must) : pages.some((p) => must.test(p));
        expect(reached, `${seat.label} reached ${must}`).toBe(true);
      }
      reachedBySomeSeat.push(...pages);
      console.log(`[vocabulary-first-use] ${seat.label}: ${pages.length} pages, ${found} violations: ${pages.join(' ')}`);
      await context.close();
    }
    expect(unaccounted('(authenticated)', reachedBySomeSeat, NOT_CRAWLED), 'authenticated page files no seat crawl reads').toEqual([]);

    const lines = worklist(hits);
    const byId = new Map<string, number>();
    for (const line of lines) {
      const id = line.split(':')[0].split(' ')[1];
      byId.set(id, (byId.get(id) ?? 0) + 1);
    }
    const ranked = [...byId].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    console.log(`[vocabulary-first-use] ${hits.length} violations, ${lines.length} worklist lines; lines by id: ${ranked.map(([id, n]) => `${id} ${n}`).join(', ')}`);
    for (const line of lines) console.log(`[vocabulary-first-use] ${line}`);
    const dir = process.env.VOCABULARY_HITS_DIR;
    if (dir) fs.writeFileSync(path.join(dir, 'vocabulary-first-use-hits.txt'), `${lines.join('\n')}\n`);
    crawled = true;
  });

  test('vocabulary first use (worklist until Task 20)', () => {
    test.skip(!crawled, 'the crawl test did not finish, so there is nothing to judge');
    test.fail();
    expect(hits.length, `first uses not beside their definition:\n${worklist(hits).join('\n')}`).toBe(0);
  });
});
