import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, test, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import {
  addDecision, addFinding, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { adminSeat } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { signInWith } from './helpers/session';

/**
 * The shared in-place confirmation (components/ui/InlineConfirm.tsx) on each of the screens that use it (SC 2.4.11, SC 2.4.3,
 * NFR-A11Y-02, UX-29, UX-42; register D-386):
 *   - a confirmation opened with the keyboard is wholly in view, inside the window and inside the visible box of every
 *     scrolling ancestor, and the element the screen moves focus to has it and is wholly in view;
 *   - the confirm button keeps keyboard focus while its request is held, says `aria-busy="true"` and is not disabled, and a
 *     second Enter sends nothing;
 *   - a pointer press on a partly visible control inside an open confirmation still acts on that control.
 *
 * The failing geometry is arranged on purpose (`arrange`): the confirmation opens across the bottom edge of the window, and
 * where the screen moves focus into it, a strip of STRIP pixels of the element that takes focus already shows. A focus target
 * that is wholly hidden is scrolled in by the browser itself, so without the strip a case would pass with no repair at all.
 * A first, probing open measures where that element lands; it is cancelled, then the page is scrolled (instantly) or, where
 * it is too short to scroll that far, the window is shortened, until the element's top sits STRIP pixels above the bottom of
 * the scroller's visible box. Each case prints the window size it used.
 *
 * Every record is the spec's own: one organisation from K0a's record fixture (buildOrg), its documents written as rows
 * (addIssuedDocument), so no document is issued through the route and its hourly limit is not spent; the owner and the
 * viewer sign in once through the login form. The first-owner invitation box (S-24) is the platform administrator's seat,
 * with an organisation it creates through the route per case.
 */

const STRIP = 32;
const MIN_STRIP = 24;
const WIDE = { width: 1280, height: 720 } as const;
const NARROW = { width: 320, height: 568 } as const;
const CONTENT_SEMVER = '0.0.1-fixture';

let fx: OrgFixture;
let contentVersionId: string;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-confirm-e2e-'));
const sessions: Record<'owner' | 'viewer', string> = { owner: path.join(dir, 'owner.json'), viewer: path.join(dir, 'viewer.json') };

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  fx = await buildOrg({ label: 'confirm' });
  contentVersionId = (await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: CONTENT_SEMVER } })).id;
  for (const role of ['owner', 'viewer'] as const) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/login');
    await signInWith(page, fx.members[role].email, fx.members[role].password);
    await context.storageState({ path: sessions[role] });
    await context.close();
  }
});

test.afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

type Who = 'owner' | 'viewer' | 'admin';

/** A page signed in as `who`, with the window at `size`; any dialog fails the test. */
async function pageAs(browser: Browser, who: Who, size: { width: number; height: number }): Promise<Page> {
  const storageState = who === 'admin' ? adminSeat().storageStatePath : sessions[who];
  const context = await browser.newContext({ storageState, viewport: { ...size } });
  const page = await context.newPage();
  failOnDialog(page);
  return page;
}

const projectPath = (projectId: string) => `/orgs/${fx.org.slug}/projects/${projectId}`;
const questionPath = (projectId: string, questionId: string) => `${projectPath(projectId)}/stages/pre-processing/questions/${questionId}`;

/** A project with one decision on `questionId`, entered by the assessor; the owner may withdraw it. */
async function decided(questionId: string): Promise<string> {
  const project = await addProject(fx, { name: `Confirm ${randomUUID().slice(0, 8)}` });
  await addDecision(fx, project.id, {
    stage: 'pre-processing', questionId, contentVersionId, decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-30',
  });
  return project.id;
}

/** S-18 of a review holding one live data card. */
async function documentPage(): Promise<{ url: string; documentId: string }> {
  const project = await addProject(fx, { name: `Confirm ${randomUUID().slice(0, 8)}` });
  const review = await addStageReview(fx, project.id, { stage: 'pre-processing' });
  const seal = await addSealRow(fx, review.id, { contentVersionId });
  const doc = await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id] });
  return { url: `${projectPath(project.id)}/reviews/${review.id}/documents`, documentId: doc.id };
}

/** A team finding raised by the reviewer, which the owner may withdraw. */
async function findingPage(): Promise<{ url: string; findingId: string }> {
  const project = await addProject(fx, { name: `Confirm ${randomUUID().slice(0, 8)}` });
  const finding = await addFinding(fx, project.id, { stage: 'post-processing', source: 'team', by: 'reviewer' });
  return { url: `${projectPath(project.id)}/findings/${finding.id}`, findingId: finding.id };
}

/** An organisation the platform administrator creates through route 40, its first-owner invitation pending. */
async function ownerInvitationOrg(baseURL: string): Promise<{ orgId: string; email: string }> {
  const email = `confirm-owner-${randomUUID().slice(0, 8)}@fixture.test`;
  const api = await pwRequest.newContext({ baseURL, storageState: adminSeat().storageStatePath, extraHTTPHeaders: { origin: baseURL } });
  try {
    const res = await api.post('/api/admin/organisations', {
      data: { requestId: randomUUID(), name: `Confirm Lab ${randomUUID().slice(0, 8)}`, legalName: 'Makerere University', ownerEmail: email, showLink: false },
    });
    expect(res.status(), 'creating the organisation').toBe(201);
    return { orgId: ((await res.json()) as { orgId: string }).orgId, email };
  } finally {
    await api.dispose();
  }
}

/** A pending member invitation of the fixture organisation, made by its owner through the route. */
let pendingInvitation: Promise<string> | undefined;
function pendingEmail(baseURL: string): Promise<string> {
  pendingInvitation ??= (async () => {
    const email = `confirm-pending-${randomUUID().slice(0, 8)}@fixture.test`;
    const api = await pwRequest.newContext({ baseURL, storageState: sessions.owner, extraHTTPHeaders: { origin: baseURL } });
    try {
      const res = await api.post(`/api/v1/orgs/${fx.org.slug}/members`, { data: { requestId: randomUUID(), email, role: 'reviewer', showLink: false } });
      expect(res.status(), 'the pending invitation').toBe(201);
      return email;
    } finally {
      await api.dispose();
    }
  })();
  return pendingInvitation;
}

/** One screen's confirmation: how to reach it, what opens it, and where the screen puts focus when it opens. */
type Opened = {
  trigger: Locator;
  confirmation: Locator;
  /** The element the screen focuses on open, or 'trigger' where focus stays on the button that opened it. */
  focus: Locator | 'trigger';
  /** True where the focus target is inside the confirmation, so the kit's focus check applies to it. */
  focusInside: boolean;
};
type Screen = { name: string; who: Who; open: (page: Page, baseURL: string) => Promise<Opened> };

/** Loads `url` and waits until the page has settled its requests, so a press reaches a hydrated control. */
async function load(page: Page, url: string): Promise<void> {
  const res = await page.goto(url);
  expect(res?.status(), url).toBe(200);
  await page.waitForLoadState('networkidle');
}

const SCREENS: Screen[] = [
  {
    name: 'account deletion (S-21)', who: 'viewer',
    open: async (page) => {
      await load(page, '/account');
      const confirmation = page.getByRole('group', { name: 'Your account' });
      return { trigger: page.getByRole('button', { name: 'Delete my account...' }), confirmation, focus: confirmation.getByLabel('Password', { exact: true }), focusInside: true };
    },
  },
  {
    name: 'documents (S-18)', who: 'owner',
    open: async (page) => {
      await load(page, (await documentPage()).url);
      const confirmation = page.getByRole('group', { name: /^Data card issued / });
      return { trigger: page.getByRole('button', { name: 'Withdraw document' }), confirmation, focus: confirmation.getByLabel('Reason (required)'), focusInside: true };
    },
  },
  {
    name: 'decision withdrawal on the history page (S-13)', who: 'owner',
    open: async (page) => {
      await load(page, `${questionPath(await decided('Q-PP-01'), 'Q-PP-01')}/history`);
      const confirmation = page.getByRole('group', { name: 'Version 1 of the decision on Q-PP-01' });
      return { trigger: page.getByRole('button', { name: 'Withdraw this decision' }), confirmation, focus: confirmation.getByLabel('Withdrawal code (required)'), focusInside: true };
    },
  },
  {
    name: 'decision withdrawal on the question page, inside More (S-12)', who: 'owner',
    open: async (page) => {
      await load(page, questionPath(await decided('Q-PP-01'), 'Q-PP-01'));
      await page.locator('summary', { hasText: /^More$/ }).click();
      const confirmation = page.getByRole('group', { name: 'Version 1 of the decision on Q-PP-01' });
      return { trigger: page.getByRole('button', { name: 'Withdraw this decision' }), confirmation, focus: confirmation.getByLabel('Withdrawal code (required)'), focusInside: true };
    },
  },
  {
    name: 'findings (S-15)', who: 'owner',
    open: async (page) => {
      await load(page, (await findingPage()).url);
      const confirmation = page.getByRole('group', { name: /^Finding: / });
      return { trigger: page.getByRole('button', { name: 'Withdraw', exact: true }), confirmation, focus: confirmation.getByRole('button', { name: 'Withdraw finding' }), focusInside: true };
    },
  },
  {
    name: 'archive project (S-10)', who: 'owner',
    open: async (page) => {
      const name = `Confirm archive ${randomUUID().slice(0, 8)}`;
      const project = await addProject(fx, { name });
      await load(page, projectPath(project.id));
      const confirmation = page.getByRole('group', { name: `Archive ${name}?` });
      // The screen focuses the wrapper around the confirmation (ArchiveProjectControl.tsx), which is not inside it.
      return { trigger: page.getByRole('button', { name: 'Archive project' }).first(), confirmation, focus: confirmation.locator('xpath=..'), focusInside: false };
    },
  },
  {
    name: 'members, remove (S-26)', who: 'owner',
    open: async (page) => {
      await load(page, `/orgs/${fx.org.slug}/settings/members`);
      const name = fx.members.viewer.name;
      return { trigger: page.getByRole('button', { name: `Remove ${name}` }), confirmation: page.getByRole('group', { name }), focus: 'trigger', focusInside: false };
    },
  },
  {
    name: 'members, revoke (S-26)', who: 'owner',
    open: async (page, baseURL) => {
      const email = await pendingEmail(baseURL);
      await load(page, `/orgs/${fx.org.slug}/settings/members`);
      return {
        trigger: page.getByRole('button', { name: `Revoke invitation for ${email}` }), confirmation: page.getByRole('group', { name: `Invitation for ${email}` }),
        focus: 'trigger', focusInside: false,
      };
    },
  },
  {
    name: 'first-owner invitation (S-24)', who: 'admin',
    open: async (page, baseURL) => {
      const { orgId, email } = await ownerInvitationOrg(baseURL);
      await load(page, `/admin/organisations/${orgId}`);
      return {
        trigger: page.getByRole('button', { name: 'Revoke invitation' }).first(), confirmation: page.getByRole('group', { name: `Invitation to ${email}` }),
        focus: 'trigger', focusInside: false,
      };
    },
  },
];

/**
 * Where an element sits in its scroller: the scroller is its nearest ancestor that scrolls vertically (`.app-main` above
 * 768 px), or the document. `contentTop` is the element's top in the scroller's content, which no scroll changes;
 * `visibleTop` and `visibleBottom` bound the part of the scroller the window shows.
 */
type Place = { contentTop: number; top: number; bottom: number; visibleTop: number; visibleBottom: number; scrollTop: number; maxScroll: number; scroller: string };
const placeOf = (target: Locator): Promise<Place> => target.evaluate((el): Place => {
  let s: Element | null = el.parentElement;
  while (s !== null && s !== document.body && s !== document.documentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) break;
    s = s.parentElement;
  }
  const doc = s === null || s === document.body || s === document.documentElement;
  const scroller = doc ? (document.scrollingElement as Element) : s!;
  const winH = document.documentElement.clientHeight;
  const boxTop = doc ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
  const visibleTop = Math.max(0, boxTop);
  const visibleBottom = doc ? winH : Math.min(winH, boxTop + scroller.clientHeight);
  const r = el.getBoundingClientRect();
  const name = doc ? 'the document' : `${scroller.tagName.toLowerCase()}.${Array.from(scroller.classList).join('.')}`;
  return {
    contentTop: r.top - boxTop + scroller.scrollTop, top: r.top, bottom: r.bottom, visibleTop, visibleBottom,
    scrollTop: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight, scroller: name,
  };
});

/** Scrolls the scroller of `el` to `top`, instantly (the page's own scroll is smooth: app/globals.css). */
const scrollTo = (el: Locator, top: number): Promise<void> => el.evaluate((node, y) => {
  let s: Element | null = node.parentElement;
  while (s !== null && s !== document.body && s !== document.documentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) break;
    s = s.parentElement;
  }
  const doc = s === null || s === document.body || s === document.documentElement;
  (doc ? (document.scrollingElement as Element) : s!).scrollTo({ top: y, behavior: 'instant' });
}, top);

/**
 * Waits until `el` holds still: the same box on two reads 100 ms apart. A scroll that the browser makes on focus() is smooth
 * here, so a box read during it reads a page in motion.
 */
async function settled(page: Page, el: Locator): Promise<void> {
  const handle = await el.elementHandle();
  expect(handle, 'the element to wait on is in the page').not.toBeNull();
  await page.evaluate(() => { (window as unknown as { confirmLastBox?: string }).confirmLastBox = ''; });
  await page.waitForFunction((node) => {
    const w = window as unknown as { confirmLastBox?: string };
    const r = (node as Element).getBoundingClientRect();
    const box = `${r.left},${r.top},${r.right},${r.bottom}`;
    const same = w.confirmLastBox === box;
    w.confirmLastBox = box;
    return same;
  }, handle, { polling: 100 });
  await handle!.dispose();
}

/**
 * Arranges the failing geometry: opens the confirmation once to learn where the element that takes the strip lands (the
 * focus target, or the confirmation itself where focus stays on the trigger), cancels it, then puts that element's top STRIP
 * pixels above the bottom of the visible box, by an instant scroll, or by shortening the window where the page cannot be
 * scrolled that far up, and checks that it did. Two geometries cannot be had and are taken instead, each named in the
 * case's `geometry` annotation and printed: the element lies past the end of the page before the confirmation opens (no
 * scroll shows a strip of it: the page is scrolled to its end and the element opens hidden), or the window would have to be
 * shorter than the confirmation (it is held at the least height that holds it, and the element shows more than the strip).
 * Returns the window size used and which geometry it is.
 */
async function arrange(page: Page, o: Opened): Promise<{ width: number; height: number; how: string }> {
  await o.trigger.click();
  await expect(o.confirmation).toBeVisible();
  const stripOf = o.focus === 'trigger' ? o.confirmation : o.focus;
  const probe = await placeOf(stripOf);
  const whole = await placeOf(o.confirmation);
  await o.confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(o.confirmation).toHaveCount(0);
  let how = '';
  for (let i = 0; i < 4 && how === ''; i += 1) {
    const now = await placeOf(o.trigger);
    // The scrollTop that puts the element's top at visibleBottom - STRIP: its top in the box is contentTop - scrollTop.
    const boxTop = now.top - (now.contentTop - now.scrollTop);   // the scroller's content origin at scrollTop 0
    const want = Math.round(boxTop + probe.contentTop - (now.visibleBottom - STRIP));
    if (want > now.maxScroll) {
      // The element lies at or past the end of the page as it is before the confirmation opens, so no scroll shows a strip
      // of it: the page is scrolled to its end, and the element opens below the edge, wholly hidden.
      await scrollTo(o.trigger, now.maxScroll);
      how = `no strip possible: the element would need a scroll of ${want} px and ${now.scroller} scrolls ${now.maxScroll} px; scrolled to the end, the element opens hidden`;
      break;
    }
    if (want >= 0) {
      await scrollTo(o.trigger, want);
      how = `strip of ${STRIP} px`;
      break;
    }
    // Too near the top to scroll there: the window is shortened by what is missing, but never below what holds the whole
    // confirmation (a case the repair could not pass proves nothing); there, the element shows more than the strip.
    const size = page.viewportSize()!;
    const least = Math.ceil(size.height - (now.visibleBottom - now.visibleTop) + (whole.bottom - whole.top) + 8);
    const height = Math.max(least, size.height + want);
    if (height === size.height) {
      how = `window held at ${height} px, the least that holds the confirmation: the element shows ${Math.round(now.visibleBottom - (boxTop + probe.contentTop))} px, more than the strip`;
      break;
    }
    await page.setViewportSize({ width: size.width, height });
  }
  if (how === '') throw new Error('cannot arrange: four resizes did not settle the geometry');
  await settled(page, o.trigger);
  const trig = await placeOf(o.trigger);
  expect(trig.top >= trig.visibleTop && trig.bottom <= trig.visibleBottom, `the trigger is wholly in view before it is pressed (${Math.round(trig.top)} to ${Math.round(trig.bottom)})`).toBe(true);
  if (how.startsWith('strip')) {
    // Where the element will open: its content top less the scroll now, in the scroller's box. A strip of it shows, at least
    // MIN_STRIP px and not much more than STRIP (a page may settle a pixel or two after the scroll), and the rest is cut.
    const now = await placeOf(o.trigger);
    const opensAt = now.top - (now.contentTop - now.scrollTop) + probe.contentTop - now.scrollTop;
    const shows = now.visibleBottom - opensAt;
    expect(shows >= MIN_STRIP && shows <= STRIP + 4 && shows < probe.bottom - probe.top,
      `a strip of ${MIN_STRIP} to ${STRIP + 4} px of the element shows, and not all of it (it shows ${Math.round(shows)} px of ${Math.round(probe.bottom - probe.top)})`).toBe(true);
  }
  test.info().annotations.push({ type: 'geometry', description: `window ${page.viewportSize()!.width}x${page.viewportSize()!.height}; ${how}` });
  return { ...page.viewportSize()!, how };
}

/**
 * Every edge of the confirmation's box against the window and against the visible box of every ancestor that clips
 * (overflow other than visible), measured once. Returns the failures, empty when it is wholly in view.
 */
const outOfView = (confirmation: Locator): Promise<string[]> => confirmation.evaluate((el) => {
  const out: string[] = [];
  const slack = 0.5;
  const r = el.getBoundingClientRect();
  const box = (a: { left: number; top: number; right: number; bottom: number }) => `${Math.round(a.left)},${Math.round(a.top)} to ${Math.round(a.right)},${Math.round(a.bottom)}`;
  const inside = (b: { left: number; top: number; right: number; bottom: number }) =>
    r.left >= b.left - slack && r.top >= b.top - slack && r.right <= b.right + slack && r.bottom <= b.bottom + slack;
  const win = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
  if (!inside(win)) out.push(`the confirmation ${box(r)} is not inside the window ${box(win)}`);
  for (let a = el.parentElement; a !== null && a !== document.body && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const b = a.getBoundingClientRect();
    const visible = { left: b.left + a.clientLeft, top: b.top + a.clientTop, right: b.left + a.clientLeft + a.clientWidth, bottom: b.top + a.clientTop + a.clientHeight };
    if (!inside(visible)) out.push(`the confirmation ${box(r)} is not inside ${a.tagName.toLowerCase()}.${Array.from(a.classList).join('.')} ${box(visible)}`);
  }
  return out;
});

const isFocused = (el: Locator): Promise<boolean> => el.evaluate((node) => node === document.activeElement);

for (const screen of SCREENS) {
  for (const [label, size] of [['1280 wide', WIDE], ['320 wide', NARROW]] as const) {
    test(`SC 2.4.11 NFR-A11Y-02 UX-29: ${screen.name} at ${label}: the confirmation opened with the keyboard is wholly in view and focus is where the screen puts it`, async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const page = await pageAs(browser, screen.who, size);
      const opened = await screen.open(page, baseURL!);
      const used = await arrange(page, opened);
      console.log(`${screen.name} at ${label}: window ${used.width}x${used.height}; ${used.how}`);
      await opened.trigger.focus();
      await page.keyboard.press('Enter');
      await expect(opened.confirmation).toBeVisible();
      await settled(page, opened.confirmation);
      expect(await outOfView(opened.confirmation), `${screen.name}: the confirmation is wholly in view (window ${used.width}x${used.height})`).toEqual([]);
      const focus = opened.focus === 'trigger' ? opened.trigger : opened.focus;
      expect(await isFocused(focus), `${screen.name}: focus is on ${opened.focus === 'trigger' ? 'the button that opened it' : 'the element the screen focuses'}`).toBe(true);
      if (opened.focusInside) await expectFocusVisibleAndUncovered(page);
      await page.context().close();
    });
  }
}

/**
 * Holds the requests to `url` with `method` until `release()`, then answers them with `answer`. Every such request the page
 * sends is counted from the page's own request events, not only those the route saw, and `done()` checks the count and takes
 * the route off: each test calls it after the screen's final state, so a late duplicate is still counted and no request is
 * left waiting.
 */
async function hold(page: Page, url: string | RegExp, method: string, answer: (route: Route) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const matches = (requestUrl: string) => (typeof url === 'string' ? new URL(requestUrl).pathname.endsWith(url) : url.test(requestUrl));
  let routed = 0;
  let sent = 0;
  page.on('request', (req) => { if (req.method() === method && matches(req.url())) sent += 1; });
  const handler = async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    routed += 1;
    await held;
    await answer(route);
  };
  const pattern = typeof url === 'string' ? `**${url}` : url;
  await page.route(pattern, handler);
  const answered = page.waitForResponse((res) => res.request().method() === method && matches(res.url()));
  answered.catch(() => {});   // awaited in release(); this only keeps a test that fails before then from leaving it unhandled
  return {
    routed: () => routed,
    async release() { release(); await answered; },
    async done() {
      expect(sent, 'the page sent one request').toBe(1);
      expect(routed, 'one request reached the route').toBe(1);
      await page.unroute(pattern, handler);
    },
  };
}

/**
 * Presses Enter on the focused confirm button with its request held, and while it is held checks once that the button still
 * has focus, says aria-busy="true" and is not disabled; presses Enter again; releases and waits for the answer. The caller
 * checks the screen's end state and then `held.done()`, which counts the requests.
 */
async function busyPress(page: Page, confirm: Locator, held: Awaited<ReturnType<typeof hold>>): Promise<void> {
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect.poll(held.routed, { message: 'the request reached the route' }).toBe(1);
  const state = await confirm.evaluate((el) => ({ focused: el === document.activeElement, busy: el.getAttribute('aria-busy'), disabled: (el as HTMLButtonElement).disabled }));
  expect(state, 'while the request is held the confirm button keeps focus, is aria-busy and is not disabled').toEqual({ focused: true, busy: 'true', disabled: false });
  await page.keyboard.press('Enter');
  await held.release();
}

test.describe('the confirm button while the request is sent', () => {
  test('SC 2.4.3 UX-29 NFR-A11Y-02: documents (S-18) at 1280 wide: the confirm button keeps focus while the withdrawal is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'owner', WIDE);
    const doc = await documentPage();
    await load(page, doc.url);
    await page.getByRole('button', { name: 'Withdraw document' }).click();
    const confirmation = page.getByRole('group', { name: /^Data card issued / });
    await confirmation.getByLabel('Reason (required)').fill('Sent to the wrong committee.');
    const held = await hold(page, `/documents/${doc.documentId}/withdrawal`, 'POST', (r) => r.continue());
    await busyPress(page, confirmation.getByRole('button', { name: 'Withdraw document' }), held);
    await expect(page.getByRole('status').filter({ hasText: /^Withdrawn\.$/ })).toBeVisible();
    expect(await testDb.documentEvent.count({ where: { documentId: doc.documentId } }), 'one withdrawal recorded').toBe(1);
    await held.done();
    await page.context().close();
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: decision withdrawal on the history page (S-13) at 1280 wide: the confirm button keeps focus while the withdrawal is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'owner', WIDE);
    const projectId = await decided('Q-PP-02');
    await load(page, `${questionPath(projectId, 'Q-PP-02')}/history`);
    await page.getByRole('button', { name: 'Withdraw this decision' }).click();
    const confirmation = page.getByRole('group', { name: 'Version 1 of the decision on Q-PP-02' });
    await confirmation.getByLabel('Withdrawal code (required)').selectOption('duplicate');
    await confirmation.getByLabel('Reason (required)').fill('Duplicate of Q-PP-01.');
    const held = await hold(page, '/questions/Q-PP-02/withdrawal', 'POST', (r) => r.continue());
    await busyPress(page, confirmation.getByRole('button', { name: 'Withdraw decision' }), held);
    await expect(page.locator('[data-withdraw-status]')).toHaveText('Withdrawn. The question has no current decision.');
    await expect(page.locator('[data-version-number]')).toHaveCount(2);
    await held.done();
    await page.context().close();
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: findings (S-15) at 1280 wide: the confirm button keeps focus while the withdrawal is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'owner', WIDE);
    const f = await findingPage();
    await load(page, f.url);
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    const confirmation = page.getByRole('group', { name: /^Finding: / });
    await confirmation.getByLabel('Reason (required)').fill('Raised twice by mistake.');
    const held = await hold(page, `/findings/${f.findingId}/withdrawal`, 'POST', (r) => r.continue());
    await busyPress(page, confirmation.getByRole('button', { name: 'Withdraw finding' }), held);
    await expect(page.locator('main').getByRole('status').filter({ hasText: /^Withdrawn\.$/ })).toBeVisible();
    expect(await testDb.findingEvent.count({ where: { findingId: f.findingId, kind: 'withdrawn' } }), 'one withdrawal recorded').toBe(1);
    await held.done();
    await page.context().close();
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: first-owner invitation (S-24) at 1280 wide: the confirm button keeps focus while the revoke is held, and a second Enter sends nothing', async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'admin', WIDE);
    const { orgId, email } = await ownerInvitationOrg(baseURL!);
    await load(page, `/admin/organisations/${orgId}`);
    await page.getByRole('button', { name: 'Revoke invitation' }).first().click();
    const confirmation = page.getByRole('group', { name: `Invitation to ${email}` });
    const held = await hold(page, /\/owner-invitations\/[^/]+\/revoke$/, 'POST', (r) => r.continue());
    await busyPress(page, confirmation.getByRole('button', { name: 'Revoke invitation' }), held);
    await expect(page.getByText(`Revoked. The invitation to ${email} no longer works.`)).toBeVisible();
    await held.done();
    await page.context().close();
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: account deletion (S-21) at 1280 wide: the confirm button keeps focus while the deletion is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'viewer', WIDE);
    await load(page, '/account');
    await page.getByRole('button', { name: 'Delete my account...' }).click();
    const confirmation = page.getByRole('group', { name: 'Your account' });
    await confirmation.getByLabel('Password', { exact: true }).fill('not-the-password');
    await confirmation.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
    // Answered here with the refusal of a wrong password, so the fixture's account is never deleted and route 39's hourly limit is not spent.
    const held = await hold(page, /\/api\/users\/me$/, 'DELETE', (r) => r.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'validation', fields: [{ field: 'password', message: 'The password is not right.' }] }),
    }));
    await busyPress(page, confirmation.getByRole('button', { name: 'Delete my account', exact: true }), held);
    const field = confirmation.getByLabel('Password', { exact: true });
    await expect(page.getByText('The password is not right.')).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await testDb.membership.count({ where: { userId: fx.members.viewer.userId } }), 'the account is still a member').toBe(1);
    await held.done();
    await page.context().close();
  });
});

test('SC 2.4.11 UX-29: a pointer press on the visible strip of a Cancel button cut by the window\'s edge still cancels (documents, 1280 wide)', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await pageAs(browser, 'owner', WIDE);
  await load(page, (await documentPage()).url);
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  const confirmation = page.getByRole('group', { name: /^Data card issued / });
  const cancel = confirmation.getByRole('button', { name: 'Cancel' });
  await settled(page, confirmation);
  // Cut Cancel by the bottom edge of the visible box, with a strip of 16 px showing: scrolled as far as that needs, then, where the
  // page cannot scroll that far, the window shortened by what is missing. Then the press lands inside that strip.
  const shown = 16;
  const before = await placeOf(cancel);
  await scrollTo(cancel, Math.min(before.maxScroll, before.scrollTop + (before.top - (before.visibleBottom - shown))));
  await settled(page, cancel);
  const scrolled = await placeOf(cancel);
  if (scrolled.top < scrolled.visibleBottom - shown) {
    await page.setViewportSize({ width: WIDE.width, height: Math.round(WIDE.height - (scrolled.visibleBottom - shown - scrolled.top)) });
    await settled(page, cancel);
  }
  const cut = await placeOf(cancel);
  console.log(`pointer case: window ${page.viewportSize()!.width}x${page.viewportSize()!.height}`);
  expect(cut.top < cut.visibleBottom && cut.bottom > cut.visibleBottom, `Cancel is cut by the edge (${Math.round(cut.top)} to ${Math.round(cut.bottom)}, edge ${cut.visibleBottom})`).toBe(true);
  const box = (await cancel.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, cut.visibleBottom - shown / 2);
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw document' })).toBeFocused();
  await page.context().close();
});
