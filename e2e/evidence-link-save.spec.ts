import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { applyNetworkProfile } from './helpers/network';
import { draftKeys, fillValid, historyPath, openQuestion, saveStatus } from './helpers/session';
import { savedLine } from '../lib/decision/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { EVIDENCE_COPY, LINK_REFUSAL_COPY } from '../lib/evidence/copy';

/**
 * Walk finding B3 (UX-30, FR-EVD-01, FR-DEC-07): a link is part of the decision that is saved, however soon after
 * "Add link" the person presses "Save decision". The save waits for the link's request as it waits for a file, and a
 * link that was not added is never left out without a word.
 *
 * Upload budget: the evidence route allows 10 POSTs a minute per account, links included (lib/rate-limit.ts). A plain
 * run spends the index-0 admin and owner seats, which no other spec uploads from in numbers (authz-api-matrix.spec.ts
 * posts one link as each): four POSTs from admin 0 and three from owner 0, before CI's retries. Under --repeat-each the seat turns
 * with the repeat and the case, through the five seats that may add evidence, so twenty repeats stay under the limit.
 */
const Q = 'Q-PP-01';
const LINK = 'https://example.org/walk/labelling-guide';
type Seat = readonly [OrgRole, 0 | 1];
const PLAIN: readonly Seat[] = [['admin', 0], ['owner', 0]];
const REPEATED: readonly Seat[] = [['admin', 0], ['owner', 0], ['assessor', 1], ['owner', 1], ['assessor', 0]];
function seatFor(info: TestInfo, n: number): Seat {
  const pool = info.repeatEachIndex === 0 ? PLAIN : REPEATED;
  return pool[(info.repeatEachIndex + n) % pool.length];
}

const isEvidencePost = (r: { request(): { method(): string }; url(): string }) => r.request().method() === 'POST' && /\/evidence$/.test(new URL(r.url()).pathname);
const isDecisionPost = (r: { method(): string; url(): string }) => r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname);
const SAVED_V1 = new RegExp(`^${savedLine('.+', 1, '.+')}$`);

/** Every decision save the page sends, in order, with the evidence ids it carried. */
function decisionPosts(page: Page): Array<{ evidenceIds: string[] }> {
  const out: Array<{ evidenceIds: string[] }> = [];
  page.on('request', (r) => { if (isDecisionPost(r)) out.push(r.postDataJSON() as { evidenceIds: string[] }); });
  return out;
}
async function typeLink(page: Page): Promise<void> {
  await page.getByRole('button', { name: EVIDENCE_COPY.addLinkToggle }).click();
  await page.getByLabel(EVIDENCE_COPY.webAddress).fill(LINK);
}
const addLink = (page: Page) => page.getByRole('button', { name: EVIDENCE_COPY.addLink, exact: true });
const saveDecision = (page: Page) => page.getByRole('button', { name: DECISION_FORM_COPY.save });
const waitCard = (page: Page) => page.locator('[data-upload-wait]');
const summary = (page: Page) => page.locator('[data-region="answer-form"] [data-error-summary]');
async function historyText(page: Page, projectId: string): Promise<string> {
  await page.goto(historyPath(projectId, Q));
  await expect(page.getByRole('heading', { level: 1, name: `History of ${Q}` })).toBeVisible();
  return page.locator('main').innerText();
}
/** The person was told, nothing was sent, and the link is still in the form to add again. */
async function expectNotSavedWithTheLinkKept(page: Page, posts: unknown[]): Promise<void> {
  await expect(summary(page)).toContainText(DECISION_FORM_COPY.linkNotAdded, { timeout: 15_000 });
  await expect(summary(page).locator('p').first()).toBeFocused();
  await expect(page.getByText(LINK_REFUSAL_COPY.connectionLost)).toBeVisible();
  await expect(waitCard(page)).toHaveCount(0);
  expect(posts).toEqual([]);
  await expect(saveStatus(page)).toHaveText('');
  await expect(page.getByLabel(EVIDENCE_COPY.webAddress)).toHaveValue(LINK);
}

test.beforeEach(async ({ page }) => { failOnDialog(page); });

for (const [n, delayMs] of [[0, 1500], [1, 0]] as const) {
  test(`B3 UX-30: Save pressed at once after Add link (${delayMs === 0 ? 'no slowing' : `the link's request slowed ${delayMs} ms`}) saves the decision with the link`, async ({ page, baseURL }, info) => {
    const [role, index] = seatFor(info, n);
    const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
    const posts = decisionPosts(page);
    if (delayMs > 0) {
      await page.route('**/evidence', async (route) => {
        if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, delayMs));
        await route.continue();
      });
    }
    await typeLink(page);
    const reply = page.waitForResponse(isEvidencePost);
    await addLink(page).click();
    await saveDecision(page).click();
    if (delayMs > 0) {
      // While the link's request is out the form says so twice: under Add link, and where a Save waits. Nothing is sent,
      // and there is no "Save without": only a file can be left out by choice.
      await expect(page.getByText(EVIDENCE_COPY.link.adding)).toBeVisible();
      await expect(waitCard(page)).toContainText(DECISION_FORM_COPY.waitingLink);
      await expect(waitCard(page).getByRole('button')).toHaveText([DECISION_FORM_COPY.cancel]);
      expect(posts).toEqual([]);
    }
    const res = await reply;
    expect(res.status()).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
    // One save, and it carried the link: nothing was sent before the link had its id.
    expect(posts).toHaveLength(1);
    expect(posts[0].evidenceIds).toEqual([id]);
    // The save that waited is the answer on screen: no draft is left behind and the form does not claim one.
    await expect(waitCard(page)).toHaveCount(0);
    await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
    expect(await draftKeys(page)).toHaveLength(0);
    const text = await historyText(page, projectId);
    expect(text).toContain(LINK);
    expect(text).not.toContain('Evidence\nNone');
  });
}

test('B3: Add link and Save decision pressed in the same task: the save still waits for the link and carries it', async ({ page, baseURL }, info) => {
  // No person is this fast. It pins what the wait rests on: the form knows of the link's request before the next press can
  // run, with no render or timer in between.
  const [role, index] = seatFor(info, 6);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await typeLink(page);
  const reply = page.waitForResponse(isEvidencePost);
  await page.evaluate(([add, save]) => {
    const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[data-region="answer-form"] button')].find((b) => b.textContent === name);
    button(add)!.click();
    button(save)!.click();
  }, [EVIDENCE_COPY.addLink, DECISION_FORM_COPY.save]);
  const res = await reply;
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: string };
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([id]);
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3: a link that could not be added while Save waited: nothing is saved, the person is told, the link stays in the form', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 2);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  // The first request is lost after 1.5 s and never reaches the server; the second goes through.
  let lost = false;
  await page.route('**/evidence', async (route) => {
    if (route.request().method() !== 'POST' || lost) { await route.continue(); return; }
    lost = true;
    await new Promise((r) => setTimeout(r, 1500));
    await route.abort('failed');
  });
  await typeLink(page);
  await addLink(page).click();
  await saveDecision(page).click();
  await expectNotSavedWithTheLinkKept(page, posts);
  await expectNoSeriousA11yViolations(page, 'S-12, a link not added while Save waited');
  // Adding it again, then Save: the decision carries the link, and the summary is gone.
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  const { id } = (await (await reply).json()) as { id: string };
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  await expect(summary(page)).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([id]);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3: a link whose request gets no reply in time while Save waited: nothing is saved and the person is told', async ({ page, baseURL }, info) => {
  await page.clock.install();
  const [role, index] = seatFor(info, 3);
  await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await page.route('**/evidence', (route) => (route.request().method() === 'POST' ? new Promise(() => {}) : route.continue()));   // never answers
  await typeLink(page);
  await addLink(page).click();
  await saveDecision(page).click();
  await expect(waitCard(page)).toContainText(DECISION_FORM_COPY.waitingLink);
  await expect(page.getByText(EVIDENCE_COPY.link.adding)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'S-12, Save waiting for a link');
  await page.clock.fastForward(30_000);
  await expectNotSavedWithTheLinkKept(page, posts);
});

test('B3: Cancel while Save waits for a link sends nothing; the link then sits in the form as not saved, and Save carries it', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 4);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await page.route('**/evidence', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await typeLink(page);
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  await saveDecision(page).click();
  await waitCard(page).getByRole('button', { name: DECISION_FORM_COPY.cancel }).click();
  await expect(waitCard(page)).toHaveCount(0);
  const { id } = (await (await reply).json()) as { id: string };
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible();
  expect(posts).toEqual([]);
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText(DECISION_FORM_COPY.unsaved);
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([id]);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3 UX-30: Save while a file is uploading and a link is being added sends once, after both, with both', async ({ page, baseURL }, info) => {
  test.slow();   // the Poor profile makes both waits real
  const [role, index] = seatFor(info, 5);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  const ids: string[] = [];
  page.on('response', (r) => { if (isEvidencePost(r) && r.status() === 201) void r.json().then((b: { id: string }) => ids.push(b.id)); });
  await typeLink(page);
  await applyNetworkProfile(page, 'Poor');
  await page.locator('input[type="file"]').setInputFiles({ name: 'with-a-link.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(450 * 1024, 0x20)]) });
  await expect(page.getByText(/^Uploading with-a-link\.pdf:/)).toBeVisible();
  await addLink(page).click();
  await saveDecision(page).click();
  await expect(waitCard(page)).toContainText(`${DECISION_FORM_COPY.waiting.before}with-a-link.pdf${DECISION_FORM_COPY.waiting.after}`);
  await expect(waitCard(page)).toContainText(DECISION_FORM_COPY.waitingLink);
  // The link is in first: the wait goes on for the file alone, and nothing has been sent.
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Uploading with-a-link\.pdf:/)).toBeVisible();
  await expect(waitCard(page)).not.toContainText(DECISION_FORM_COPY.waitingLink);
  expect(posts).toEqual([]);
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 60_000 });
  expect(posts).toHaveLength(1);
  await expect.poll(() => ids.length).toBe(2);
  expect([...posts[0].evidenceIds].sort()).toEqual([...ids].sort());
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await draftKeys(page)).toHaveLength(0);
  const text = await historyText(page, projectId);
  expect(text).toContain(LINK);
  expect(text).not.toContain('Evidence\nNone');
});
