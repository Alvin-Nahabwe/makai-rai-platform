import { test, expect, request as pwRequest, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, adminSeat, type FixtureManifest } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { expectNoScoreShapes } from './helpers/noScore';
import { NEVER_WORDS, STATUS_LABEL } from '../lib/claims/pattern';
import { claimsOutsideNames, claimsOutsideNamesJoined, readFrameworkNames } from '../__tests__/helpers/frameworkNames';
import { allowListedQuestionTexts, cleanText } from '../__tests__/helpers/contentQuestions';
import { abortPendingBackgroundRequests, assertNoStalePendingTargets } from './helpers/pendingLinks';
import { reachablePages } from './helpers/reachablePages';
import { isLegalTextRoute, pageFiles, staticPagesIn, templateRegExp, unaccounted } from './helpers/pageFiles';
import { ownProject, seedCrawlProject } from './helpers/crawlProject';
import { ERRORS_COPY } from '../lib/errors/copy';

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
 * `data/content`. Most pages show only the application's own words; S-26 (`/explore/framework`) shows the content's
 * area texts and research sources. Those that hold a claim word stay unchanged in v1 (ruling 2, coordinator ruling 6
 * of 5 Nov 2026) and are exempt as the content allow-list's `{ path, text }` entries name them (CONTENT_TEXTS,
 * C4 fix round 1); a cited work's verbatim title is exempt the same way (ruling 3). A framework area or control
 * name is exempt wherever it appears verbatim (FRAMEWORK_NAMES), as in the source and content lint.
 * Generated documents are not pages; DOC-a and DOC-b run the phrase test over their output.
 */


const MAX_PAGES = 60;

/**
 * At the release candidate (the content gate's own condition, RELEASE_CANDIDATE=1) no interim exemption applies:
 * not OWNED_ELSEWHERE. Its entries are known
 * findings of other units, listed so the branch can merge; a candidate that still needs them is not a candidate.
 */
const RELEASE_CANDIDATE = process.env.RELEASE_CANDIDATE === '1';

/** The heading of `app/error.tsx`, which a page that crashed in the browser shows with status 200. */
const ERROR_PAGE_HEADING = ERRORS_COPY.error.heading;

/**
 * Page files this crawl does not read, by route template (route groups removed), each with why and what
 * picks it up. A key that is not a page file, or that a crawl did reach, fails the completeness check, so
 * the list cannot go stale.
 */
/**
 * Page files that only redirect permanently (ACC-a Task 13): a crawl that reaches the target has read the words
 * the old path serves, so the page file counts as reached; a signed-out start at the old path must end there.
 */
const REDIRECTS_TO: Record<string, string> = { '/terms': '/legal/terms', '/privacy': '/legal/privacy' };
const withRedirects = (pages: string[]): string[] => [...pages, ...Object.keys(REDIRECTS_TO).filter((from) => pages.includes(REDIRECTS_TO[from]))];

const NOT_CRAWLED: Record<string, string> = {
  '/acceptances': 'S-05 renders only for an account missing an acceptance, and every fixture seat holds all three (FR-ACC-04); e2e/acceptances.spec.ts renders it, and S-04\'s second step, and runs claimMatches over each',
  '/invitations/[token]': 'needs an invitation token that only a member invitation makes (csp.spec.ts makes one); ACC-a and ORG rebuild invitations',
  '/dev/ui-kit': 'development gallery',
};

/**
 * INTERIM. Rendered text of pages that another unit owns and rebuilds, which the widened pattern flags and which
 * PUB does not reword, by route template; the same finding as OWNED_ELSEWHERE in
 * __tests__/lint/no-product-claims.test.ts. Each text is one body text node of the page, and only a body text node
 * equal to it is dropped from the check (no attribute, title or note). The page must still show the text and the text must still be a claim, or the entry is
 * stale and the visit fails; delete the entry with the fix. Empty since C-TXT's fix round 1: S-26's framework texts
 * and `/explore/controls`' two control descriptions that hold a claim word are exempt as allow-listed content texts
 * (CONTENT_TEXTS), and "Define when to retrain" no longer matches the pattern.
 */
const OWNED_ELSEWHERE: Record<string, string[]> = {};

/**
 * The content allow-list: `__tests__/lint/claim-allowlist.json`, the file PUB's content gate reads
 * (`__tests__/lint/no-product-claims.test.ts`), so one list governs content and rendered pages (coordinator ruling 3).
 */
const CONTENT_ALLOWLIST = path.join(process.cwd(), '__tests__', 'lint', 'claim-allowlist.json');

/**
 * The texts of the allow-list's `{ path, text, reason }` content entries, each a verbatim string of the content (a
 * framework text kept under ruling 2, or the title of a cited work), each owner-reviewed with its reason. After the same
 * whitespace clean-up the word reader applies, a source title on S-26 (`SOURCE_TITLE`, `allowedTitlesOn`) whose whole
 * text equals one is exempt, and so is a body or source-note text node on any page (`CONTENT_TEXTS`, C4 fix round 1).
 * No attribute and no part of a node is. `{ id, reason }` entries name a question (AL-7) and are read by
 * `ALLOWED_QUESTION_TEXTS` below, not here. The lint checks the entries' shape.
 */
function contentAllowedTexts(file: string, onlyFile?: string): string[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${file}: expected an array of { id, reason } or { path, text, reason }`);
  return raw.flatMap((e: unknown) => {
    const entry = e as { path?: unknown; text?: unknown } | null;
    // Only a content entry (`<file>.json#<path>`) names a source title; a source-file entry exempts one string in one file of app/ or components/.
    const ok = entry && typeof entry.path === 'string' && entry.path.includes('#') && typeof entry.text === 'string' && (onlyFile === undefined || entry.path.startsWith(`${onlyFile}#`));
    return ok ? [cleanText(entry.text as string)] : [];
  });
}

const CONTENT_ALLOWED: readonly string[] = contentAllowedTexts(CONTENT_ALLOWLIST);
/**
 * The allow-listed framework texts a body or note node may equal: only the `assessmentAreas.json#` entries, which are
 * what /explore/framework and /explore/controls show (coordinator ruling on re-review RR1-4). The question bank's
 * option entries (Q-PO-11's three) stay with the lint: a short option shown as a whole node can read as a platform
 * claim beside a neighbouring node ("Achieved:"), and no crawled page needs them.
 */
const CONTENT_TEXTS: ReadonlySet<string> = new Set(contentAllowedTexts(CONTENT_ALLOWLIST, 'assessmentAreas.json'));

/**
 * The question texts the allow-list's `{ id, reason }` entries name (AL-7), as every version data/content/index.json lists
 * words them (the owner-reviewed wordings; the lint exempts the id in every version), read with the lint's reader
 * (`__tests__/helpers/contentQuestions.ts`; coordinator ruling, 5 Nov 2026). The server this crawl runs against serves the
 * fixture bundle, release candidate included (playwright.config.ts), whose stems are frozen at v0.5.0; a unit test
 * (`__tests__/unit/fixture-content-bundle.test.ts`) checks each one is such a wording. On any page, a body text node whose whole cleaned text equals one is exempt, as narrow
 * as the source-title exemption: the same text with other words in its node, an attribute value (C4 F4), or any other
 * node holding the claim word is still read. An id that names no question in the bundle throws when the spec loads.
 */
const ALLOWED_QUESTION_TEXTS: ReadonlySet<string> = new Set(
  allowListedQuestionTexts(JSON.parse(fs.readFileSync(CONTENT_ALLOWLIST, 'utf8')) as unknown[], path.join(process.cwd(), 'data', 'content')),
);

/**
 * The `%` alternative of the claim pattern (`NEVER_WORDS`). SRS 7.5.3 bans a percentage "next to the team's items",
 * and a cited study's figure is not one (coordinator ruling 2, unit/cnt): in a source note (`data-source-note`,
 * ReferencesList's relevance note) a match of this alternative alone is not a claim. Every other word of the list
 * in a note still is, and a percentage anywhere else still is one. PUB's content gate skips the same alternative in
 * the same field (`__tests__/lint/no-product-claims.test.ts`), and expectNoScoreShapes the same percentages.
 */
const SOURCE_NOTE_PERCENT_ALTERNATIVE = String.raw`\d\s?%`;
const SOURCE_NOTE_PERCENT = new RegExp(`^(?:${SOURCE_NOTE_PERCENT_ALTERNATIVE})$`);

/**
 * `notes`: the text nodes inside `data-source-note` elements; `titles`: the text nodes of S-26's source titles
 * (ReferencesList's `.references-list__link` inside `.references-list`). Both are kept apart from `body` so the claim
 * check can tell them: a note's cited figure is no claim, and a title is where an allow-list entry applies.
 * `attributes`: the spoken attribute values and button values, kept apart from the text nodes so that no text-node
 * exemption (CONTENT_TEXTS, ALLOWED_QUESTION_TEXTS) reaches them; only a team's own text drops one (C4 F4).
 */
type Words = { head: string[]; body: string[]; notes: string[]; titles: string[]; attributes: string[] };

/**
 * The mitigation status words (SRS 5.3 item 11, the `STATUS_WORD` values of components/followup/StageFollowUp.tsx). A text node
 * that is exactly one of them inside a `.status-label` is a status, not a claim about progress; the same words anywhere else
 * are read as before. (The source lint exempts the same string through a claim-allowlist.json source entry.)
 */
const MITIGATION_STATUS_WORDS: ReadonlySet<string> = new Set(['Planned', 'In progress']);

/** The source titles ReferencesList renders: a cited work's citation, the one element an allow-list entry exempts. */
const SOURCE_TITLE = '.references-list .references-list__link';

/**
 * The allow-listed texts that apply on a page: on S-26, whose sources are content's (areas[].references[].citation,
 * the paths the allow-list names), and nowhere else (review r1 M-1).
 */
function allowedTitlesOn(pathname: string, allowed: readonly string[]): readonly string[] {
  return pathname === '/explore/framework' ? allowed : [];
}

/** Legal pages the marker crawl starts from: a kind's current page and a version page. */
const LEGAL_STARTS = ['/legal/terms', '/legal/privacy', '/legal/privacy/1'];

/**
 * The words on the page that a person reads or hears, one entry per text node or attribute value, outside the
 * elements that carry `data-claims-allowed`: every text node of the body (a mounted but closed panel
 * included, because text in the DOM is still on the page), the title and the description (`head`), and the
 * attributes a screen reader speaks. A page whose body has no words is refused: the title alone would
 * otherwise make an empty page pass for one with no claim.
 */
async function readWords(page: Page, who: string, pathname = ''): Promise<Words> {
  const words = await page.evaluate(({ sourceTitle, statusWords, legalRoute }) => {
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const outside = (el: Element) => el.closest('[data-claims-allowed]') === null;
    // The words of a published legal text (owner ruling R1): the block LegalTextView marks, on S-06's two routes only. A marker
    // anywhere else exempts nothing, and the attributes below are read inside it as everywhere.
    const inLegalText = (el: Element) => legalRoute && el.closest('[data-legal-text]') !== null;
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
    const head: string[] = [document.title];
    const description = document.querySelector('meta[name="description"]')?.getAttribute('content');
    if (description) head.push(description);
    const body: string[] = [];
    const notes: string[] = [];
    const titles: string[] = [];
    const attributes: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || skip.has(parent.tagName) || !outside(parent) || inLegalText(parent)) continue;
      if (parent.closest('.status-label') !== null && statusWords.includes(clean(node.nodeValue ?? ''))) continue;
      const into = parent.closest('[data-source-note]') !== null ? notes : parent.closest(sourceTitle) !== null ? titles : body;
      into.push(node.nodeValue ?? '');
    }
    const spoken = ['aria-label', 'aria-description', 'title', 'alt', 'placeholder'];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      // Spoken attributes are read on a marked element too: a marker exempts its sentence, not what a screen reader adds.
      for (const name of spoken) {
        const value = el.getAttribute(name);
        if (value) attributes.push(value);
      }
      if (el instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(el.type) && el.value) attributes.push(el.value);
    }
    return {
      head: head.map(clean).filter(Boolean),
      body: body.map(clean).filter(Boolean),
      notes: notes.map(clean).filter(Boolean),
      titles: titles.map(clean).filter(Boolean),
      attributes: attributes.map(clean).filter(Boolean),
    };
  }, { sourceTitle: SOURCE_TITLE, statusWords: [...MITIGATION_STATUS_WORDS], legalRoute: isLegalTextRoute(pathname) });
  if (words.body.length === 0 && words.notes.length === 0 && words.titles.length === 0 && words.attributes.length === 0) throw new Error(`${who}: the page has no words to check`);
  return words;
}

/**
 * The framework's own area and control names, read from the running version's assessmentAreas.json in data/content
 * when the spec loads (coordinator ruling, 5 Nov 2026, on the owner's sitting 2 answer T4 "allow"; C4 CR-4). A name
 * such as "Reproducibility Failure" is framework source text, so where it appears verbatim within one text node it is
 * not a claim; a match not wholly inside a name still is, and a name holding a claim word that is not one of the
 * reviewed three is not exempt (`REVIEWED_CLAIM_NAMES`). The same rule as the source and content lint
 * (`__tests__/helpers/frameworkNames.ts`).
 */
const FRAMEWORK_NAMES: readonly string[] = readFrameworkNames();
const claimsOf = (text: string) => claimsOutsideNames(text, FRAMEWORK_NAMES);

/**
 * Every claim in `words`, with a little of what is around it. `teamText` is what people of the organisation
 * typed (a project's name and description): it is theirs and not the platform's. Another spec's project called
 * "No-score crawl project" sits in the same organisation, and a team may name a project anything. Only a text
 * node or attribute whose whole value is one of those strings is dropped, so a name that is one letter, or that
 * is part of a longer platform sentence, changes nothing else on the page. A body text node whose whole text is an
 * allow-listed question text (ALLOWED_QUESTION_TEXTS, AL-7) or an allow-listed content text (CONTENT_TEXTS) is
 * dropped too, and so is a source note that is a content text; an attribute value never is. `ownedText`, a page's
 * OWNED_ELSEWHERE texts, drops only a body text node that equals one (RR1-5). Framework names are set aside node by
 * node before the nodes are joined (C4 CR-2).
 */
function claimsIn(words: Words, teamText: readonly string[] = [], allowedTitles: readonly string[] = [], ownedText: readonly string[] = []): string[] {
  const team = new Set(teamText);
  const owned = new Set(ownedText);
  const segments = [
    ...words.head,
    ...words.body.filter((segment) => !team.has(segment) && !owned.has(segment) && !ALLOWED_QUESTION_TEXTS.has(segment) && !CONTENT_TEXTS.has(segment)),
    ...words.attributes.filter((segment) => !team.has(segment)),
  ];
  const { joined: own, matches } = claimsOutsideNamesJoined(segments, FRAMEWORK_NAMES);
  const found: string[] = [];
  for (const m of matches) {
    found.push(`"${m.text}" in "${own.slice(Math.max(0, m.index - 30), m.index + m.text.length + 30)}"`);
  }
  // A text node that is only a status label ("Complete") is anchored, so it is tested alone, before nodes are joined.
  for (const segment of [...words.body, ...words.attributes, ...words.titles, ...words.notes]) {
    if (!team.has(segment) && STATUS_LABEL.test(segment)) found.push(`"${segment}" as a whole text node`);
  }
  // A source title is read node by node; one the allow-list names exactly (`allowedTitles`, S-26 only) is exempt.
  const allowed = new Set(allowedTitles);
  for (const segment of words.titles) {
    if (team.has(segment) || allowed.has(segment)) continue;
    for (const m of claimsOf(segment)) found.push(`"${m.text}" in "${segment.slice(Math.max(0, m.index - 30), m.index + m.text.length + 30)}"`);
  }
  // A source note is read node by node, without a cited figure: the `%` alternative alone is skipped there.
  for (const segment of words.notes) {
    if (team.has(segment) || CONTENT_TEXTS.has(segment)) continue;
    for (const m of claimsOf(segment)) {
      if (!SOURCE_NOTE_PERCENT.test(m.text)) found.push(`"${m.text}" in "${segment.slice(Math.max(0, m.index - 30), m.index + m.text.length + 30)}"`);
    }
  }
  return found;
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
    .map((t) => cleanText(t))
    .filter((t) => t.length > 0);
}

/**
 * What to run on each page the crawl keeps: collects every claim, and fails on a score shape, a script error
 * or the error page. `teamText` gives what the organisation's people typed; it is asked only for pages under
 * `/orgs/`, where that text is shown, and after the page's words are read, never before: another spec may name
 * a project while this one crawls (two workers share the organisation), and a list read later than the page
 * holds every project the page can show.
 */
/**
 * Why each of a page's OWNED_ELSEWHERE texts is stale, if it is: the page no longer shows it as a body text node, or it
 * is no longer a claim (C4 F3, RR1-1). An empty list means every entry still holds.
 */
function ownedProblems(owned: readonly string[], words: Words): string[] {
  return owned.flatMap((text) => [
    ...(words.body.includes(text) ? [] : [`"${text}" is no longer shown; delete its entry`]),
    ...(claimsOf(text).length > 0 ? [] : [`"${text}" is no longer a claim; delete its entry`]),
  ]);
}

function pageChecker(page: Page, who: string, teamText: () => Promise<string[]>): { claims: string[]; legalTextBlocks: Array<{ pathname: string; count: number }>; check: (url: string) => Promise<void>; finish: () => Promise<void> } {
  const claims: string[] = [];
  const legalTextBlocks: Array<{ pathname: string; count: number }> = [];
  const scriptErrors: string[] = [];
  const pending: Array<{ url: string; pathname: string; words: Words; owned: string[] }> = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));
  const check = async (url: string): Promise<void> => {
    const pathname = new URL(page.url()).pathname;
    const words = await readWords(page, `${who} ${url}`, pathname);
    expect(await page.locator('h1', { hasText: ERROR_PAGE_HEADING }).count(), `${who} ${url} shows the error page`).toBe(0);
    expect(scriptErrors, `${who} ${url} threw in the browser`).toEqual([]);
    const marked = await page.locator('[data-legal-text]').count();
    legalTextBlocks.push({ pathname, count: marked });
    // Every seat's crawl: only S-06's two route templates may hold the marker (the exemption is read nowhere else).
    if (!isLegalTextRoute(pathname)) expect(marked, `${who} ${url}: data-legal-text on a page that is not S-06`).toBe(0);
    const owned = Object.entries(OWNED_ELSEWHERE).filter(([template]) => !RELEASE_CANDIDATE && templateRegExp(template).test(pathname)).flatMap(([, texts]) => texts);
    expect(ownedProblems(owned, words), `${who} ${url}: stale OWNED_ELSEWHERE entries`).toEqual([]);
    pending.push({ url, pathname, words, owned });
    await expectNoScoreShapes(page, `${who} ${url}`);
  };
  /**
   * Judges the words of every page kept, once the crawl of this seat is over. The team text (what the organisation's people
   * typed) is read ONCE here, so the crawl stays under the rate limit and the list is read later than every page it can show:
   * another spec may name a project while this one crawls (two workers share the organisation).
   */
  const finish = async (): Promise<void> => {
    const own = pending.some((p) => p.pathname.startsWith('/orgs/')) ? await teamText() : [];
    for (const p of pending) {
      for (const found of claimsIn(p.words, p.pathname.startsWith('/orgs/') ? own : [], allowedTitlesOn(p.pathname, CONTENT_ALLOWED), p.owned)) claims.push(`${who} ${p.url}: ${found}`);
    }
  };
  return { claims, legalTextBlocks, check, finish };
}

test('FR-PUB-01 (helper): the word reader and the claim pattern flag a claim and skip an allowed element', async ({ page }) => {
  await page.setContent(`<!doctype html><title>t</title><main>
    <p>Audit-ready reports.</p>
    <p>Aligned to ISO/IEC 42001 clauses</p>
    <p data-claims-allowed="why-no-score"><span>The score was never calibrated.</span></p>
    <button aria-label="Responsible AI compliance">x</button>
    <input type="submit" value="Certified submit">
    <p>Cannot see your records.</p>
    <img alt="Using complex models whose decisions cannot be understood, explained, or audited by the people affected.">
    <button aria-label="Have you ensured compliance with applicable data protection regulations and ethical guidelines?">x</button>
  </main>`);
  const claims = claimsIn(await readWords(page, 'self-test'));
  // The last two are allow-listed texts (IP-03.description, Q-PO-22.text) in attributes: the reader keeps them out of
  // the text nodes, so no text-node exemption reaches them (C4 F4, RR1-2).
  expect(claims.length, claims.join('; ')).toBe(7);
  expect(claims.some((c) => /score/i.test(c)), 'the allowed element is skipped').toBe(false);
  expect(claims.some((c) => /compliance/i.test(c)), 'an aria-label is read').toBe(true);
  expect(claims.some((c) => /certified/i.test(c)), 'a button value is read').toBe(true);
});

// Shaped like S-06: a title and an <article> holding an <h1>, the marked block, and a sibling paragraph, each with a claim word.
// The title and the heading carry different words, so a finding names which of them it came from.
// The span inside the block holds a spoken attribute: a marker exempts body text, never what a screen reader adds.
const LEGAL_PAGE_HTML = '<!doctype html><title>Compliance notice - MAK-AI</title><main><article><h1>Score notice</h1>'
  + '<div data-legal-text><p>We certify this.</p><span aria-label="Certified badge">x</span></div><p>Certified by us.</p></article></main>';

test('FR-PUB-01: a claim word outside the legal-text block of a legal page still fails', async ({ page }) => {
  await page.setContent(LEGAL_PAGE_HTML);
  for (const pathname of ['/legal/terms', '/legal/privacy/2']) {
    const claims = claimsIn(await readWords(page, 'self-test', pathname));
    // Four findings, as read: the document title, the heading of the enclosing article, the sibling paragraph and the
    // aria-label inside the block. "certify" in the block's body is skipped.
    expect(claims.length, `${pathname}: ${claims.join('; ')}`).toBe(4);
    expect(claims.filter((c) => c.startsWith('"Compliance"')), `${pathname}: the document title`).toHaveLength(1);
    expect(claims.filter((c) => c.startsWith('"Score"')), `${pathname}: the heading of the enclosing article`).toHaveLength(1);
    expect(claims.some((c) => /Certified by us/.test(c)), `${pathname}: the sibling`).toBe(true);
    expect(claims.some((c) => /Certified badge/.test(c)), `${pathname}: the spoken attribute inside the block`).toBe(true);
    expect(claims.some((c) => /We certify this/.test(c)), `${pathname}: the block's body is skipped`).toBe(false);
  }
});

test('FR-PUB-01: data-legal-text on a non-legal route exempts nothing', async ({ page }) => {
  await page.setContent(LEGAL_PAGE_HTML);
  // One, two, three and four segments: a route list widened to a template of any of those lengths would exempt one of these.
  for (const pathname of ['/about', '/', '/legal', '/explore/framework', '/orgs/acme', '/legal/terms/2/extra', '/orgs/acme/legal/terms', '/explore/legal/terms', '']) {
    const claims = claimsIn(await readWords(page, 'self-test', pathname));
    expect(claims.length, `${pathname}: ${claims.join('; ')}`).toBe(5);   // the title, the heading, the block's body, the sibling, the attribute
    expect(claims.filter((c) => c.startsWith('"Compliance"')), `${pathname}: the document title`).toHaveLength(1);
    expect(claims.filter((c) => c.startsWith('"Score"')), `${pathname}: the heading`).toHaveLength(1);
    expect(claims.some((c) => /We certify this/.test(c)), `${pathname}: the block's body is read`).toBe(true);
  }
});

test('FR-PUB-01 (helper): a framework area or control name passes only where it appears verbatim; a non-name "failure" is still found', () => {
  const words = (body: string[]): Words => ({ head: ['t'], body, notes: [], titles: [], attributes: [] });
  expect(FRAMEWORK_NAMES).toEqual(expect.arrayContaining(['Model Robustness Failure', 'Reproducibility Failure']));
  expect(claimsIn(words(['Risk areas', 'Model Robustness Failure', 'Reproducibility Failure']))).toEqual([]);
  expect(claimsIn(words(['Model Robustness Failure', 'Builds that fail'])).join(';')).toMatch(/"fail"/);
  expect(claimsIn(words(['model robustness failure'])).length, 'a lowercased name is not the name').toBe(1);
  expect(claimsIn(words(['Reproducibility Failures'])).length, 'a longer word is not the name').toBe(1);
});

test('FR-PUB-01 AL-7 (helper): an allow-listed question text passes as a whole text node only, and an id that names no question throws', () => {
  const words = (body: string[]): Words => ({ head: ['t'], body, notes: [], titles: [], attributes: [] });
  const stem = 'Have you ensured compliance with applicable data protection regulations and ethical guidelines?';   // Q-PO-22.text
  expect(ALLOWED_QUESTION_TEXTS.has(stem), 'Q-PO-22 is allow-listed by id and resolves to the running text').toBe(true);
  // The fixture the server serves keeps 5.0.0's wording of Q-PO-14; 5.1.0 rewords it. Both wordings are reviewed, so both pass.
  expect(ALLOWED_QUESTION_TEXTS.has('Is the system designed to gracefully degrade or fail safely when it encounters out-of-distribution inputs?')).toBe(true);
  expect(claimsIn(words(['Post-processing', stem]))).toEqual([]);
  // The same stem with more words in its node is not the stem: the claim word in it is found.
  expect(claimsIn(words([`${stem} We are fully covered.`])).join(';')).toMatch(/compliance/);
  // Another node with the claim word is still found beside the exempt stem.
  expect(claimsIn(words([stem, 'Full compliance'])).length).toBe(1);
  // An id the running bundle does not hold fails loudly.
  const root = test.info().outputPath('content');
  fs.mkdirSync(path.join(root, '9.9.9'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ running: '9.9.9', versions: ['9.9.9'] }));
  fs.writeFileSync(path.join(root, '9.9.9', 'questionBank.json'), JSON.stringify({ stages: { a: { modules: [{ questions: [{ id: 'Q-1', text: 'Have  you\nchecked?' }] }] } } }));
  expect(allowListedQuestionTexts([{ id: 'Q-1', reason: 'x' }], root)).toEqual(['Have you checked?']);
  expect(() => allowListedQuestionTexts([{ id: 'Q-NONE', reason: 'x' }], root)).toThrow(/Q-NONE names no question/);
});

test('FR-PUB-01 (helper, C4 fix round 1): an allow-listed content text passes as a whole body or note node only; attributes and split names are still read', () => {
  const text = 'Using complex models whose decisions cannot be understood, explained, or audited by the people affected.';   // IP-03.description, allow-listed by path
  expect(CONTENT_TEXTS.has(text), 'IP-03.description is a { path, text } entry of the allow-list').toBe(true);
  const w = (o: Partial<Words>): Words => ({ head: ['t'], body: [], notes: [], titles: [], attributes: [], ...o });
  // The whole node passes, in the body and as a source note, on any page.
  expect(claimsIn(w({ body: ['Opacity', text] }))).toEqual([]);
  expect(claimsIn(w({ body: ['Fine'], notes: [text] }))).toEqual([]);
  // The same text plus a word in its node is not the entry.
  expect(claimsIn(w({ body: [`${text} Really.`] })).join(';')).toMatch(/audited/);
  expect(claimsIn(w({ body: ['Fine'], notes: [`${text} Really.`] })).join(';')).toMatch(/audited/);
  // Another node holding the claim word is still found beside the exempt one.
  expect(claimsIn(w({ body: [text, 'Audited daily'] })).length).toBe(1);
  // An attribute value is never exempt, as a content text (F4) or as an allow-listed question text.
  expect(claimsIn(w({ body: ['Fine'], attributes: [text] })).join(';')).toMatch(/audited/);
  const stem = 'Have you ensured compliance with applicable data protection regulations and ethical guidelines?';   // Q-PO-22.text
  expect(claimsIn(w({ body: ['Fine'], attributes: [stem] })).join(';')).toMatch(/compliance/);
  // A framework name split across two nodes is not the name (CR-2); within one node it is.
  expect(claimsIn(w({ body: ['Model Robustness', 'Failure'] })).join(';')).toMatch(/Failure/);
  expect(claimsIn(w({ body: ['Model Robustness Failure'] }))).toEqual([]);
  // Only assessmentAreas.json entries are content texts here: Q-PO-11's option beside "Achieved:" is a claim (RR1-4).
  expect(CONTENT_TEXTS.has('Compliance with national data protection laws')).toBe(false);
  expect(claimsIn(w({ body: ['Achieved:', 'Compliance with national data protection laws'] })).join(';')).toMatch(/Compliance/);
  // An owned text drops only a body node equal to it, never an attribute (RR1-5).
  expect(claimsIn(w({ body: ['Audit-ready'] }), [], [], ['Audit-ready'])).toEqual([]);
  expect(claimsIn(w({ body: ['Fine'], attributes: ['Audit-ready'] }), [], [], ['Audit-ready']).length).toBe(1);
  // A stale owned entry is reported: not shown, or no longer a claim (F3, RR1-1).
  const retrain = 'Define when to retrain: what performance thresholds trigger it, who approves it, and how you validate the new version.';
  expect(ownedProblems([retrain], w({ body: [retrain] }))).toEqual([`"${retrain}" is no longer a claim; delete its entry`]);
  expect(ownedProblems(['Audit-ready'], w({ body: ['Fine'] }))).toEqual(['"Audit-ready" is no longer shown; delete its entry']);
  expect(ownedProblems(['Audit-ready'], w({ body: ['Audit-ready'] }))).toEqual([]);
  // Nothing is left for OWNED_ELSEWHERE to hold.
  expect(Object.keys(OWNED_ELSEWHERE)).toEqual([]);
  expect(claimsOf('Define when to retrain: what performance thresholds trigger it, who approves it, and how you validate the new version.')).toEqual([]);
});

test('FR-PUB-01 (helper): only a whole text node a team typed is dropped; one letter or part of a platform sentence hides nothing', () => {
  const words = (body: string[]): Words => ({ head: ['t'], body, notes: [], titles: [], attributes: [] });
  // The team's text is dropped when it is the whole node, and the platform's own claim beside it is still found.
  expect(claimsIn(words(['Projects', 'No-score crawl project 17', 'audit-ready reports']), ['No-score crawl project 17']).join(';')).toMatch(/audit-ready/i);
  expect(claimsIn(words(['No-score crawl project 17']), ['No-score crawl project 17'])).toEqual([]);
  // A project named "e" does not break "compliance" apart (a substring mask would).
  expect(claimsIn(words(['Full compliance']), ['e', 'c', 'o']).length).toBe(1);
  // A project named like a claim word hides only a node that is exactly that word.
  expect(claimsIn(words(['We guarantee compliance']), ['compliance']).length).toBe(1);
  expect(claimsIn(words(['compliance']), ['compliance'])).toEqual([]);
});

test('FR-PUB-01 (helper): a text the content allow-list names exactly passes as S-26\'s source title only; elsewhere, or with one word changed, it fails', async ({ page }) => {
  const title = 'Inherent Trade-Offs in the Fair Determination of Risk Scores.';
  const file = test.info().outputPath('claim-allowlist.json');
  fs.writeFileSync(file, JSON.stringify([
    { path: 'assessmentAreas.json#areas[0].references[0].citation', text: title, reason: 'verbatim title of a cited work' },
    { id: 'Q-1', reason: 'an id entry names a question, not a rendered text' },
    { path: 'components/followup/StageFollowUp.tsx', text: 'In progress', reason: 'a source-file entry exempts one string of one file, never an S-26 source title' },
  ]));
  const allowed = contentAllowedTexts(file);
  expect(allowed).toEqual([title]);
  const sourceTitle = (t: string) => `<details class="references-list"><summary>Research sources (1)</summary><ul><li><a class="references-list__link" href="#">${t}</a></li></ul></details>`;
  const read = async (html: string) => { await page.setContent(`<!doctype html><title>t</title><main>${html}</main>`); return readWords(page, 'self-test'); };
  // As S-26's source title the exact text passes; with one word changed it is flagged.
  expect(claimsIn(await read(sourceTitle(title)), [], allowedTitlesOn('/explore/framework', allowed))).toEqual([]);
  expect(claimsIn(await read(sourceTitle(title.replace('Fair', 'Just'))), [], allowedTitlesOn('/explore/framework', allowed)).join(';')).toMatch(/"Scores"/);
  // The entry exempts the source title and nothing else (review r1 M-1): the same text in another element, in a spoken
  // attribute, or as a source title on another page is flagged.
  expect(claimsIn(await read(`<p>${title}</p>`), [], allowedTitlesOn('/explore/framework', allowed)).join(';')).toMatch(/"Scores"/);
  expect(claimsIn(await read(`<p>Fine</p><button aria-label="${title}">x</button>`), [], allowedTitlesOn('/explore/framework', allowed)).join(';')).toMatch(/"Scores"/);
  expect(claimsIn(await read(sourceTitle(title)), [], allowedTitlesOn('/explore/controls', allowed)).join(';')).toMatch(/"Scores"/);
  // The crawl reads the file PUB's content gate reads (__tests__/lint/no-product-claims.test.ts), so one list governs both.
  expect(path.relative(process.cwd(), CONTENT_ALLOWLIST)).toBe(path.join('__tests__', 'lint', 'claim-allowlist.json'));
  expect(() => contentAllowedTexts(CONTENT_ALLOWLIST)).not.toThrow();
});

test('FR-PUB-01 FR-FUP-01 (helper): the mitigation status word passes inside .status-label only; elsewhere, or with other words, it is flagged', async ({ page }) => {
  const read = async (html: string) => { await page.setContent(`<!doctype html><title>t</title><main>${html}</main>`); return readWords(page, 'self-test'); };
  expect(claimsIn(await read('<p>Fine</p><span class="status-label">In progress</span> <span class="status-label">Planned</span>'))).toEqual([]);
  expect(claimsIn(await read('<p>In progress</p>')).join(';')).toMatch(/"progress"/i);
  expect(claimsIn(await read('<span class="status-label">Progress report ready</span>')).join(';')).toMatch(/progress/i);
  // Exact match only: the status word inside a longer text is read as before (a substring or prefix match would skip the claim).
  expect(claimsIn(await read('<span class="status-label">In progress: the stage has progressed</span>')).join(';')).toMatch(/progress/i);
  expect(claimsIn(await read('<span class="status-label">Not In progress</span>')).join(';')).toMatch(/progress/i);
});

test('FR-PUB-01 (helper): a cited figure in a source note (data-source-note) passes the claim check; a % in a question or an area description, or a claim word in a note, is flagged', async ({ page }) => {
  // SRS 7.5.3 bans a percentage "next to the team's items"; a cited study's figure is not one (coordinator ruling 2).
  await page.setContent(`<!doctype html><title>t</title><main>
    <h3>Do 40% of your items have a decision?</h3>
    <p class="area-card__desc">Fine for 12% of rows.</p>
    <span data-source-note>Error rates up to 34.7% for darker-skinned women against 0.8% for lighter-skinned men.</span>
    <span data-source-note>An empirical audit that found 3.3% label errors.</span>
  </main>`);
  const claims = claimsIn(await readWords(page, 'self-test'));
  expect(claims.filter((c) => /^"\d\s?%"/.test(c)).map((c) => c.split(' in ')[0]).sort()).toEqual(['"0%"', '"2%"']);
  expect(claims.some((c) => /34\.7%|0\.8%|3\.3%/.test(c.split(' in ')[0])), claims.join('; ')).toBe(false);
  expect(claims.some((c) => /^"audit"/.test(c)), claims.join('; ')).toBe(true);
  expect(claims, claims.join('; ')).toHaveLength(3);
  // The skip is the `%` alternative alone; it stays in step with the pattern it carves out.
  expect(NEVER_WORDS).toContain(SOURCE_NOTE_PERCENT_ALTERNATIVE);
});

test('FR-RM-01 (helper): a percentage in a cited study\'s note (data-source-note) passes; a percentage elsewhere, or a score word in the note, still fails', async ({ page }) => {
  // SRS 7.5.3 bans a percentage "next to the team's items"; a cited figure is not one (coordinator ruling 2).
  const note = '<span data-source-note>error rates up to 34.7% for darker-skinned women</span>';
  await page.setContent(`<!doctype html><title>t</title><main><p>A study. ${note}</p></main>`);
  await expect(expectNoScoreShapes(page, 'self-test')).resolves.toBeUndefined();
  await page.setContent(`<!doctype html><title>t</title><main><p>A study. ${note}</p><p>12% of your items</p></main>`);
  const elsewhere = await expectNoScoreShapes(page, 'self-test').then(() => '', (e: Error) => e.message);
  expect(elsewhere).toMatch(/percentage "12%"/);
  expect(elsewhere).not.toMatch(/34\.7%/);
  await page.setContent('<!doctype html><title>t</title><main><p><span data-source-note>a maturity band of 40%</span></p></main>');
  const words = await expectNoScoreShapes(page, 'self-test').then(() => '', (e: Error) => e.message);
  expect(words).toMatch(/score word "maturity"/);
  expect(words).toMatch(/score word "band"/);
  expect(words).not.toMatch(/percentage/);
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
  assertNoStalePendingTargets();
  const context = await browser.newContext({ baseURL });
  await abortPendingBackgroundRequests(context);   // a prefetch of a pending shell target never settles, and `networkidle` waits for it
  const page = await context.newPage();
  failOnDialog(page);
  const mustReach = staticPagesIn('(public)');
  const signedOut = pageChecker(page, 'signed out', async () => []);   // a signed-out page shows no team text
  const pages = await reachablePages(page, ['/', ...mustReach], { max: MAX_PAGES, label: 'signed out' }, signedOut.check);
  await signedOut.finish();
  console.log(`[claims-crawl] signed out: ${pages.length} pages: ${pages.join(' ')}`);
  // These were also given as starts, so this proves each answers 200 signed out and is not sent to /login.
  for (const must of mustReach) expect(pages, `signed out answered ${must} without sending it elsewhere`).toContain(REDIRECTS_TO[must] ?? must);
  expect(unaccounted('(public)', withRedirects(pages), NOT_CRAWLED), 'public page files no crawl reads').toEqual([]);

  expect(signedOut.claims, 'claims on pages reachable signed out').toEqual([]);
  await context.close();
});

test('FR-PUB-01: data-legal-text appears only on /legal pages', async ({ browser, baseURL }) => {
  test.setTimeout(5 * 60_000);
  const context = await browser.newContext({ baseURL });
  await abortPendingBackgroundRequests(context);
  const page = await context.newPage();
  failOnDialog(page);
  const crawl = pageChecker(page, 'signed out', async () => []);
  // The legal pages are given as starts, so the crawl reaches a marked page whatever else it follows.
  await reachablePages(page, ['/', ...LEGAL_STARTS], { max: MAX_PAGES, label: 'signed out' }, crawl.check);
  const marked = crawl.legalTextBlocks.filter((b) => b.count > 0);
  expect(marked.length, 'the crawl reached a legal page that carries the marker').toBeGreaterThan(0);
  expect(marked.filter((b) => !isLegalTextRoute(b.pathname)), 'pages that carry data-legal-text but are not S-06').toEqual([]);
  expect(marked.filter((b) => b.count !== 1), 'a legal page carries the marker once').toEqual([]);
  await context.close();
});

test('FR-PUB-01: no page reachable as any organisation role shows a product claim', async ({ browser, baseURL }) => {
  test.setTimeout(15 * 60_000);
  const manifest = readManifest();
  const slug = manifest.orgs[0].slug;

  // The crawl's OWN project, made through the existing APIs before anything is crawled (never through the browser), so which
  // pages are reachable does not depend on what other specs have written. It holds exactly what the data-dependent pages need:
  // a decision on Q-PP-01 (S-12 links its history, S-13), a team finding (S-15) and an opened and sealed stage review (S-16, S-17).
  const owner = manifest.users.find((u) => u.orgSlug === slug && u.role === 'owner' && u.index === 0);
  if (!owner) throw new Error(`claims-crawl: no owner seat for ${slug} in the fixture manifest`);
  // connection: close, because Node's server destroys an idle keep-alive socket 6 s after its last response, and Playwright's
  // pooled socket has no idle timer: a GET sent just then, while the server is busy, is reset (read ECONNRESET).
  const api = await pwRequest.newContext({ baseURL, storageState: owner.storageStatePath, extraHTTPHeaders: { connection: 'close' } });
  const crawlProject = await seedCrawlProject(api, baseURL, slug, `Claims crawl project ${Date.now()}`);
  const list: ProjectList = async () => {
    const response = await api.get(`/api/v1/orgs/${slug}/projects`);
    expect(response.status(), 'listing the projects of the organisation').toBe(200);
    return (await response.json()) as Array<{ name: string; description: string | null }>;
  };
  const teamText = () => projectTexts(list);

  // Pages no sidebar link leads to are started from their files: the authenticated pages with no dynamic
  // segment, but not those NOT_CRAWLED names, so a deleted page leaves the list by itself.
  // The crawl reads one page per route pattern, the first it meets. S-10 names its questions with no decision, as links, before
  // anything else that leads to a question (Route R5), so the decided question (Q-PP-01, e2e/helpers/crawlProject.ts), whose page links its history (S-13),
  // is a start of its own: otherwise the question pattern is read on a question with no history to link.
  const decided = `/orgs/${slug}/projects/${crawlProject.id}/stages/pre-processing/questions/Q-PP-01`;
  const starts = ['/', decided, `/orgs/${slug}/projects/${crawlProject.id}`, ...staticPagesIn('(authenticated)').filter((p) => !(p in NOT_CRAWLED))];
  const reachedBySomeSeat: string[] = [];
  const claims: string[] = [];
  for (const role of FIXTURE_ROLES) {
    const seat = manifest.users.find((u) => u.orgSlug === slug && u.role === role && u.index === 0);
    if (!seat) throw new Error(`claims-crawl: no ${role} seat for ${slug} in the fixture manifest`);
    const label = `${slug}/${role}`;
    const context = await browser.newContext({ baseURL, storageState: seat.storageStatePath });
    await abortPendingBackgroundRequests(context);
    const page = await context.newPage();
    failOnDialog(page);
    const seatChecker = pageChecker(page, label, teamText);
    const pages = await reachablePages(page, starts, { max: MAX_PAGES, label, follows: (pathname) => ownProject(pathname, crawlProject) }, seatChecker.check);
    await seatChecker.finish();
    reachedBySomeSeat.push(...pages);
    console.log(`[claims-crawl] ${label}: ${pages.length} pages: ${pages.join(' ')}`);

    // A crawl that stopped at the landing page would pass for having found nothing. The sidebar leads to
    // the explore pages and to About.
    const mustReach: Array<string | RegExp> = [
      `/orgs/${slug}/dashboard`, `/orgs/${slug}/projects`, `/orgs/${slug}/projects/${crawlProject.id}`,
      '/explore/framework', '/explore/controls', '/about',
    ];
    for (const must of mustReach) {
      const reached = typeof must === 'string' ? pages.includes(must) : pages.some((p) => must.test(p));
      expect(reached, `${label} reached ${must}`).toBe(true);
    }
    claims.push(...seatChecker.claims);
    await context.close();
  }
  // The platform administrator (adminSeat(), units/ORG.md Task 8b): from `/`, which sends it to S-23, through S-24 and
  // S-25. It is in no organisation, so it has no team text of its own.
  {
    const label = 'platform administrator';
    const context = await browser.newContext({ baseURL, storageState: adminSeat().storageStatePath });
    await abortPendingBackgroundRequests(context);
    const page = await context.newPage();
    failOnDialog(page);
    const seatChecker = pageChecker(page, label, async () => []);
    const pages = await reachablePages(page, ['/'], { max: MAX_PAGES, label }, seatChecker.check);
    reachedBySomeSeat.push(...pages);
    console.log(`[claims-crawl] ${label}: ${pages.length} pages: ${pages.join(' ')}`);
    for (const must of ['/admin/organisations', '/admin/accounts', '/admin/organisations/new', /^\/admin\/organisations\/[0-9a-f-]{36}$/] as Array<string | RegExp>) {
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
