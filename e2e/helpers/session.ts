import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from '../fixtures/manifest';
import { DECISION_FORM_COPY } from '../../lib/decision/form/copy';
import { REASON_OPTIONAL } from '../../lib/decision/copy';
import { AUTH_COPY } from '../../lib/auth/copy';

/**
 * Shared sign-in helpers for specs that need a real session in a browser context of their own (gap G103; V-prog imports
 * them rather than copying them). Every sign-in goes through the real `/login` form, as `e2e/fixtures/auth.setup.ts`
 * does, with the fixture password the fixture builder set; nothing here mints a cookie. The manifest is read when a
 * helper runs, because the setup project writes it after Playwright has collected the specs.
 */

function manifest(): FixtureManifest {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
}

/** The seat of `role` (index 0 unless asked for index 1) in the first fixture organisation. */
export function seatOf(role: OrgRole, index: 0 | 1 = 0): FixtureManifestUser {
  const m = manifest();
  const s = m.users.find((u) => u.orgSlug === m.orgs[0].slug && u.role === role && u.index === index);
  if (!s) throw new Error(`the fixture manifest has no ${role} seat ${index} for ${m.orgs[0].slug}`);
  return s;
}

/** The first fixture organisation's slug. */
export function fixtureOrgSlug(): string {
  return manifest().orgs[0].slug;
}

/** The first fixture organisation's id (the draft key's organisation, UX-26). */
export function fixtureOrgId(): string {
  return manifest().orgs[0].id;
}

/**
 * Fills and sends the sign-in form already open on this page with `email` and `password`, keeping its `callbackUrl`, and
 * waits until it has left `/login`. Any account, not only a fixture seat: V-prog's specs sign in accounts of their own.
 */
export async function signInWith(page: Page, email: string, password: string): Promise<void> {
  await expect(page).toHaveURL(/\/login(\?|$)/);
  // The form's inputs are React-controlled: a value typed before hydration is reset by it (seen on a cold `next dev`
  // compile of /login, where Email came back empty and the native `required` check stopped the submit), and a press
  // before hydration submits the form natively (seen through nginx). Fill until the values survive a short settle.
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.waitForTimeout(300);
    await expect(page.locator('#email')).toHaveValue(email, { timeout: 100 });
    await expect(page.locator('#password')).toHaveValue(password, { timeout: 100 });
  }).toPass({ timeout: 20_000 });
  await page.locator('button[type="submit"]').click();
  // D16 (plan 1B Task 5): on a browser that keeps another account's unsaved text, S-01 asks before it goes on. A spec
  // that signs a second account in here wants today's outcome, the other accounts' drafts gone, so it removes them.
  const remove = page.getByRole('button', { name: AUTH_COPY.removeAndContinue });
  await Promise.race([
    page.waitForURL((url) => url.pathname !== '/login', { timeout: 30_000 }).catch(() => {}),
    remove.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {}),
  ]);
  if (new URL(page.url()).pathname === '/login' && (await remove.isVisible())) await remove.click();
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 30_000 });
}

/** Fills and sends the sign-in form already open on this page as the role's seat (signInWith). */
export async function signInOnLoginPage(page: Page, role: OrgRole): Promise<void> {
  const seat = seatOf(role);
  await signInWith(page, seat.email, seat.password);
}

/**
 * Opens `/login`, signs in as the role's index-0 seat and opens S-08, the organisation's dashboard. A fixture seat has no
 * last organisation yet, so `/` shows the organisation picker (lib/org-dispatch.ts); the dashboard is opened by address.
 */
export async function signInAs(page: Page, role: OrgRole): Promise<void> {
  await page.goto('/login');
  await signInOnLoginPage(page, role);
  await page.goto(`/orgs/${fixtureOrgSlug()}/dashboard`);
  await expect(page).toHaveURL(new RegExp(`/orgs/${fixtureOrgSlug()}/dashboard$`));
}

/** The stage the `0.0.1-fixture` bundle puts a question in, from its id. */
export function stageOf(questionId: string): 'pre-processing' | 'in-processing' | 'post-processing' {
  if (questionId.startsWith('Q-PP-')) return 'pre-processing';
  if (questionId.startsWith('Q-IP-')) return 'in-processing';
  if (questionId.startsWith('Q-PO-')) return 'post-processing';
  throw new Error(`no fixture stage for ${questionId}`);
}

/**
 * Creates a fresh project in the first fixture organisation with the signed-in session (`page.request`), then opens S-12
 * of `questionId` in its stage and waits for the question heading. Returns the project id.
 */
export async function openQuestionIn(page: Page, questionId: string): Promise<string> {
  const slug = fixtureOrgSlug();
  const res = await page.request.post(`/api/v1/orgs/${slug}/projects`, { data: { requestId: crypto.randomUUID(), name: `Decision spec ${Date.now()}`, aiSystemType: 'classification' } });
  expect(res.status(), 'project create').toBe(201);
  const { id } = (await res.json()) as { id: string };
  await page.goto(`/orgs/${slug}/projects/${id}/stages/${stageOf(questionId)}/questions/${questionId}`);
  await waitForQuestionPage(page);
  return id;
}

// ─── Fixture-seat helpers the decision specs share (storage states, no new sign-in) ──────────────────────────────

/** Puts the role's saved session (from `auth.setup.ts`) into this page's context. */
export async function actAsSeat(page: Page, role: OrgRole, index: 0 | 1 = 0): Promise<void> {
  const state = JSON.parse(fs.readFileSync(seatOf(role, index).storageStatePath, 'utf8')) as { cookies: Parameters<import('@playwright/test').BrowserContext['addCookies']>[0] };
  await page.context().clearCookies();
  await page.context().addCookies(state.cookies);
}

/** A request context signed in as the role's seat, for API calls a spec makes as another member. */
export async function seatRequest(baseURL: string, role: OrgRole): Promise<import('@playwright/test').APIRequestContext> {
  const { request } = await import('@playwright/test');
  return request.newContext({ baseURL, storageState: seatOf(role).storageStatePath });
}

/** A fresh project in the first fixture organisation, created by its owner. */
export async function newProject(baseURL: string, name = `Decision spec ${Date.now()}`): Promise<string> {
  const owner = await seatRequest(baseURL, 'owner');
  try {
    const res = await owner.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects`, { data: { requestId: crypto.randomUUID(), name, aiSystemType: 'classification' } });
    expect(res.status(), 'project create').toBe(201);
    return ((await res.json()) as { id: string }).id;
  } finally {
    await owner.dispose();
  }
}

export const questionPath = (projectId: string, questionId: string): string =>
  `/orgs/${fixtureOrgSlug()}/projects/${projectId}/stages/${stageOf(questionId)}/questions/${questionId}`;
export const historyPath = (projectId: string, questionId: string): string => `${questionPath(projectId, questionId)}/history`;
export const stagePath = (projectId: string, stage: string): string => `/orgs/${fixtureOrgSlug()}/projects/${projectId}/stages/${stage}`;

/** Opens S-12 of `questionId` in a new project (or `projectId`) with the role's saved session; returns the project id. */
export async function openQuestion(page: Page, role: OrgRole, questionId: string, baseURL: string, projectId?: string, index: 0 | 1 = 0): Promise<string> {
  const id = projectId ?? await newProject(baseURL);
  await actAsSeat(page, role, index);
  await page.goto(questionPath(id, questionId));
  await waitForQuestionPage(page);
  return id;
}

/** S-12 is ready: its heading is shown and, where the role has a form, the form has mounted and read the device's draft. */
export async function waitForQuestionPage(page: Page): Promise<void> {
  await expect(page.locator('#question-heading')).toBeVisible();
  await page.waitForFunction(() => {
    const form = document.querySelector('[data-region="answer-form"] form');
    return form === null || form.getAttribute('data-ready') === 'true';
  });
}

/**
 * Opens "Decided by" and "Decided on" on S-12: the form opens with one line, "Decided by you, <date> · Change", and the
 * Change button reveals the two fields (answer cost; one-way, so a second call does nothing).
 */
export async function openWhoWhen(page: Page): Promise<void> {
  const change = page.getByRole('button', { name: 'Change', exact: true });
  if (await change.count() > 0) await change.click();
  await page.locator('#decision-decided-by').waitFor();
}

/**
 * Fills the S-12 form with a valid answer: Done and a reason; `over` changes any part. Who and when need no filling: the form
 * opens as the signed-in person (or the earlier decider on a change) and the device's today (answer cost, design 2026-11-22
 * section 2 item 1). On a change of a decision someone else made, the fields open with the date empty (D-425), and a valid
 * answer needs a date, so with no date part given it presses Today there. Passing `decidedBy` or a date part opens them with
 * Change first. `reason: ''` leaves the optional reason empty. The reason box is found by its exact name, "Reason (optional)".
 */
export async function fillValid(page: Page, over: { status?: string | null; reason?: string; decidedBy?: string; day?: string; month?: string; year?: string } = {}): Promise<void> {
  if (over.status !== null) await page.getByRole('radio', { name: over.status ?? 'Done', exact: true }).check();
  const reason = over.reason ?? 'Compared a rule-based alert with the model.';
  if (reason !== '') await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${REASON_OPTIONAL}`, { exact: true }).fill(reason);
  if (over.decidedBy !== undefined || over.day !== undefined || over.month !== undefined || over.year !== undefined) await openWhoWhen(page);
  if (over.decidedBy !== undefined) await page.getByLabel('Decided by (required)').selectOption({ label: over.decidedBy });
  if (over.day !== undefined || over.month !== undefined || over.year !== undefined) {
    await page.getByLabel('Day', { exact: true }).fill(over.day ?? '');
    await page.getByLabel('Month', { exact: true }).fill(over.month ?? '');
    await page.getByLabel('Year', { exact: true }).fill(over.year ?? '');
  } else {
    const year = page.getByLabel('Year', { exact: true });
    if (await year.count() > 0 && await year.inputValue() === '') await page.getByRole('button', { name: 'Today', exact: true }).click();
  }
}

/**
 * After a clean Save the page moves on (answer cost): to `?saved=<questionId>` of the next unanswered question, or of the stage's end
 * screen, where a line says what was saved ("Your answer to question 4 is saved: decided by you, 22 Nov 2026."). `decider` is how
 * that line names who decided ("you" for the person's own). The old "Saved at ... as version n" line is shown only by a save that
 * stays (a file left out, text typed during the save, or the refusals).
 */
export async function expectMovedOn(page: Page, questionId: string, decider = 'you'): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`\\?saved=${questionId}$`), { timeout: 30_000 });
  await expect(page.locator('[data-saved-arrival]')).toContainText(`is saved: decided by ${decider}, `);
}

/** Opens `questionId` again in the project (after a Save moved the page on) and waits for its form. */
export async function backToQuestion(page: Page, projectId: string, questionId: string): Promise<void> {
  await page.goto(questionPath(projectId, questionId));
  await waitForQuestionPage(page);
}

/** The ids Q-PP-<from> to Q-PP-<to>. */
export const ppRange = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `Q-PP-${String(from + i).padStart(2, '0')}`);

/**
 * Answers the Pre-processing questions `ids` as the Assessor through route 1 (the personal-data gate takes a scope answer "no", every
 * other question Done), so a walk can start where it wants or reach the stage's end. Q-PP-GATE-SENSITIVE at "no" hides Q-PP-13 and Q-PP-14.
 */
export async function seedAnswers(baseURL: string, projectId: string, ids: readonly string[]): Promise<void> {
  const ctx = await seatRequest(baseURL, 'assessor');
  try {
    for (const questionId of ids) {
      const gate = questionId === 'Q-PP-GATE-SENSITIVE';
      const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
        requestId: crypto.randomUUID(), stage: 'pre-processing', questionId, baseVersionNumber: null,
        status: gate ? null : 'done', scopeAnswer: gate ? 'no' : null, optionsInPlace: [], reasonCode: null, reason: '',
        decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
      } });
      expect(res.status(), `seeding ${questionId}`).toBe(201);
    }
  } finally {
    await ctx.dispose();
  }
}

/** Records the `requestId` of every decision save the page sends, in order. */
export function captureDecisionRequestIds(page: Page): { sent: string[] } {
  const out = { sent: [] as string[] };
  page.on('request', (r) => {
    if (r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname)) out.sent.push((r.postDataJSON() as { requestId: string }).requestId);
  });
  return out;
}

/** The draft keys (`makrai.draft.v1:` ...) in this page's localStorage, optionally of one account only. */
export async function draftKeys(page: Page, userId?: string): Promise<string[]> {
  const prefix = userId === undefined ? 'makrai.draft.v1:' : `makrai.draft.v1:${userId}:`;
  return page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p) && k !== 'makrai.draft.v1:probe'), prefix);
}

/** The stored draft values, as text. */
export async function draftValues(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('makrai.draft.v1:') && k !== 'makrai.draft.v1:probe').map((k) => localStorage.getItem(k) ?? ''));
}

/** Saves a decision through route 1 as the role's seat (contract route row 1); returns the reply's status and body. */
export async function saveViaApi(
  baseURL: string, role: OrgRole, projectId: string, questionId: string,
  over: { baseVersionNumber?: number | null; reason?: string; status?: string } = {},
): Promise<{ status: number; body: { versionNumber: number } }> {
  const ctx = await seatRequest(baseURL, role);
  try {
    const res = await ctx.post(`/api/v1/orgs/${fixtureOrgSlug()}/projects/${projectId}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: stageOf(questionId), questionId, baseVersionNumber: over.baseVersionNumber ?? null,
      status: over.status ?? 'done', scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: over.reason ?? 'Saved through the API',
      decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
    } });
    return { status: res.status(), body: await res.json() };
  } finally {
    await ctx.dispose();
  }
}

/**
 * The save status line's two regions on S-12. The shell has its own `role="status"` (the offline banner) and the idle
 * warning its own `role="alert"`, so a spec reads the form's regions, scoped to the answer form (UX-25).
 */
export const saveStatus = (page: Page) => page.locator('[data-region="answer-form"] .save-status').getByRole('status');
export const saveAlert = (page: Page) => page.locator('[data-region="answer-form"] .save-status').getByRole('alert');
