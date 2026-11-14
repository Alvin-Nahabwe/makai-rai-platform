import fs from 'node:fs';
import { expect, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from '../fixtures/manifest';
import { DECISION_FORM_COPY } from '../../lib/decision/form/copy';
import { FIELD_COPY } from '../../lib/ui/field/copy';

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

/** Fills the S-12 form with a valid answer: Done, a reason, decided by the person, Today; `over` changes any part. */
export async function fillValid(page: Page, over: { status?: string | null; reason?: string; decidedBy?: string; day?: string; month?: string; year?: string } = {}): Promise<void> {
  if (over.status !== null) await page.getByRole('radio', { name: over.status ?? 'Done', exact: true }).check();
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill(over.reason ?? 'Compared a rule-based alert with the model.');
  if (over.decidedBy !== undefined) await page.getByLabel('Decided by (required)').selectOption({ label: over.decidedBy });
  if (over.day === undefined && over.month === undefined && over.year === undefined) {
    await page.getByRole('button', { name: 'Today', exact: true }).click();
  } else {
    await page.getByLabel('Day', { exact: true }).fill(over.day ?? '');
    await page.getByLabel('Month', { exact: true }).fill(over.month ?? '');
    await page.getByLabel('Year', { exact: true }).fill(over.year ?? '');
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
