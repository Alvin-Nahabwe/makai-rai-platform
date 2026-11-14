import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { applyNetworkProfile } from './helpers/network';
import { actAsSeat, draftKeys, draftValues, fillValid, fixtureOrgSlug, historyPath, newProject, openQuestion, saveStatus } from './helpers/session';
import { savedLine } from '../lib/decision/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { EVIDENCE_COPY, LINK_REFUSAL_COPY } from '../lib/evidence/copy';
import { FINDINGS_COPY } from '../lib/findings/copy';
import { UI_COPY } from '../lib/ui/copy';

/**
 * Walk finding B3 (UX-30, FR-EVD-01, FR-DEC-07): a link is part of the decision that is saved, however soon after
 * "Add link" the person presses "Save decision". The save waits for the link's request as it waits for a file, and a
 * link that was not added is never left out without a word.
 *
 * The same holds for the three neighbours of that fault: an address typed and never added stops the save, nothing is
 * added while a save is out, and the mitigation form on the finding page holds its save for a link too.
 *
 * Upload budget: the evidence route allows 10 POSTs a minute per account, links included (lib/rate-limit.ts), and the
 * fourteen cases post twelve times in all. A plain run (and the first of a repeated one) spends the index-0 admin and
 * owner seats, which no other spec uploads from in numbers (authz-api-matrix.spec.ts posts one link as each): six POSTs
 * from each, over more than a minute, before CI's retries. Under --repeat-each every later repeat turns through the four
 * other seats that may add evidence, three POSTs a seat for each repeat, so two workers stay under the limit. (With
 * fewer seats or more POSTs a repeat, runs were refused with 429: 4 of 240, then 50 of 280.) Each case's number is its
 * place in that turn, even for admin 0 and odd for owner 0 in a plain run: change one and count again.
 */
const Q = 'Q-PP-01';
const LINK = 'https://example.org/walk/labelling-guide';
type Seat = readonly [OrgRole, 0 | 1];
const PLAIN: readonly Seat[] = [['admin', 0], ['owner', 0]];
const LATER_REPEATS: readonly Seat[] = [['assessor', 1], ['owner', 1], ['assessor', 0], ['admin', 1]];
function seatFor(info: TestInfo, n: number): Seat {
  const pool = info.repeatEachIndex === 0 ? PLAIN : LATER_REPEATS;
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
    await expect(page.locator('[data-region="answer-form"] [role="status"][data-wait-status]')).toBeEmpty();
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
      await expect(waitCard(page)).toContainText(EVIDENCE_COPY.link.waiting);
      await expect(waitCard(page).getByRole('button')).toHaveText([DECISION_FORM_COPY.cancel]);
      // The wait is announced: its card is put into a status region that was on the page, empty, before the press.
      await expect(page.locator('[data-region="answer-form"] [role="status"][data-wait-status]', { has: waitCard(page) })).toHaveCount(1);
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
  // Adding it again: once the link is in, the summary no longer says it was not added. Then Save carries the link.
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  const { id } = (await (await reply).json()) as { id: string };
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible();
  await expect(summary(page)).toHaveCount(0);
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  await expect(summary(page)).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([id]);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3: a link whose request gets no reply in time while Save waited: nothing is saved and the person is told', async ({ page, baseURL }, info) => {
  await page.clock.install();
  const [role, index] = seatFor(info, 9);
  await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await page.route('**/evidence', (route) => (route.request().method() === 'POST' ? new Promise(() => {}) : route.continue()));   // never answers
  await typeLink(page);
  await addLink(page).click();
  await saveDecision(page).click();
  await expect(waitCard(page)).toContainText(EVIDENCE_COPY.link.waiting);
  await expect(page.getByText(EVIDENCE_COPY.link.adding)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'S-12, Save waiting for a link');
  await page.clock.fastForward(30_000);
  await expectNotSavedWithTheLinkKept(page, posts);
});

test('B3: Cancel while Save waits for a link sends nothing; the link then sits in the form as not saved, and Save carries it', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 10);
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
  const [role, index] = seatFor(info, 4);
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
  await expect(waitCard(page)).toContainText(EVIDENCE_COPY.link.waiting);
  // The link is in first: the wait goes on for the file alone, and nothing has been sent.
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/^Uploading with-a-link\.pdf:/)).toBeVisible();
  await expect(waitCard(page)).not.toContainText(EVIDENCE_COPY.link.waiting);
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

test('B3 neighbour: a web address typed and never added: Save decision is refused in the summary and at the field; clearing the box lets it save', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 11);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await typeLink(page);
  await saveDecision(page).click();
  await expect(summary(page)).toContainText(EVIDENCE_COPY.link.typedNotAdded);
  await expect(summary(page).locator('p').first()).toBeFocused();
  const address = page.getByLabel(EVIDENCE_COPY.webAddress);
  await expect(page.locator('[data-region="evidence-block"]').getByRole('alert')).toContainText(EVIDENCE_COPY.link.typedNotAdded);
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  await expect(address).toHaveValue(LINK);
  expect(posts).toEqual([]);
  await expect(saveStatus(page)).toHaveText('');
  await expectNoSeriousA11yViolations(page, 'S-12, a save refused for an address typed and not added');
  // Editing the box takes the line at the field away; an empty box no longer holds the save back.
  await address.fill('');
  await expect(page.locator('[data-region="evidence-block"]').getByRole('alert')).toHaveCount(0);
  await expect(summary(page)).toHaveCount(0);   // the box is clear: the summary's line about it is gone too
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([]);
  expect(await historyText(page, projectId)).not.toContain(LINK);
});

test('B3 neighbour: a web address typed and never added: after the refusal, Add link and then Save decision saves with the link', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 7);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  await typeLink(page);
  await saveDecision(page).click();
  await expect(summary(page)).toContainText(EVIDENCE_COPY.link.typedNotAdded);
  expect(posts).toEqual([]);
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  const { id } = (await (await reply).json()) as { id: string };
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible();
  await expect(summary(page)).toHaveCount(0);   // the link is in: the line that said it was not added is gone
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([id]);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3 neighbour: while a save is out, and until the page shows the new version, Add link does not start and the link boxes take no text', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 17);
  await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  // The page's own refresh after a save is slowed, so the time between "Saved" and the new version on the page is long enough to look at.
  await page.route((url) => url.pathname.endsWith(`/questions/${Q}`), async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const posts = decisionPosts(page);
  let evidencePosts = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/evidence$/.test(new URL(r.url()).pathname)) evidencePosts++; });
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  await page.getByRole('button', { name: EVIDENCE_COPY.addLinkToggle }).click();   // the link form is open and empty
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  const address = page.getByLabel(EVIDENCE_COPY.webAddress);
  await expect(address).not.toBeEditable();
  await expect(page.getByLabel(EVIDENCE_COPY.linkName)).not.toBeEditable();
  await expect(addLink(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(addLink(page)).not.toHaveAttribute('disabled');
  await expect(page.getByText(EVIDENCE_COPY.link.waitForSave)).toBeVisible();
  await expect(addLink(page)).toHaveAccessibleDescription(new RegExp(EVIDENCE_COPY.link.waitForSave.replace(/[.]/g, '\\.')));
  // It keeps its focus and a press does nothing.
  await addLink(page).focus();
  await page.keyboard.press('Enter');
  await expect(addLink(page)).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'S-12, the link form while a save is out');
  expect(evidencePosts).toBe(0);
  release();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  // "Saved", and the form is about to be replaced by the new version: the hold goes on until it has been.
  await expect(addLink(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(address).not.toBeEditable();
  await addLink(page).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(DECISION_FORM_COPY.startingNote)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel(EVIDENCE_COPY.webAddress)).toHaveCount(0);   // the new version's form: the link form is closed
  expect(evidencePosts).toBe(0);
  // The link form is the person's again.
  await typeLink(page);
  await expect(page.getByText(EVIDENCE_COPY.link.waitForSave)).toHaveCount(0);
  await expect(page.getByLabel(EVIDENCE_COPY.webAddress)).toHaveValue(LINK);
  await expect(addLink(page)).not.toHaveAttribute('aria-disabled');
});

test('B3 neighbour (control): a file chosen while a save is out is not lost: it stays in the form with its id, and the form says it is not saved', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 23);
  await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route('**/decisions', async (r) => { await held; await r.continue(); });
  // The upload is answered here, not by the server (the account's upload budget is for the cases that save what they
  // add): what is checked is what the form does with a file that finished while its save was out.
  const id = crypto.randomUUID();
  await page.route('**/evidence', (route) => (route.request().method() !== 'POST' ? route.continue() : route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({
    id, kind: 'file', fileName: 'during-save.pdf', mimeType: 'application/pdf', byteSize: 20_489, sha256: '0'.repeat(64), url: null, label: null,
    uploadedBy: null, uploadedAt: new Date().toISOString(), erased: null,
  }) })));
  await saveDecision(page).click();
  await expect(saveStatus(page)).toHaveText('Saving...');
  await page.locator('input[type="file"]').setInputFiles({ name: 'during-save.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(20 * 1024, 0x20)]) });
  await expect(page.getByText(/^Uploaded during-save\.pdf /)).toBeVisible();
  release();
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0].evidenceIds).toEqual([]);
  // The version saved has no file, and the form says so: the file is still listed and the answer is "not saved yet".
  await expect(page.getByText(/^Uploaded during-save\.pdf /)).toBeVisible();
  await expect(page.locator('[data-region="answer-form"] .save-status')).toContainText(DECISION_FORM_COPY.unsaved);
  const stored = (await draftValues(page)).map((t) => JSON.parse(t) as { baseVersionNumber: number | null; value: { evidenceIds: string[] } });
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ baseVersionNumber: 1, value: { evidenceIds: [id] } });
});

test('B3 neighbour: the mitigation form: Save mitigation pressed while a link is still being added is held, and the next press saves with it', async ({ page, baseURL }, info) => {
  const MF = FINDINGS_COPY.mitigationForm;
  const [role, index] = seatFor(info, 5);
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, role, index);
  const base = `/orgs/${fixtureOrgSlug()}/projects/${projectId}/findings`;
  const raised = await page.request.post(`/api/v1${base}`, { data: {
    requestId: crypto.randomUUID(), stage: 'pre-processing', title: 'Labels disagree', description: 'Two annotators label the same record differently.',
    riskArea: null, questionId: null, decisionVersionId: null,
  } });
  expect(raised.status()).toBe(201);
  const { id: findingId } = (await raised.json()) as { id: string };
  await page.goto(`${base}/${findingId}`);
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  // The finding page holds other forms with a date (accepting a risk): every control below is the mitigation form's own.
  const form = page.locator('form.finding-form', { has: page.getByRole('heading', { name: MF.addHeading }) });
  await form.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ index: 1 });
  await form.getByLabel(UI_COPY.date.day).fill('15'); await form.getByLabel(UI_COPY.date.month).fill('3'); await form.getByLabel(UI_COPY.date.year).fill('2027');
  await form.getByLabel(MF.what).fill('Relabel the disputed records.');
  await form.getByRole('radio', { name: 'Done' }).check();
  const sent: Array<{ evidenceIds: string[] }> = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/mitigations/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON() as { evidenceIds: string[] }); });
  // A first link, added and in the form: Done has its evidence, so only the second link can hold the save back.
  const FIRST = 'https://example.org/walk/relabelling-plan';
  await form.getByRole('button', { name: EVIDENCE_COPY.addLinkToggle }).click();
  await form.getByLabel(EVIDENCE_COPY.webAddress).fill(FIRST);
  const firstReply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  const first = ((await (await firstReply).json()) as { id: string }).id;
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(FIRST) })).toBeVisible();
  await page.route('**/evidence', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await typeLink(page);
  const secondReply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  await form.getByRole('button', { name: MF.save }).click();
  const holdCard = form.locator('.finding-held');
  await expect(holdCard).toContainText(EVIDENCE_COPY.link.waiting);
  await expect(holdCard.getByRole('button')).toHaveText([MF.cancel]);
  expect(sent).toEqual([]);
  const second = ((await (await secondReply).json()) as { id: string }).id;
  // The link is in: the hold is over, nothing was sent by itself, and the next press saves with both links.
  await expect(page.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible();
  await expect(holdCard).toHaveCount(0);
  expect(sent).toEqual([]);
  await form.getByRole('button', { name: MF.save }).click();
  await expect(page.getByText(/^Saved as version 1 of this mitigation at /)).toBeVisible({ timeout: 15_000 });
  expect(sent).toHaveLength(1);
  expect([...sent[0].evidenceIds].sort()).toEqual([first, second].sort());
});

test('B3 neighbour: the retry on reconnect does not overtake a Save that waits for a link', async ({ page, baseURL }, info) => {
  const [role, index] = seatFor(info, 3);
  const projectId = await openQuestion(page, role, Q, baseURL!, undefined, index); await fillValid(page);
  const posts = decisionPosts(page);
  // A first save is lost: the form will send it once more, by itself, when the browser says it is online again.
  await page.route('**/decisions', (r) => r.abort('failed'), { times: 1 });
  await saveDecision(page).click();
  await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('alert')).toContainText('Not saved.');
  expect(posts).toHaveLength(1);
  await page.route('**/evidence', async (route) => {
    if (route.request().method() === 'POST') await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await typeLink(page);
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  await saveDecision(page).click();
  await expect(waitCard(page)).toContainText(EVIDENCE_COPY.link.waiting);
  await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
  const { id } = (await (await reply).json()) as { id: string };
  await expect(saveStatus(page)).toHaveText(SAVED_V1, { timeout: 15_000 });
  // The lost one and the one that waited: nothing went in between without the link, and the wait is over.
  expect(posts).toHaveLength(2);
  expect(posts[1].evidenceIds).toEqual([id]);
  await expect(waitCard(page)).toHaveCount(0);
  await expect(page.getByText(DECISION_FORM_COPY.unsaved)).toHaveCount(0);
  expect(await historyText(page, projectId)).toContain(LINK);
});

test('B3 neighbour: the mitigation form: an address typed and never added stops Save mitigation, and the line goes once the link is added', async ({ page, baseURL }, info) => {
  const MF = FINDINGS_COPY.mitigationForm;
  const [role, index] = seatFor(info, 35);
  const projectId = await newProject(baseURL!);
  await actAsSeat(page, role, index);
  const base = `/orgs/${fixtureOrgSlug()}/projects/${projectId}/findings`;
  const raised = await page.request.post(`/api/v1${base}`, { data: {
    requestId: crypto.randomUUID(), stage: 'pre-processing', title: 'Labels disagree', description: 'Two annotators label the same record differently.',
    riskArea: null, questionId: null, decisionVersionId: null,
  } });
  expect(raised.status()).toBe(201);
  const { id: findingId } = (await raised.json()) as { id: string };
  await page.goto(`${base}/${findingId}`);
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  const form = page.locator('form.finding-form', { has: page.getByRole('heading', { name: MF.addHeading }) });
  await form.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ index: 1 });
  await form.getByLabel(UI_COPY.date.day).fill('15'); await form.getByLabel(UI_COPY.date.month).fill('3'); await form.getByLabel(UI_COPY.date.year).fill('2027');
  await form.getByLabel(MF.what).fill('Relabel the disputed records.');
  await form.getByRole('radio', { name: 'Done' }).check();
  const sent: Array<{ evidenceIds: string[] }> = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/mitigations/.test(new URL(r.url()).pathname)) sent.push(r.postDataJSON() as { evidenceIds: string[] }); });
  await form.getByRole('button', { name: EVIDENCE_COPY.addLinkToggle }).click();
  await form.getByLabel(EVIDENCE_COPY.webAddress).fill(LINK);
  await form.getByRole('button', { name: MF.save }).click();
  // One problem, this one, in the summary (which links to the evidence group) and under the group.
  const problems = form.locator('.form-error');
  await expect(problems.getByRole('link')).toHaveText([EVIDENCE_COPY.link.typedNotAdded]);
  await expect(problems).toBeFocused();
  await expect(form.getByText(EVIDENCE_COPY.link.typedNotAdded)).toHaveCount(2);
  expect(sent).toEqual([]);
  await expect(form.getByLabel(EVIDENCE_COPY.webAddress)).toHaveValue(LINK);
  const reply = page.waitForResponse(isEvidencePost);
  await addLink(page).click();
  const { id } = (await (await reply).json()) as { id: string };
  await expect(form.getByRole('button', { name: EVIDENCE_COPY.removeNamed(LINK) })).toBeVisible();
  await expect(form.getByText(EVIDENCE_COPY.link.typedNotAdded)).toHaveCount(0);
  await form.getByRole('button', { name: MF.save }).click();
  await expect(page.getByText(/^Saved as version 1 of this mitigation at /)).toBeVisible({ timeout: 15_000 });
  expect(sent).toHaveLength(1);
  expect(sent[0].evidenceIds).toEqual([id]);
});
