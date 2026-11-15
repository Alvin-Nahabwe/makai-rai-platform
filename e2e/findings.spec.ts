import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Browser, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { HOSTILE_STRINGS } from '../__tests__/helpers/hostile';
import {
  addAcceptedRisk, addDecision, addFinding, addMitigationVersion, addPreR11ClosingRecord, addProject, buildOrg, type OrgFixture,
} from '../__tests__/helpers/recordFixture';
import type { Stage } from '../types/record';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { claimMatches } from '../lib/claims/pattern';
import { FINDINGS_COPY } from '../lib/findings/copy';
import { UI_COPY } from '../lib/ui/copy';
import { QUESTION_COPY } from '../lib/question/copy';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { expectStatusMarksInk, expectNoCrossStageTotal, expectNoScoreShapes } from './helpers/noScore';
import { expectTargetsAtLeast24px } from './helpers/targetSize';

/**
 * S-14 and S-15 in the browser (FR-FND-02 to FR-FND-08, UX-14 to UX-17, UX-29, UX-06, UX-07, NFR-A11Y-02, NFR-A11Y-05, NFR-SEC-11).
 * The spec builds its own organisation with K0a's record fixture (so the findings it opens are its own), signs each role in once
 * through the login form, and keeps the sessions for the tests. The S-12 case needs DEC-b's page and skips while S-12 is a stub
 * (never under RELEASE_CANDIDATE=1).
 */
const ROLES: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
let fx: OrgFixture;
let projectId: string;
let s14: string;
let s15: { shortfall: string; open: string; closed: string; team: string };
const sessions = new Map<OrgRole, string>();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'findings-e2e-'));

async function signInThroughForm(browser: Browser, who: { email: string; password: string }, file: string): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('#email', who.email);
  await page.fill('#password', who.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await context.storageState({ path: file });
  await context.close();
}

/** A page signed in as `role`, at `width` when given. */
async function as(browser: Browser, role: OrgRole, width?: number): Promise<Page> {
  const context = await browser.newContext({ storageState: sessions.get(role), ...(width === undefined ? {} : { viewport: { width, height: 800 } }) });
  return context.newPage();
}

/** Presses Tab until the focused element's label or text starts with `name` (at most 60 presses). */
async function focusByKeyboard(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate((n) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute('aria-label') ?? el.textContent ?? '';
      return label.trim().startsWith(n);
    }, name);
    if (hit) return;
  }
  throw new Error(`focusByKeyboard: no element named "${name}" within 60 Tab presses`);
}

const MF = FINDINGS_COPY.mitigationForm;
const AR = FINDINGS_COPY.acceptRisk;
const ACT = FINDINGS_COPY.actions;
/** A string as a regular expression that matches it literally. */
const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The page's own status line: the shell's offline banner is a second `role="status"` region outside `<main>`. */
const status = (page: Page) => page.locator('main').getByRole('status');

function mitigationRequests(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/mitigations/.test(r.url())) n++; });
  return () => n;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  // Fixture titles end in a sequence number, and one of them can be 83 (the sentinel sum): this organisation's texts carry letters.
  const letters = (n: number): string => { let out = ''; for (let i = n; i >= 0; i = Math.floor(i / 26) - 1) out = String.fromCharCode(97 + (i % 26)) + out; return out; };
  fx = await buildOrg({ label: 'findings', text: (field, seq) => `Findings ${field} ${letters(seq)}` });
  const content = await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' } });
  const project = await addProject(fx, { name: 'Findings journeys' });
  projectId = project.id;
  const base = `/orgs/${fx.org.slug}/projects/${projectId}/findings`;
  s14 = base;
  const raising = await addDecision(fx, projectId, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'not_yet' });
  const shortfall = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
  const open = await addFinding(fx, projectId, { stage: 'in-processing', source: 'team', by: 'reviewer' });
  const team = await addFinding(fx, projectId, { stage: 'post-processing', source: 'team', by: 'reviewer' });
  const closed = await addFinding(fx, projectId, { stage: 'in-processing', source: 'team', by: 'owner' });
  await addMitigationVersion(fx, closed.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
  s15 = { shortfall: `${base}/${shortfall.id}`, open: `${base}/${open.id}`, closed: `${base}/${closed.id}`, team: `${base}/${team.id}` };
  for (const role of ROLES) {
    const file = path.join(dir, `${role}.json`);
    await signInThroughForm(browser, fx.members[role], file);
    sessions.set(role, file);
  }
});

test.afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('FR-FND-02 FR-FND-08 NFR-A11Y-02: a reviewer raises a team finding on S-14 by keyboard alone and it is listed for its stage', async ({ browser }) => {
  const page = await as(browser, 'reviewer');
  failOnDialog(page);
  await page.goto(s14);
  await focusByKeyboard(page, FINDINGS_COPY.raise.title); await page.keyboard.type(HOSTILE_STRINGS[0]);
  await focusByKeyboard(page, FINDINGS_COPY.raise.description); await page.keyboard.type('Labels disagree between annotators.');
  await focusByKeyboard(page, FINDINGS_COPY.raise.stage);
  // The kit's select (components/ui/Select.css) is `appearance: base-select` where the browser has it: there the first
  // arrow opens the picker, the arrows move in it and Enter chooses; a native closed select changes on each arrow.
  await page.keyboard.press('ArrowDown');
  const picker = await page.locator('#stage').evaluate((el) => { try { return el.matches(':open'); } catch { return false; } });
  if (picker) { await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); }
  else await page.keyboard.press('ArrowDown');                                                     // "Choose a stage" -> Pre-processing -> In-processing
  await expect(page.getByLabel(FINDINGS_COPY.raise.stage, { exact: true })).toHaveValue('in-processing');
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route('**/findings', async (r) => { if (r.request().method() !== 'POST') return r.continue(); await held; await r.continue(); });
  await focusByKeyboard(page, FINDINGS_COPY.raise.submit); await page.keyboard.press('Enter');
  await expect(status(page)).toHaveText(FINDINGS_COPY.raise.raising);
  release();
  await expect(status(page)).toHaveText(`${FINDINGS_COPY.raise.raised} ${FINDINGS_COPY.raise.viewFinding}`);
  await expect(status(page).getByRole('link', { name: FINDINGS_COPY.raise.viewFinding })).toHaveAttribute('href', /\/findings\/[^/]+$/);
  await expect(page.getByRole('link', { name: HOSTILE_STRINGS[0] })).toBeVisible();
  await expectFocusVisibleAndUncovered(page);
});

test('FR-FND-03 FR-FND-04 UX-16: on S-15 an assessor adds a mitigation, the owner list holds no viewer, and Done needs closure evidence', async ({ browser }) => {
  const page = await as(browser, 'assessor');
  const sent = mitigationRequests(page);
  await page.goto(s15.shortfall);
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  const owner = page.getByRole('combobox', { name: MF.assignedLabel });
  await expect(owner.getByRole('option', { name: fx.members.viewer.name })).toHaveCount(0);
  await owner.selectOption({ label: fx.members.assessor.name });
  await page.getByLabel(UI_COPY.date.day).fill('15'); await page.getByLabel(UI_COPY.date.month).fill('3'); await page.getByLabel(UI_COPY.date.year).fill('2027');
  await page.getByLabel(MF.what).fill('Stop the deployment until relabelled.');
  await page.getByRole('radio', { name: 'Done' }).check();
  await page.getByRole('button', { name: MF.save }).click();
  await expect(page.getByText(FINDINGS_COPY.fields.closureNote).first()).toBeVisible();
  expect(sent()).toBe(0);
  await page.getByLabel(MF.noArtefact).check();
  await page.getByLabel(MF.noArtefactWhy).fill('Deployment stopped');
  await page.getByRole('button', { name: MF.save }).click();
  await expect(page.getByText(new RegExp(`^${literal(MF.savedAs(1, '').slice(0, -1))}`))).toBeVisible();
  await expect(page.getByText(`${MF.doneNothingAttached} Deployment stopped`)).toBeVisible();
});

test('UX-17 FR-FND-05: the admin accepts a risk and the sentence follows the choice', async ({ browser }) => {
  const page = await as(browser, 'admin');
  await page.goto(s15.open);
  await page.getByLabel(AR.acceptedBy).selectOption({ label: AR.outsideWho('Ethics committee') });
  await expect(page.getByText(AR.willShow('Ethics committee'))).toBeVisible();
  await page.getByLabel(AR.reason).fill('Minutes of 30 Oct 2026, item 4.');
  await page.getByRole('button', { name: AR.submit }).click();
  // A3: the header names the role alone, exactly as the form's sentence said it would.
  await expect(page.getByText(new RegExp(`^${literal(FINDINGS_COPY.finding.acceptedHeaderStart)}Ethics committee\\) on `))).toBeVisible();
});

test('FR-FND-07 (screen): reopening a closed finding with a reason shows Reopened.', async ({ browser }) => {
  const page = await as(browser, 'assessor');
  await page.goto(s15.closed);
  await page.getByRole('button', { name: ACT.reopenTrigger }).click();
  await page.getByLabel(ACT.reason).fill('The memo was withdrawn.');
  await page.getByRole('button', { name: ACT.reopenSubmit }).click();
  await expect(status(page)).toHaveText(ACT.reopenedDone);
});

test.describe('UX-06 UX-07 FR-RM-04: sentinel counts on S-14 and S-15 (round 12, R12-16)', () => {
  const SENTINELS = { 'pre-processing': 41, 'in-processing': 29, 'post-processing': 13 } as const;   // open team findings per stage; their sum, 83, must appear nowhere
  test('UX-07 UX-06: S-14 and S-15 show no total across stages and use neutral status labels', async ({ browser }) => {
    test.setTimeout(240_000);
    const project = await addProject(fx, { name: 'Sentinel findings' });
    let first: { id: string } | undefined;
    for (const [stage, n] of Object.entries(SENTINELS)) {
      for (let i = 0; i < n; i++) { const f = await addFinding(fx, project.id, { stage: stage as Stage, source: 'team' }); first ??= f; }
    }
    const page = await as(browser, 'owner');
    const base = `/orgs/${fx.org.slug}/projects/${project.id}/findings`;
    await page.goto(base);
    for (const [name, n] of [['Pre-processing', 41], ['In-processing', 29], ['Post-processing', 13]] as const) {
      await expect(page.getByRole('heading', { name: `${name}: ${n} findings` })).toBeVisible();          // R13-9: the count each stage group carries
    }
    expect(await page.locator('.status-label').count()).toBeGreaterThan(0);
    await expectNoCrossStageTotal(page, { 'pre-processing': [41], 'in-processing': [29], 'post-processing': [13] });
    await expectStatusMarksInk(page);
    await page.goto(`${base}/${first!.id}`); await expectStatusMarksInk(page);
  });
});

test('UX-16 UX-17 (owner question B21): S-14 and S-15 opened by address as a viewer answer 200 with no form', async ({ browser }) => {
  const page = await as(browser, 'viewer');
  for (const url of [s14, s15.open]) {
    expect((await page.goto(url))!.status()).toBe(200);
    await expect(page.locator('main form')).toHaveCount(0);
    // The rendered words of both pages hold no product claim and no score shape (FR-PUB-01, FR-RM-01).
    expect(claimMatches(await page.locator('main').innerText()).map((m) => m.text), `${url}: claims`).toEqual([]);
    await expectNoScoreShapes(page, url);
  }
});

test('UX-29 UX-42: withdrawing a team finding confirms in place, takes focus, and Cancel returns it', async ({ browser }) => {
  const page = await as(browser, 'owner');
  await page.goto(s15.team);
  const trigger = page.getByRole('button', { name: ACT.withdrawTrigger });
  await trigger.click();
  // Ruling X-4 (register D-398 item 9): the confirmation's first field takes focus, never its confirm button.
  const group = page.getByRole('group', { name: new RegExp(`^${literal(ACT.objectName(''))}`) });
  await expect(group.getByLabel(ACT.reason)).toBeFocused();
  await group.getByRole('button', { name: ACT.cancel }).click();   // the confirmation is a role=group; the accept form has a Cancel of its own
  await expect(trigger).toBeFocused();
});

test('X-4 (register D-398 item 9): a trigger that is replaced by its form leaves focus in the form, never on the page body', async ({ browser }) => {
  const focusAfter = async (page: Page, name: string): Promise<string> => {
    await page.getByRole('button', { name, exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);   // after the form's mount effects and the next frame
    return page.evaluate(() => {
      const el = document.activeElement;
      return el === null || el === document.body ? 'body' : `${el.tagName.toLowerCase()}#${el.id}`;
    });
  };
  // Findings of its own: the cases above reopen s15.closed and accept s15.open.
  const project = await addProject(fx, { name: 'Focus after a trigger' });
  const url = (id: string) => `/orgs/${fx.org.slug}/projects/${project.id}/findings/${id}`;
  const closed = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  await addMitigationVersion(fx, closed.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
  const open = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  const accepted = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  await addAcceptedRisk(fx, accepted.id, { lookAgainOn: '2020-01-01' });
  const assessor = await as(browser, 'assessor');
  await assessor.goto(url(closed.id));
  const reopened = await focusAfter(assessor, ACT.reopenTrigger);
  expect(reopened, 'Reopen this finding').not.toBe('body');
  await expect(assessor.getByLabel(ACT.reason)).toBeFocused();
  await assessor.goto(url(open.id));
  const added = await focusAfter(assessor, FINDINGS_COPY.finding.addMitigation);
  expect(added, 'Add a mitigation').not.toBe('body');
  const kept = await as(browser, 'owner');
  await kept.goto(url(accepted.id));
  const keep = await focusAfter(kept, AR.keepTrigger);
  expect(keep, 'Keep the risk accepted').not.toBe('body');
  await expect(kept.getByLabel(AR.acceptedBy)).toBeFocused();
});

test('X-4 (register D-398): the pressed Retry stays, busy and focused, while its own request is held, and goes once it saves', async ({ browser }) => {
  const page = await as(browser, 'assessor');
  await page.goto(s15.team);
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  await page.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ label: fx.members.assessor.name });
  await page.getByLabel(UI_COPY.date.day).fill('20'); await page.getByLabel(UI_COPY.date.month).fill('3'); await page.getByLabel(UI_COPY.date.year).fill('2027');
  await page.getByLabel(MF.what).fill('Relabel the minority class.');
  const ids: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route('**/mitigations', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    ids.push((r.request().postDataJSON() as { requestId: string }).requestId);
    if (ids.length === 1) return r.abort('connectionreset');   // the first send is cut: a failure Retry may fix
    await held; await r.continue();
  });
  await page.getByRole('button', { name: MF.save }).click();
  const retry = page.getByRole('button', { name: MF.retry, exact: true });
  await expect(retry).toBeVisible();
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => ids.length).toBe(2);
  await expect(retry).toBeFocused();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(retry).toBeEnabled();
  release();
  await expect(page.getByText(new RegExp(`^${literal(MF.savedAs(1, '').slice(0, -1))}`))).toBeVisible();
  await expect(retry).toHaveCount(0);
  expect(ids[1], 'a Retry sends the same request id').toBe(ids[0]);
});

test('B1 (ruling L5-4): after a successful send focus goes to something that stays, never to the page body', async ({ browser }) => {
  const project = await addProject(fx, { name: 'Focus after a send' });
  const url = (id: string) => `/orgs/${fx.org.slug}/projects/${project.id}/findings/${id}`;
  const forMitigation = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  const toReopen = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  await addMitigationVersion(fx, toReopen.id, { status: 'done', owner: 'assessor', dueDate: '2026-12-01' });
  const toWithdraw = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  const toAccept = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  const assessor = await as(browser, 'assessor');
  // A mitigation: the toggle's trigger comes back and takes focus.
  await assessor.goto(url(forMitigation.id));
  await assessor.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  await assessor.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ label: fx.members.assessor.name });
  await assessor.getByLabel(UI_COPY.date.day).fill('20'); await assessor.getByLabel(UI_COPY.date.month).fill('3'); await assessor.getByLabel(UI_COPY.date.year).fill('2027');
  await assessor.getByLabel(MF.what).fill('Relabel the minority class.');
  await assessor.getByRole('button', { name: MF.save }).click();
  await expect(assessor.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation, exact: true })).toBeFocused();
  // Reopen: the status line that holds "Reopened." takes focus.
  await assessor.goto(url(toReopen.id));
  await assessor.getByRole('button', { name: ACT.reopenTrigger }).click();
  await assessor.getByLabel(ACT.reason).fill('The memo was withdrawn.');
  await assessor.getByRole('button', { name: ACT.reopenSubmit }).click();
  await expect(status(assessor)).toHaveText(ACT.reopenedDone);
  await expect(status(assessor)).toBeFocused();
  const owner = await as(browser, 'owner');
  // Withdraw: the same status line.
  await owner.goto(url(toWithdraw.id));
  await owner.getByRole('button', { name: ACT.withdrawTrigger }).click();
  await owner.getByLabel(ACT.reason).fill('Raised twice.');
  await owner.getByRole('button', { name: ACT.withdrawAction }).click();
  await expect(status(owner)).toHaveText(ACT.withdrawnDone);
  await expect(status(owner)).toBeFocused();
  // Accept the risk: the same status line, holding the saved line.
  await owner.goto(url(toAccept.id));
  await owner.getByLabel(AR.acceptedBy).selectOption({ label: AR.outsideWho('Ethics committee') });
  await owner.getByLabel(AR.reason).fill('Minutes of 30 Oct 2026, item 4.');
  await owner.getByRole('button', { name: AR.submit }).click();
  await expect(status(owner)).toHaveText(AR.saved('Ethics committee'));
  await expect(status(owner)).toBeFocused();
});

test('B2 (walk): a Planned mitigation keeps the finding open with no Close finding; cancelling it brings the button back and pressing it closes the finding', async ({ browser }) => {
  const content = await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' } });
  const project = await addProject(fx, { name: 'Close while a mitigation is open' });
  const list = `/orgs/${fx.org.slug}/projects/${project.id}/findings`;
  const raising = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'not_yet' });
  const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
  await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2027-03-20' });
  await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'done' });
  const F = FINDINGS_COPY.finding;
  const page = await as(browser, 'assessor', 375);
  failOnDialog(page);
  // The list: not under "Ready to close", no button on its row.
  await page.goto(list);
  await expect(page.getByRole('heading', { name: FINDINGS_COPY.list.decisionDone })).toHaveCount(0);
  await expect(page.getByRole('button', { name: FINDINGS_COPY.closeByDecision.label })).toHaveCount(0);
  // The finding page: the cause, then why it stays open, and no Close finding.
  await page.goto(`${list}/${f.id}`);
  const box = page.locator('.finding-close-box');
  await expect(box.locator('p')).toHaveText([F.closeChangedCause('Done'), F.closeBlocked]);
  await expect(page.getByRole('button', { name: FINDINGS_COPY.closeByDecision.label })).toHaveCount(0);
  // The way on: cancel the mitigation and say why; the box returns with the button, and pressing it closes the finding.
  await page.getByRole('button', { name: F.updateMitigation }).click();
  await page.getByRole('radio', { name: 'Cancelled' }).check();
  await page.getByLabel(MF.cancelReason).fill('The decision is now Done.');
  await page.getByRole('button', { name: MF.save }).click();
  await expect(box.locator('p')).toHaveText([F.closeChanged('Done')]);
  await page.getByRole('button', { name: FINDINGS_COPY.closeByDecision.label }).click();
  await expect(page.getByRole('button', { name: ACT.reopenTrigger })).toBeVisible();
  await expect(box).toHaveCount(0);
});

test('B2 (stuck): a finding whose close was pressed while a mitigation was Planned says why it stays open, and cancelling the mitigation closes it at once', async ({ browser }) => {
  const content = await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' } });
  const project = await addProject(fx, { name: 'Stuck close' });
  const raising = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'not_yet' });
  const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
  const planned = await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2027-03-20' });
  const done = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'done' });
  const page = await as(browser, 'assessor');
  failOnDialog(page);
  const url = `/orgs/${fx.org.slug}/projects/${project.id}/findings/${f.id}`;
  await page.goto(url);
  // The close an earlier page (v0.6.2) sent while the mitigation was Planned: the server now refuses it (route decision R11).
  const pressed = await page.request.post(`/api/v1${url}/close-by-decision`, {
    data: { requestId: crypto.randomUUID(), decisionVersionId: done.id }, headers: { origin: new URL(page.url()).origin },
  });
  expect(pressed.status()).toBe(409);
  expect(await pressed.json()).toEqual({ error: FINDINGS_COPY.failures.openWork, code: 'finding_has_open_work' });
  // Releases up to 0.7.0 accepted it, so stored data can hold the record that close wrote; the page still explains it.
  await addPreR11ClosingRecord(fx, f.id, { decisionVersionId: done.id, dueDate: '2027-03-20' });
  await page.reload();
  await expect(page.locator('.finding-close-box p')).toHaveText([FINDINGS_COPY.finding.closeBlocked]);
  await expect(page.getByRole('button', { name: FINDINGS_COPY.closeByDecision.label })).toHaveCount(0);
  const card = page.locator(`[data-mitigation-id="${planned.mitigationId}"]`);
  await card.getByRole('button', { name: FINDINGS_COPY.finding.updateMitigation }).click();
  await page.getByRole('radio', { name: 'Cancelled' }).check();
  await page.getByLabel(MF.cancelReason).fill('The decision is now Done.');
  await page.getByRole('button', { name: MF.save }).click();
  await expect(page.getByRole('button', { name: ACT.reopenTrigger })).toBeVisible();
  await expect(page.locator('.finding-close-box')).toHaveCount(0);
});

/** A project with one shortfall finding on `questionId` from a Not yet decision, then the decision that closes it (R2, R3 paths). */
async function closablePath(name: string, to: 'done' | 'withdrawn' | 'gate'): Promise<{ url: string; question: string }> {
  const content = await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' } });
  const project = await addProject(fx, { name });
  const questionId = to === 'gate' ? 'Q-PP-13' : 'Q-PP-01';
  const raising = await addDecision(fx, project.id, { stage: 'pre-processing', questionId, contentVersionId: content.id, status: 'not_yet' });
  const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId, decisionVersionId: raising.id });
  if (to === 'withdrawn') await addDecision(fx, project.id, { stage: 'pre-processing', questionId, contentVersionId: content.id, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  else if (to === 'gate') await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: content.id, scopeAnswer: 'no' });
  else await addDecision(fx, project.id, { stage: 'pre-processing', questionId, contentVersionId: content.id, status: 'done' });
  return { url: `/orgs/${fx.org.slug}/projects/${project.id}/findings/${f.id}`, question: `/orgs/${fx.org.slug}/projects/${project.id}/stages/pre-processing/questions/${questionId}` };
}

for (const [walk, to, heading, cause] of [
  ['the plain close', 'done', FINDINGS_COPY.list.decisionDone, FINDINGS_COPY.mitigation.closedBecauseDecisionChanged],
  ['F16 (withdrawn)', 'withdrawn', FINDINGS_COPY.list.decisionWithdrawn, FINDINGS_COPY.mitigation.closedBecauseDecisionWithdrawn],
  ['F18 (personal data answer No)', 'gate', FINDINGS_COPY.list.gateNo, FINDINGS_COPY.mitigation.closedBecauseNoLongerApplies],
] as const) {
  test(`R2 R3 ${walk}: the list heading, Close finding, then "Closed", who and why, no card, and "Finding closed by" in the history`, async ({ browser }) => {
    const path = await closablePath(`Close: ${walk}`, to);
    const page = await as(browser, 'assessor', 375);
    failOnDialog(page);
    await page.goto(path.url.replace(/\/[^/]+$/, ''));
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await page.goto(path.url);
    await expect(page.getByRole('link', { name: FINDINGS_COPY.finding.openQuestion })).toHaveAttribute('href', path.question);
    await page.getByRole('button', { name: FINDINGS_COPY.closeByDecision.label }).click();
    await expect(page.getByRole('button', { name: ACT.reopenTrigger })).toBeVisible();
    const header = page.locator('header.finding-header');
    await expect(header.locator('.status-label')).toHaveText(FINDINGS_COPY.labels.closed);
    await expect(header.getByText(new RegExp(`^${literal(FINDINGS_COPY.finding.closedBy)} ${literal(fx.members.assessor.name)} on \\d{1,2} \\w{3} 20\\d\\d\\. ${literal(cause)}$`))).toBeVisible();
    await expect(page.locator('.finding-card')).toHaveCount(0);
    await expect(page.getByText(FINDINGS_COPY.finding.noMitigations)).toBeVisible();
    await expect(page.locator('.finding-timeline li').last()).toHaveText(new RegExp(`${literal(FINDINGS_COPY.mitigation.findingClosedBy)} ${literal(fx.members.assessor.name)}\\.$`));
    await expect(page.locator('.finding-timeline')).not.toContainText(FINDINGS_COPY.mitigation.added);
  });
}

test('R4: on the question page the line reads that the finding can now be closed after a save, without a reload', async ({ browser }) => {
  const content = await testDb.frameworkVersion.findFirstOrThrow({ where: { semver: '0.0.1-fixture' } });
  const project = await addProject(fx, { name: 'Question line after a save' });
  const raising = await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: content.id, status: 'not_yet' });
  const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-01', decisionVersionId: raising.id });
  const page = await as(browser, 'assessor');
  failOnDialog(page);
  await page.goto(`/orgs/${fx.org.slug}/projects/${project.id}/stages/pre-processing/questions/Q-PP-01`);
  await expect(page.locator('#question-heading')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('[data-region="answer-form"] form')?.getAttribute('data-ready') === 'true');
  const region = page.locator('[data-region="finding-link"]');
  await expect(region.getByText(QUESTION_COPY.findingLink.open)).toBeVisible();
  let loads = 0;
  page.on('load', () => { loads++; });
  await page.getByRole('radio', { name: 'Done', exact: true }).check();
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`, { exact: true }).fill('The labels were checked again.');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(region.getByText(QUESTION_COPY.findingLink.closable)).toBeVisible();
  await expect(region.getByRole('link', { name: QUESTION_COPY.findingLink.view })).toHaveAttribute('href', `/orgs/${fx.org.slug}/projects/${project.id}/findings/${f.id}`);
  expect(loads).toBe(0);
});

test('B1 (ruling L5-4): a save that removes its own toggle (Done closes the finding; Cancelled ends the card) leaves focus on the mitigations heading', async ({ browser }) => {
  const project = await addProject(fx, { name: 'Focus when the toggle goes' });
  const url = (id: string) => `/orgs/${fx.org.slug}/projects/${project.id}/findings/${id}`;
  const toClose = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  const toCancel = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  await addMitigationVersion(fx, toCancel.id, { status: 'planned', owner: 'assessor', dueDate: '2027-03-20' });
  const page = await as(browser, 'assessor');
  const heading = page.getByRole('heading', { name: FINDINGS_COPY.finding.mitigations, level: 2 });
  const onBody = () => page.evaluate(() => document.activeElement === null || document.activeElement === document.body);
  // (a) Done on an open finding with no other mitigation closes it: both toggles leave the page.
  await page.goto(url(toClose.id));
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  await page.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ label: fx.members.assessor.name });
  await page.getByLabel(UI_COPY.date.day).fill('20'); await page.getByLabel(UI_COPY.date.month).fill('3'); await page.getByLabel(UI_COPY.date.year).fill('2027');
  await page.getByLabel(MF.what).fill('Relabel the minority class.');
  await page.getByRole('radio', { name: 'Done' }).check();
  await page.getByLabel(MF.noArtefact).check();
  await page.getByLabel(MF.noArtefactWhy).fill('Deployment stopped');
  await page.getByRole('button', { name: MF.save }).click();
  await expect(page.getByRole('button', { name: ACT.reopenTrigger })).toBeVisible();   // the refresh has landed: the finding is closed
  await expect(page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation })).toHaveCount(0);
  await expect(heading).toBeFocused();
  expect(await onBody()).toBe(false);
  // (b) An update to Cancelled removes that card's toggle.
  await page.goto(url(toCancel.id));
  await page.getByRole('button', { name: FINDINGS_COPY.finding.updateMitigation }).click();
  await page.getByRole('radio', { name: 'Cancelled' }).check();
  await page.getByLabel(MF.cancelReason).fill('The memo was withdrawn.');
  await page.getByRole('button', { name: MF.save }).click();
  await expect(page.getByRole('button', { name: FINDINGS_COPY.finding.updateMitigation })).toHaveCount(0);
  await expect(heading).toBeFocused();
  expect(await onBody()).toBe(false);
});

test('B1 B2: a Retry that fails again is announced again with no "Saving..." under it, and a Retry refused for good puts focus on the alert', async ({ browser }) => {
  const page = await as(browser, 'assessor');
  const project = await addProject(fx, { name: 'Retry answers' });
  const f = await addFinding(fx, project.id, { stage: 'pre-processing', source: 'team', by: 'owner' });
  await page.goto(`/orgs/${fx.org.slug}/projects/${project.id}/findings/${f.id}`);
  await page.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  await page.getByRole('combobox', { name: MF.assignedLabel }).selectOption({ label: fx.members.assessor.name });
  await page.getByLabel(UI_COPY.date.day).fill('20'); await page.getByLabel(UI_COPY.date.month).fill('3'); await page.getByLabel(UI_COPY.date.year).fill('2027');
  await page.getByLabel(MF.what).fill('Relabel the minority class.');
  let n = 0;
  let release!: () => void;
  const held = new Promise<void>((res) => { release = res; });
  await page.route('**/mitigations', async (r) => {
    if (r.request().method() !== 'POST') return r.continue();
    n++;
    if (n === 1) return r.abort('connectionreset');
    if (n === 2) { await held; return r.abort('connectionreset'); }
    return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'forbidden', code: 'forbidden' }) });
  });
  await page.getByRole('button', { name: MF.save }).click();
  const alert = page.locator('main [role="alert"].finding-alert');
  await expect(alert).toContainText(FINDINGS_COPY.failures.connectionLost(FINDINGS_COPY.failures.keptInBrowser));
  // Mark the failure's text node, then Retry: while it is held no stale "Not saved" line sits above "Saving...".
  await alert.evaluate((el) => { (el.firstChild as Node & { __old?: boolean }).__old = true; });
  const retry = page.getByRole('button', { name: MF.retry, exact: true });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => n).toBe(2);
  await expect(alert).not.toContainText(FINDINGS_COPY.failures.connectionLost(FINDINGS_COPY.failures.keptInBrowser));
  await expect(retry).toBeFocused();
  release();
  // The same failure comes back in a new node, so a screen reader reads it again.
  await expect(alert).toContainText(FINDINGS_COPY.failures.connectionLost(FINDINGS_COPY.failures.keptInBrowser));
  expect(await alert.evaluate((el) => (el.firstChild as Node & { __old?: boolean }).__old === true)).toBe(false);
  await expect(retry).toBeFocused();
  // A refusal Retry cannot fix removes the Retry button: focus goes to the alert, not to the body.
  await page.keyboard.press('Enter');
  await expect(alert).toContainText(FINDINGS_COPY.failures.forbidden(FINDINGS_COPY.failures.keptInBrowser));
  await expect(alert).toBeFocused();
});

test('NFR-A11Y-05: S-14 and S-15 at 320 px lose no content, state is in text, and axe finds no serious violation', async ({ browser }) => {
  const page = await as(browser, 'assessor', 320);
  for (const [url, state] of [[s14, 'S-14 groups at 320 px'], [s15.shortfall, 'S-15 shortfall at 320 px']] as const) {
    await page.goto(url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= 320)).toBe(true);
    await expectTargetsAtLeast24px(page);
    await expectNoSeriousA11yViolations(page, state);
  }
});

test('UX-14: a reviewer on S-12 follows "Raise a finding about this question" to a prefilled S-14 form', async ({ browser }) => {
  const page = await as(browser, 'reviewer');
  const s12 = `/orgs/${fx.org.slug}/projects/${projectId}/stages/pre-processing/questions/Q-PP-12`;
  const answered = (await page.goto(s12))?.status() === 200;
  test.skip(process.env.RELEASE_CANDIDATE !== '1' && !answered, 'S-12 needs DEC-b');
  await page.getByRole('link', { name: 'Raise a finding about this question' }).click();
  await expect(page.getByLabel(FINDINGS_COPY.raise.stage, { exact: true })).toHaveValue('pre-processing');
  await expect(page.getByText(new RegExp(`^${FINDINGS_COPY.raise.aboutQuestion} \\S`))).toBeVisible();
});
