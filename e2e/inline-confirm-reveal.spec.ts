import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, request as pwRequest, test, type Browser, type BrowserContext, type Locator, type Page, type Route } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import {
  addDecision, addFinding, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import { PERSONAL_DATA_COPY } from '../lib/account/copy';
import { adminSeat } from './fixtures/manifest';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { signInWith } from './helpers/session';
import { WITHDRAW_COPY } from '../lib/decision/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * The shared in-place confirmation (components/ui/InlineConfirm.tsx) on each of the screens that use it (SC 2.4.11, SC 2.4.3,
 * NFR-A11Y-02, UX-29, UX-42; register D-386):
 *   - a confirmation opened with the keyboard is wholly in view: inside the window, inside every clipping ancestor and inside
 *     the scroller's visible box less its scroll padding (a bar fixed over the window's edge reserves that padding); its two
 *     buttons are not covered; and the element the screen moves focus to has it and is wholly in view;
 *   - a text field that takes focus inside an open confirmation, cut by the window's edge, is brought wholly into view;
 *   - the confirm button keeps keyboard focus while its request is held, and a second Enter sends nothing;
 *   - a pointer press on a partly visible control inside an open confirmation still acts on that control.
 *
 * The failing geometry is arranged on purpose (`arrange`): the confirmation opens across the bottom edge of the visible box,
 * and where the screen moves focus into it, a strip of the element that takes focus already shows. A focus target that is
 * wholly hidden is scrolled in by the browser itself, so without the strip a case would pass with no repair at all. Each
 * screen and window size names the geometry it is expected to get (`Geometry`), and `arrange` fails when it gets another,
 * so a page that grows or shrinks, or a scroller that changes, cannot quietly turn a case into one that proves nothing.
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
let dir: string;
let sessions: Record<'owner' | 'viewer', string>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-confirm-e2e-'));
  sessions = { owner: path.join(dir, 'owner.json'), viewer: path.join(dir, 'viewer.json') };
  fx = await buildOrg({ label: 'confirm' });
  contentVersionId = (await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: CONTENT_SEMVER } })).id;
  for (const role of ['owner', 'viewer'] as const) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto('/login');
      await signInWith(page, fx.members[role].email, fx.members[role].password);
      await context.storageState({ path: sessions[role] });
    } finally {
      await context.close();
    }
  }
});

test.afterAll(() => { if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true }); });

/** What a case opened, closed after it whatever happened: held requests are let go first, then the contexts closed. */
const cleanup: { contexts: BrowserContext[]; releases: Array<() => void> } = { contexts: [], releases: [] };
test.afterEach(async () => {
  for (const release of cleanup.releases.splice(0)) release();
  for (const context of cleanup.contexts.splice(0)) await context.close();
});

type Who = 'owner' | 'viewer' | 'admin';

/** A page signed in as `who`, with the window at `size`; any dialog fails the test. */
async function pageAs(browser: Browser, who: Who, size: { width: number; height: number }): Promise<Page> {
  const storageState = who === 'admin' ? adminSeat().storageStatePath : sessions[who];
  const context = await browser.newContext({ storageState, viewport: { ...size } });
  cleanup.contexts.push(context);
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

/**
 * S-18 of a review holding one live data card. The seal is a row with a stand-in manifest (addSealRow), so the page says its
 * check failed and the server logs SEAL_CHECK_FAILED twice; the withdrawal confirmation does not read the seal.
 */
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

/** A new pending member invitation of the fixture organisation, made by its owner through the route. */
async function newInvitation(baseURL: string): Promise<{ id: string; email: string }> {
  const email = `confirm-pending-${randomUUID().slice(0, 8)}@fixture.test`;
  const api = await pwRequest.newContext({ baseURL, storageState: sessions.owner, extraHTTPHeaders: { origin: baseURL } });
  try {
    const res = await api.post(`/api/v1/orgs/${fx.org.slug}/members`, { data: { requestId: randomUUID(), email, role: 'reviewer', showLink: false } });
    expect(res.status(), 'the pending invitation').toBe(201);
    return { id: ((await res.json()) as { invitation: { id: string } }).invitation.id, email };
  } finally {
    await api.dispose();
  }
}

/** One pending invitation for the reveal cases, which only open and cancel its confirmation. */
let revealInvitation: Promise<{ id: string; email: string }> | undefined;

/**
 * The geometry a case is arranged in (`arrange`):
 *   - 'strip': a strip of the element that takes focus shows above the visible box's bottom edge and the rest is cut;
 *   - 'grown-strip': the same, in a window made taller than the case's size because the visible box at that size cannot hold
 *     the whole confirmation (a case the repair could not pass proves nothing);
 *   - 'held': the page cannot be scrolled far enough and the window is held at the least height that holds the confirmation,
 *     so the element shows more than the strip;
 *   - 'no-strip': the element lies past the end of the page as it is before the confirmation opens, so no scroll shows a strip
 *     of it: the page is scrolled to its end and the element opens wholly hidden.
 */
type Geometry = 'strip' | 'grown-strip' | 'held' | 'no-strip';

/** One screen's confirmation: how to reach it, what opens it, and where the screen puts focus when it opens. */
type Opened = {
  trigger: Locator;
  confirmation: Locator;
  /** The element the screen focuses on open, or 'trigger' where focus stays on the button that opened it. */
  focus: Locator | 'trigger';
  /** True where the focus target is inside the confirmation, so the kit's focus check applies to it. */
  focusInside: boolean;
};
/**
 * `passesWithoutRepair` names, per size, a pinned case that passes with the repair switched off, and why: it checks the
 * screen still behaves, but it does not prove the repair. Every other reveal case fails without the repair.
 */
type Screen = {
  name: string; who: Who; expect: { wide: Geometry; narrow: Geometry };
  passesWithoutRepair?: { wide?: string; narrow?: string };
  open: (page: Page, baseURL: string) => Promise<Opened>;
};

/** Loads `url` and waits until the page has settled its requests, so a press reaches a hydrated control. */
async function load(page: Page, url: string): Promise<void> {
  const res = await page.goto(url);
  expect(res?.status(), url).toBe(200);
  await page.waitForLoadState('networkidle');
}

const SCREENS: Screen[] = [
  {
    // Narrow is 'grown-strip' since plan 1A Task 16 restyled this confirmation with the kit's fields (a label, "(required)" and
    // the field on separate lines, twice): at 320 wide it is taller than a 568 px window can hold, so the window is grown
    // (to 618 px on 14 Nov 2026) and the case then proves the repair as before.
    name: 'account deletion (S-21)', who: 'viewer', expect: { wide: 'strip', narrow: 'grown-strip' },
    open: async (page) => {
      await load(page, '/account');
      const confirmation = page.getByRole('group', { name: 'Your account' });
      return { trigger: page.getByRole('button', { name: 'Delete my account...' }), confirmation, focus: confirmation.getByLabel(PERSONAL_DATA_COPY.passwordLabel), focusInside: true };
    },
  },
  {
    name: 'documents (S-18)', who: 'owner', expect: { wide: 'strip', narrow: 'strip' },
    open: async (page) => {
      await load(page, (await documentPage()).url);
      const confirmation = page.getByRole('group', { name: /^Data card issued / });
      return { trigger: page.getByRole('button', { name: 'Withdraw document' }), confirmation, focus: confirmation.getByLabel('Reason (required)'), focusInside: true };
    },
  },
  {
    name: 'decision withdrawal on the history page (S-13)', who: 'owner', expect: { wide: 'held', narrow: 'held' },
    open: async (page) => {
      await load(page, `${questionPath(await decided('Q-PP-01'), 'Q-PP-01')}/history`);
      const confirmation = page.getByRole('group', { name: WITHDRAW_COPY.objectName(1, 'Q-PP-01') });
      return { trigger: page.getByRole('button', { name: WITHDRAW_COPY.trigger }), confirmation, focus: confirmation.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`), focusInside: true };
    },
  },
  {
    name: 'decision withdrawal on the question page, inside More (S-12)', who: 'owner', expect: { wide: 'no-strip', narrow: 'grown-strip' },
    passesWithoutRepair: { wide: 'the focus target opens hidden past the end of the page, and the browser\'s own focus scroll brings it in' },
    open: async (page) => {
      await load(page, questionPath(await decided('Q-PP-01'), 'Q-PP-01'));
      await page.locator('summary', { hasText: new RegExp(`^${WITHDRAW_COPY.more.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
      const confirmation = page.getByRole('group', { name: WITHDRAW_COPY.objectName(1, 'Q-PP-01') });
      return { trigger: page.getByRole('button', { name: WITHDRAW_COPY.trigger }), confirmation, focus: confirmation.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`), focusInside: true };
    },
  },
  {
    name: 'findings (S-15)', who: 'owner', expect: { wide: 'no-strip', narrow: 'no-strip' },
    passesWithoutRepair: { wide: 'the focus target opens hidden past the end of the page, and the browser\'s own focus scroll brings it in' },
    open: async (page) => {
      await load(page, (await findingPage()).url);
      const confirmation = page.getByRole('group', { name: /^Finding: / });
      return { trigger: page.getByRole('button', { name: 'Withdraw', exact: true }), confirmation, focus: confirmation.getByRole('button', { name: 'Withdraw finding' }), focusInside: true };
    },
  },
  {
    // NOT ESTABLISHED whether this case passes with the repair switched off, so it has no `passesWithoutRepair` (a field
    // that says it does). Plan 1A Task 17 moved focus from a wrapper around the confirmation, which the browser scrolled
    // wholly into view, to its Cancel button, which the browser's own focus scroll may bring in without the confirmation.
    // Settling it needs a run with InlineConfirm's reveal switched off (components/ui, lane 1's); none has been made.
    name: 'archive project (S-10)', who: 'owner', expect: { wide: 'strip', narrow: 'strip' },
    open: async (page) => {
      // A fixed name, so the heading wraps the same way in every run (project names need not be unique; the page shows one).
      const name = 'Confirm archive project';
      const project = await addProject(fx, { name });
      await load(page, projectPath(project.id));
      const confirmation = page.getByRole('group', { name: `Archive ${name}?` });
      // The confirmation has no field, so the screen focuses its Cancel button (ArchiveProjectControl.tsx; ruling X-4).
      return { trigger: page.getByRole('button', { name: 'Archive project' }).first(), confirmation, focus: confirmation.getByRole('button', { name: 'Cancel' }), focusInside: true };
    },
  },
  {
    name: 'members, remove (S-26)', who: 'owner', expect: { wide: 'strip', narrow: 'strip' },
    open: async (page) => {
      await load(page, `/orgs/${fx.org.slug}/settings/members`);
      const name = fx.members.viewer.name;
      return { trigger: page.getByRole('button', { name: `Remove ${name}` }), confirmation: page.getByRole('group', { name }), focus: 'trigger', focusInside: false };
    },
  },
  {
    name: 'members, revoke (S-26)', who: 'owner', expect: { wide: 'strip', narrow: 'strip' },
    open: async (page, baseURL) => {
      revealInvitation ??= newInvitation(baseURL);
      const { email } = await revealInvitation;
      await load(page, `/orgs/${fx.org.slug}/settings/members`);
      return {
        trigger: page.getByRole('button', { name: `Revoke invitation for ${email}` }), confirmation: page.getByRole('group', { name: `Invitation for ${email}` }),
        focus: 'trigger', focusInside: false,
      };
    },
  },
  {
    name: 'first-owner invitation (S-24)', who: 'admin', expect: { wide: 'strip', narrow: 'strip' },
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
 * Where an element sits in its scroller, the nearest ancestor that scrolls vertically (`main.shell__main` from 1024 px wide on
 * a signed-in page) or else the document; when `scrollTop` is given, the scroller is first scrolled there, instantly (the
 * page's own scroll is smooth: app/globals.css). `contentTop` is the element's top in the scroller's content, which no scroll
 * changes. `visibleTop` and `visibleBottom` bound what the window shows of the scroller, less its scroll padding: a bar fixed
 * over the window's edge reserves that padding (S-12's save bar at 768 px and under: components/decision/DecisionForm.css),
 * so what lies in it is behind the bar.
 */
type Place = {
  contentTop: number; top: number; bottom: number; visibleTop: number; visibleBottom: number; scrollTop: number; maxScroll: number; scroller: string;
};
/** Scrolls the scroller of `el` to `top`, instantly; `placeOf` with a scrollTop, for its side effect. */
const scrollScrollerTo = async (el: Locator, top: number): Promise<void> => { await placeOf(el, top); };

const placeOf = (target: Locator, scrollTop?: number): Promise<Place> => target.evaluate((el, y): Place => {
  let s: Element | null = el.parentElement;
  while (s !== null && s !== document.body && s !== document.documentElement) {
    const oy = getComputedStyle(s).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight) break;
    s = s.parentElement;
  }
  const doc = s === null || s === document.body || s === document.documentElement;
  const scroller = doc ? (document.scrollingElement as Element) : s!;
  if (y !== undefined) scroller.scrollTo({ top: y, behavior: 'instant' });
  const winH = document.documentElement.clientHeight;
  const pad = getComputedStyle(doc ? document.documentElement : scroller);
  const padTop = parseFloat(pad.scrollPaddingBlockStart) || 0;
  const padEnd = parseFloat(pad.scrollPaddingBlockEnd) || 0;
  const boxTop = doc ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
  const visibleTop = Math.max(0, boxTop) + padTop;
  const visibleBottom = (doc ? winH : Math.min(winH, boxTop + scroller.clientHeight)) - padEnd;
  const r = el.getBoundingClientRect();
  const name = doc ? 'the document' : `${scroller.tagName.toLowerCase()}.${Array.from(scroller.classList).join('.')}`;
  return {
    contentTop: r.top - boxTop + scroller.scrollTop, top: r.top, bottom: r.bottom, visibleTop, visibleBottom,
    scrollTop: scroller.scrollTop, maxScroll: scroller.scrollHeight - scroller.clientHeight, scroller: name,
  };
}, scrollTop);

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
 * Puts `el`'s top `shown` px above the bottom of the visible box: by an instant scroll, or, where the page cannot be scrolled
 * that far, by shortening the window by what is missing. Then checks that it is cut with that much showing.
 */
async function cutAtBottom(page: Page, el: Locator, shown: number): Promise<Place> {
  const before = await placeOf(el);
  const want = Math.round(before.scrollTop + before.top - (before.visibleBottom - shown));
  await scrollScrollerTo(el, Math.max(0, Math.min(before.maxScroll, want)));
  await settled(page, el);
  const scrolled = await placeOf(el);
  const missing = scrolled.visibleBottom - shown - scrolled.top;
  if (missing > 0.5) {
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width, height: Math.round(size.height - missing) });
    await settled(page, el);
  }
  const cut = await placeOf(el);
  expect(cut.top < cut.visibleBottom && cut.bottom > cut.visibleBottom && cut.visibleBottom - cut.top >= shown - 2,
    `the element is cut by the edge with ${shown} px showing (${Math.round(cut.top)} to ${Math.round(cut.bottom)}, edge ${Math.round(cut.visibleBottom)})`).toBe(true);
  return cut;
}

/**
 * Arranges the failing geometry: opens the confirmation once to learn where the element that takes the strip lands (the
 * focus target, or the confirmation itself where focus stays on the trigger), cancels it, and puts that element's top STRIP
 * pixels above the bottom of the visible box, by an instant scroll, or by shortening the window where the page cannot be
 * scrolled that far up, never below what holds the whole confirmation. Fails unless the geometry it gets is `expected`
 * (`Geometry`), and checks a claimed strip. Returns the window size used.
 */
async function arrange(page: Page, o: Opened, expected: Geometry): Promise<{ width: number; height: number }> {
  await o.trigger.click();
  await expect(o.confirmation).toBeVisible();
  await settled(page, o.confirmation);
  const stripOf = o.focus === 'trigger' ? o.confirmation : o.focus;
  const probe = await placeOf(stripOf);
  const whole = await placeOf(o.confirmation);
  await o.confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(o.confirmation).toHaveCount(0);
  // The least window height whose visible box holds the whole confirmation, with 8 px to spare.
  const now0 = await placeOf(o.trigger);
  const size0 = page.viewportSize()!;
  const least = Math.ceil(size0.height - (now0.visibleBottom - now0.visibleTop) + (whole.bottom - whole.top) + 8);
  let grown = false;
  if (least > size0.height) {
    await page.setViewportSize({ width: size0.width, height: least });
    grown = true;
  }
  let found: Geometry | null = null;
  let detail = '';
  for (let i = 0; i < 4 && found === null; i += 1) {
    const now = await placeOf(o.trigger);
    // The scrollTop that puts the element's top at visibleBottom - STRIP: its top in the window is boxTop + contentTop - scrollTop.
    const boxTop = now.top - (now.contentTop - now.scrollTop);
    const want = Math.round(boxTop + probe.contentTop - (now.visibleBottom - STRIP));
    if (want > now.maxScroll) {
      await scrollScrollerTo(o.trigger, now.maxScroll);
      found = 'no-strip';
      detail = `the element would need a scroll of ${want} px and ${now.scroller} scrolls ${now.maxScroll} px`;
    } else if (want >= 0) {
      await scrollScrollerTo(o.trigger, want);
      found = grown ? 'grown-strip' : 'strip';
    } else {
      const size = page.viewportSize()!;
      const height = size.height + want;
      if (height - least < 8) {
        // The strip would need a window shorter than, or within 8 px of, the least height that holds the confirmation. The
        // window is set to that least height and the case is 'held' there, the element showing more than the strip: so a page
        // that settles a few pixels differently from run to run cannot flip a case between 'strip' and 'held' (archive at
        // 1280 sat about 4 px from it while its project name was random).
        if (size.height !== least) await page.setViewportSize({ width: size.width, height: least });
        await scrollScrollerTo(o.trigger, 0);
        const held = await placeOf(o.trigger);
        found = 'held';
        detail = `the element shows ${Math.round(held.visibleBottom - (held.top - (held.contentTop - held.scrollTop) + probe.contentTop))} px`;
      } else {
        await page.setViewportSize({ width: size.width, height });
      }
    }
  }
  if (found === null) throw new Error('cannot arrange: four resizes did not settle the geometry');
  const size = page.viewportSize()!;
  test.info().annotations.push({ type: 'geometry', description: `${found}; window ${size.width}x${size.height}; least height that holds the confirmation ${least}${detail === '' ? '' : `; ${detail}`}` });
  expect(found, `the geometry this case is pinned to (window ${size.width}x${size.height}${detail === '' ? '' : `; ${detail}`})`).toBe(expected);
  await settled(page, o.trigger);
  const trig = await placeOf(o.trigger);
  expect(trig.top >= trig.visibleTop && trig.bottom <= trig.visibleBottom, `the trigger is wholly in view before it is pressed (${Math.round(trig.top)} to ${Math.round(trig.bottom)})`).toBe(true);
  if (found === 'strip' || found === 'grown-strip') {
    // Where the element will open: its content top less the scroll now, in the window. A strip of it shows, at least MIN_STRIP
    // px and not much more than STRIP (a page may settle a pixel or two after the scroll), and the rest is cut.
    const opensAt = trig.top - (trig.contentTop - trig.scrollTop) + probe.contentTop - trig.scrollTop;
    const shows = trig.visibleBottom - opensAt;
    expect(shows >= MIN_STRIP && shows <= STRIP + 4 && shows < probe.bottom - probe.top,
      `a strip of ${MIN_STRIP} to ${STRIP + 4} px of the element shows, and not all of it (it shows ${Math.round(shows)} px of ${Math.round(probe.bottom - probe.top)})`).toBe(true);
  }
  return size;
}

/**
 * Every edge of the confirmation's box against the window, against the visible box of every ancestor that clips (overflow
 * other than visible), and against its scroller's visible box less its scroll padding; and its two buttons against anything
 * drawn over their centres. Measured once. Returns the failures, empty when it is wholly in view and its buttons uncovered.
 * The development overlay of `next dev` (`nextjs-portal`, the dev tools button) is not counted as a cover: it exists only on a
 * development server, and e2e/shell-checks.spec.ts leaves it out the same way.
 */
async function outOfView(confirmation: Locator): Promise<string[]> {
  const place = await placeOf(confirmation);
  return confirmation.evaluate((el, visible) => {
    const out: string[] = [];
    const slack = 0.5;
    const r = el.getBoundingClientRect();
    const box = (a: { left: number; top: number; right: number; bottom: number }) => `${Math.round(a.left)},${Math.round(a.top)} to ${Math.round(a.right)},${Math.round(a.bottom)}`;
    const inside = (b: { left: number; top: number; right: number; bottom: number }) =>
      r.left >= b.left - slack && r.top >= b.top - slack && r.right <= b.right + slack && r.bottom <= b.bottom + slack;
    const win = { left: 0, top: 0, right: document.documentElement.clientWidth, bottom: document.documentElement.clientHeight };
    if (!inside(win)) out.push(`the confirmation ${box(r)} is not inside the window ${box(win)}`);
    const padded = { left: 0, top: visible.top, right: win.right, bottom: visible.bottom };
    if (!inside(padded)) out.push(`the confirmation ${box(r)} is not inside its scroller's visible box less its scroll padding ${box(padded)}`);
    for (let a = el.parentElement; a !== null && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = a.getBoundingClientRect();
      const clip = { left: b.left + a.clientLeft, top: b.top + a.clientTop, right: b.left + a.clientLeft + a.clientWidth, bottom: b.top + a.clientTop + a.clientHeight };
      if (!inside(clip)) out.push(`the confirmation ${box(r)} is not inside ${a.tagName.toLowerCase()}.${Array.from(a.classList).join('.')} ${box(clip)}`);
    }
    for (const button of Array.from(el.querySelectorAll('.ui-confirm__actions button'))) {
      const b = button.getBoundingClientRect();
      const over = document.elementsFromPoint(b.left + b.width / 2, b.top + b.height / 2)
        .find((hit) => hit.closest('[data-nextjs-dev-tools-button], nextjs-portal') === null);
      if (over === undefined || !(over === button || button.contains(over))) {
        out.push(`"${button.textContent}" is covered at its centre by ${over === undefined ? 'nothing' : `${over.tagName.toLowerCase()}.${Array.from(over.classList).join('.')}`}`);
      }
    }
    return out;
  }, { top: place.visibleTop, bottom: place.visibleBottom });
}

const isFocused = (el: Locator): Promise<boolean> => el.evaluate((node) => node === document.activeElement);

for (const screen of SCREENS) {
  for (const [label, size, key] of [['1280 wide', WIDE, 'wide'], ['320 wide', NARROW, 'narrow']] as const) {
    test(`SC 2.4.11 NFR-A11Y-02 UX-29: ${screen.name} at ${label}: the confirmation opened with the keyboard is wholly in view and focus is where the screen puts it`, async ({ browser, baseURL }) => {
      test.setTimeout(120_000);
      const page = await pageAs(browser, screen.who, size);
      const opened = await screen.open(page, baseURL!);
      const without = screen.passesWithoutRepair?.[key];
      if (without !== undefined) test.info().annotations.push({ type: 'passes without the repair', description: without });
      const used = await arrange(page, opened, screen.expect[key]);
      await opened.trigger.focus();
      await page.keyboard.press('Enter');
      await expect(opened.confirmation).toBeVisible();
      await settled(page, opened.confirmation);
      expect(await outOfView(opened.confirmation), `${screen.name}: the confirmation is wholly in view and its buttons uncovered (window ${used.width}x${used.height})`).toEqual([]);
      const focus = opened.focus === 'trigger' ? opened.trigger : opened.focus;
      expect(await isFocused(focus), `${screen.name}: focus is on ${opened.focus === 'trigger' ? 'the button that opened it' : 'the element the screen focuses'}`).toBe(true);
      if (opened.focusInside) await expectFocusVisibleAndUncovered(page);
    });
  }
}

/**
 * Holds the requests to `url` with `method` until `release()`, then answers them with `answer`. Every such request the page
 * sends is counted from the page's own request events, not only those the route saw, and `done()` checks the count and takes
 * the route off: each test calls it after the screen's final state, so a late duplicate is still counted and no request is
 * left waiting (the file's afterEach lets a held request go if a case fails first).
 */
async function hold(page: Page, url: string | RegExp, method: string, answer: (route: Route) => Promise<void>) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  cleanup.releases.push(release);
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
  answered.catch(() => {});   // awaited in release(); this only keeps a case that fails before then from leaving it unhandled
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

type ButtonState = { focused: boolean; busy: string | null; disabled: boolean };
const BUSY: ButtonState = { focused: true, busy: 'true', disabled: false };

/**
 * Presses Enter on the focused confirm button with its request held, and while it is held checks once that the button is in
 * `state` (by default: still focused, aria-busy="true", not disabled); presses Enter again; releases and waits for the answer.
 * The caller checks the screen's end state and then `held.done()`, which counts the requests.
 */
async function busyPress(page: Page, confirm: Locator, held: Awaited<ReturnType<typeof hold>>, state: ButtonState = BUSY): Promise<void> {
  await confirm.focus();
  await page.keyboard.press('Enter');
  await expect.poll(held.routed, { message: 'the request reached the route' }).toBe(1);
  const now = await confirm.evaluate((el) => ({ focused: el === document.activeElement, busy: el.getAttribute('aria-busy'), disabled: (el as HTMLButtonElement).disabled }));
  expect(now, 'the confirm button while the request is held').toEqual(state);
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
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: decision withdrawal on the history page (S-13) at 1280 wide: the confirm button keeps focus while the withdrawal is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'owner', WIDE);
    const projectId = await decided('Q-PP-02');
    await load(page, `${questionPath(projectId, 'Q-PP-02')}/history`);
    await page.getByRole('button', { name: WITHDRAW_COPY.trigger }).click();
    const confirmation = page.getByRole('group', { name: WITHDRAW_COPY.objectName(1, 'Q-PP-02') });
    await confirmation.getByLabel(`${WITHDRAW_COPY.codeLabel} ${FIELD_COPY.required}`).selectOption('duplicate');
    await confirmation.getByLabel(`${WITHDRAW_COPY.reasonLabel} ${FIELD_COPY.required}`).fill('Duplicate of Q-PP-01.');
    const held = await hold(page, '/questions/Q-PP-02/withdrawal', 'POST', (r) => r.continue());
    await busyPress(page, confirmation.getByRole('button', { name: 'Withdraw decision' }), held);
    await expect(page.locator('[data-withdraw-status]')).toHaveText('Withdrawn. The question has no current decision.');
    await expect(page.locator('[data-version-number]')).toHaveCount(2);
    await held.done();
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
  });

  test('SC 2.4.3 UX-29 NFR-A11Y-02: account deletion (S-21) at 1280 wide: the confirm button keeps focus while the deletion is held, and a second Enter sends nothing', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'viewer', WIDE);
    await load(page, '/account');
    await page.getByRole('button', { name: 'Delete my account...' }).click();
    const confirmation = page.getByRole('group', { name: 'Your account' });
    await confirmation.getByLabel(PERSONAL_DATA_COPY.passwordLabel).fill('not-the-password');
    await confirmation.getByLabel('Type DELETE MY ACCOUNT to confirm').fill('DELETE MY ACCOUNT');
    // Answered here with the refusal of a wrong password, so the fixture's account is never deleted and route 39's hourly limit is not spent.
    const held = await hold(page, /\/api\/users\/me$/, 'DELETE', (r) => r.fulfill({
      status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'validation', fields: [{ field: 'password', message: 'The password is not right.' }] }),
    }));
    await busyPress(page, confirmation.getByRole('button', { name: 'Delete my account', exact: true }), held);
    const field = confirmation.getByLabel(PERSONAL_DATA_COPY.passwordLabel);
    await expect(page.getByText('The password is not right.')).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(await testDb.membership.count({ where: { userId: fx.members.viewer.userId } }), 'the account is still a member').toBe(1);
    await held.done();
  });

  test('UX-29 NFR-A11Y-02: members, revoke (S-26) at 1280 wide: the confirm button, neither busy nor disabled there, keeps focus while the revoke is held, and the screen\'s own guard sends one request for two Enters', async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, 'owner', WIDE);
    const invitation = await newInvitation(baseURL!);   // this case's own, so revoking it for real disturbs no other case
    await load(page, `/orgs/${fx.org.slug}/settings/members`);
    await page.getByRole('button', { name: `Revoke invitation for ${invitation.email}` }).click();
    const confirmation = page.getByRole('group', { name: `Invitation for ${invitation.email}` });
    const held = await hold(page, `/invitations/${invitation.id}/revoke`, 'POST', (r) => r.continue());
    // MembersManager.tsx passes no `busy` to the confirmation: while the request is held its confirm button is neither busy nor
    // disabled, nothing moves focus, and the second press is stopped by the screen's own in-flight guard, not by the button.
    await busyPress(page, confirmation.getByRole('button', { name: 'Revoke invitation', exact: true }), held, { focused: true, busy: null, disabled: false });
    await expect(page.getByText(`Invitation for ${invitation.email} revoked.`)).toBeVisible();
    await expect(confirmation).toHaveCount(0);
    await held.done();
  });
});

test('SC 2.4.11 NFR-A11Y-02: a text field that takes focus inside an open confirmation while cut by the window\'s edge is brought wholly into view (documents, 1280 wide)', async ({ browser }) => {
  // The on-focus reveal alone (InlineConfirm's onFocus; register D-386). A text field that takes focus inside an already open
  // confirmation (its layout effect has run) while cut by the bottom edge with its first line still showing: the documents
  // page's reason, a textarea, blurred, cut, and focused again by a script, as a later script focus by a screen would be.
  // Chromium brings a focused text field's caret into view, not its box: with the whole first line showing it scrolls
  // nothing, and with the handler removed this case fails ("the reason field is wholly in view (391 to 477, visible 0 to
  // 431)"). With 12 px showing the caret is out of view altogether, the browser scrolls the field in by itself, and the case
  // passes with no handler. So the strip is taken from the field itself (its top border, top padding and line height: where
  // its first line ends, plus a few pixels), and the case fails, saying why, unless that strip shows the whole first line and
  // leaves the field well cut: a restyle of the form controls must not turn this case into one that proves nothing.
  test.setTimeout(120_000);
  const page = await pageAs(browser, 'owner', WIDE);
  await load(page, (await documentPage()).url);
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  const confirmation = page.getByRole('group', { name: /^Data card issued / });
  const field = confirmation.getByLabel('Reason (required)');
  await expect(field).toBeFocused();
  await settled(page, confirmation);
  await field.evaluate((el) => (el as HTMLElement).blur());
  const lines = await field.evaluate((el) => {
    const cs = getComputedStyle(el);
    const padTop = parseFloat(cs.paddingTop);
    const padBottom = parseFloat(cs.paddingBottom);
    const rows = (el as HTMLTextAreaElement).rows;
    // The line height: the computed value, or, where it is 'normal', the content box's height over the rows.
    const line = cs.lineHeight === 'normal' ? (el.clientHeight - padTop - padBottom) / rows : parseFloat(cs.lineHeight);
    return { firstLineEnds: parseFloat(cs.borderTopWidth) + padTop + line, height: el.getBoundingClientRect().height };
  });
  const firstLineShowing = Math.ceil(lines.firstLineEnds) + 4;
  expect(firstLineShowing >= lines.firstLineEnds && firstLineShowing <= lines.height - 16,
    `the strip shows the reason field's whole first line (it ends ${lines.firstLineEnds} px down; the strip is ${firstLineShowing} px) and leaves at least 16 px of the ${lines.height} px field cut; otherwise the browser's own caret reveal, or no cut at all, would decide this case and it would prove nothing about the on-focus reveal`).toBe(true);
  await cutAtBottom(page, field, firstLineShowing);
  await field.evaluate((el) => (el as HTMLElement).focus());
  await expect(field).toBeFocused();
  await settled(page, field);
  const place = await placeOf(field);
  expect(place.top >= place.visibleTop - 0.5 && place.bottom <= place.visibleBottom + 0.5,
    `the reason field is wholly in view (${Math.round(place.top)} to ${Math.round(place.bottom)}, visible ${Math.round(place.visibleTop)} to ${Math.round(place.visibleBottom)})`).toBe(true);
  await expectFocusVisibleAndUncovered(page);
});

test('SC 2.4.11 UX-29: a pointer press on the visible strip of a Cancel button cut by the window\'s edge still cancels (documents, 1280 wide)', async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await pageAs(browser, 'owner', WIDE);
  await load(page, (await documentPage()).url);
  await page.getByRole('button', { name: 'Withdraw document' }).click();
  const confirmation = page.getByRole('group', { name: /^Data card issued / });
  const cancel = confirmation.getByRole('button', { name: 'Cancel' });
  await settled(page, confirmation);
  // Cancel cut by the bottom edge of the visible box with 16 px showing; the press lands inside that strip.
  const shown = 16;
  const cut = await cutAtBottom(page, cancel, shown);
  const box = (await cancel.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, cut.visibleBottom - shown / 2);
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw document' })).toBeFocused();
});
