import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test, type Locator, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { PROJECT_COPY } from '../lib/project/copy';

/**
 * J-08 and the S-16 / S-17 states (FR-REV-01, 02, 03, 05; UX-18, UX-31, M-28; NFR-A11Y-02, NFR-A11Y-05). The fixture
 * organisation of e2e/fixtures/manifest.ts; decisions are seeded through DEC-a's route with the seat's own session.
 * S-10 does not render the review slot until PRJ merges, so J-08 starts at the open form's address (S-16's form), as
 * S-10's "Open a stage review" link will open it.
 */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
const org = manifest.orgs[0];

function seat(role: OrgRole) {
  const s = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === 0);
  if (!s) throw new Error(`the fixture manifest has no ${role} seat for ${org.slug}`);
  return s;
}

async function signIn(page: Page, role: OrgRole): Promise<void> {
  await page.context().clearCookies();
  const state = JSON.parse(readFileSync(seat(role).storageStatePath, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  await page.context().addCookies(state.cookies);
}

async function api<T>(baseURL: string, role: OrgRole, path: string, data: Record<string, unknown>): Promise<T> {
  const ctx = await pwRequest.newContext({ baseURL, storageState: seat(role).storageStatePath });
  try {
    const res = await ctx.post(path, { data });
    if (!res.ok()) throw new Error(`${path} answered ${res.status()}: ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

const newProject = (baseURL: string, name: string) =>
  api<{ id: string }>(baseURL, 'owner', `/api/v1/orgs/${org.slug}/projects`, { requestId: randomUUID(), name, aiSystemType: 'classification' });
const openReview = (baseURL: string, projectId: string) =>
  api<{ id: string }>(baseURL, 'admin', `/api/v1/orgs/${org.slug}/projects/${projectId}/reviews`, { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null });
const saveDecision = (baseURL: string, projectId: string, questionId: string, baseVersionNumber: number | null) =>
  api(baseURL, 'assessor', `/api/v1/orgs/${org.slug}/projects/${projectId}/decisions`, {
    requestId: randomUUID(), stage: 'pre-processing', questionId, baseVersionNumber, status: 'done', scopeAnswer: null, optionsInPlace: [],
    reasonCode: null, reason: `End-to-end reason ${randomUUID()} for this decision.`, decidedBy: { kind: 'outside_role', role: 'principal_investigator' },
    declaredDate: '2026-10-30', evidenceIds: [],
  });

/** Presses Tab until `target` has focus (keyboard only, NFR-A11Y-02), failing after 80 presses. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('tabTo: the target never took focus');
}

const sealedStatus = (page: Page) => page.getByRole('status').filter({ hasText: /^Sealed as seal/ });

test('FR-REV-01 FR-REV-02 FR-REV-03 FR-REV-05 M-28 NFR-A11Y-02: J-08 by keyboard alone', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = await newProject(baseURL!, `J-08 ${randomUUID().slice(0, 8)}`);
  await signIn(page, 'admin');
  // NFR-PRIV-04 (obligation B5, C4 SC-3): no request of the journey carries the note in its address.
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto(`/orgs/${org.slug}/projects/${p.id}/reviews/new?stage=pre-processing`);
  await tabTo(page, page.getByLabel('Prepared for (optional)'));
  await page.keyboard.type('Ethics board submission 1');
  await expect(page.getByText('25 of 120')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pre-processing review 1');
  await expect(page.getByText('Prepared for: Ethics board submission 1')).toBeVisible();
  await expect(page.getByText('Never sealed.')).toBeVisible();
  const s16 = page.url();
  expect(urls.length).toBeGreaterThan(1);
  expect(urls.filter((u) => /Ethics|board(%20|\+| )submission/i.test(u))).toEqual([]);

  await signIn(page, 'reviewer');
  await page.goto(s16);
  await tabTo(page, page.getByRole('link', { name: 'Seal this review' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Seal "Pre-processing review 1" as seal 1');
  await expect(page.getByText(/^A seal fixes what the record says right now, gaps included\./)).toBeVisible();
  await expect(page.getByText(/^No decision \(\d+\)/)).toBeVisible();
  await tabTo(page, page.getByRole('button', { name: 'Seal as seal 1' }));
  await page.keyboard.press('Enter');
  await expect(sealedStatus(page)).toHaveText(/^Sealed as seal 1 on \d{1,2} [A-Z][a-z]{2} 2026 at .+\. Fingerprint [0-9a-f]{4} [0-9a-f]{4} \.\.\. [0-9a-f]{4}\.$/);
  await expect(sealedStatus(page)).toBeFocused();
  await expectFocusVisibleAndUncovered(page);

  await saveDecision(baseURL!, p.id, 'Q-PP-01', null);
  await page.goto(s16);
  await expect(page.getByText('Changed since seal 1 (1).')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Q-PP-01' })).toBeVisible();
  await tabTo(page, page.getByRole('button', { name: 'Check this seal' }));
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Matches the record.' })).toBeVisible();
});

test('UX-18: one draft of the stage on this device shows the unsaved-answers line first on S-17', async ({ page, baseURL }) => {
  const p = await newProject(baseURL!, `Drafts ${randomUUID().slice(0, 8)}`);
  const r = await openReview(baseURL!, p.id);
  const orgRow = await testDb.organization.findUniqueOrThrow({ where: { slug: org.slug }, select: { id: true } });
  await signIn(page, 'reviewer');
  await page.goto(`/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}`);
  // One draft of this account for a question of the stage, and one of another account that must not count (B11).
  await page.evaluate(({ userId, other, orgId, projectId }) => {
    const draft = JSON.stringify({ baseVersionNumber: null, value: { status: 'done' }, savedAt: new Date().toISOString(), savePressedAt: null, retry: { requestId: null, sentBody: null } });
    localStorage.setItem(`makrai.draft.v1:${userId}:${orgId}:${projectId}:q:Q-PP-01`, draft);
    localStorage.setItem(`makrai.draft.v1:${other}:${orgId}:${projectId}:q:Q-PP-02`, draft);
    localStorage.setItem(`makrai.draft.v1:${userId}:${orgId}:${projectId}:q:Q-IP-01`, draft);   // another stage
  }, { userId: seat('reviewer').userId, other: seat('assessor').userId, orgId: orgRow.id, projectId: p.id });
  await page.goto(`/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seal`);
  await expect(page.locator('main').getByText(/^You have 1 unsaved answers in this stage on this device\. They will not be in the seal\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to them' })).toHaveAttribute('href', `/orgs/${org.slug}/projects/${p.id}/stages/pre-processing?show=drafts`);
});

test('UX-18 FR-DEC-07 (owner question B5): a slow seal says Sealing... then Still sealing, a lost reply shows the retry line, and Retry returns the first seal', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = await newProject(baseURL!, `Slow seal ${randomUUID().slice(0, 8)}`);
  const r = await openReview(baseURL!, p.id);
  const s16Url = `/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}`;
  await signIn(page, 'reviewer');
  await page.goto(`${s16Url}/seal`);
  const sealRoute = `**/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seals`;
  const sent: string[] = [];
  await page.route(sealRoute, async (route) => {
    sent.push(route.request().postData() ?? '');
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    await route.fetch();                    // the server commits seal 1
    await route.abort('connectionreset');   // and the reply is lost
  });
  await page.getByRole('button', { name: 'Seal as seal 1' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Sealing/ })).toHaveText('Sealing...');
  await expect(page.getByRole('status').filter({ hasText: /sealing/i })).toHaveText('Still sealing. The connection is slow.', { timeout: 15_000 });
  await expect(page.locator('main').getByRole('alert')).toContainText('Not sealed yet: no reply from the server. It may have arrived. Retry is safe: it will not seal twice.', { timeout: 20_000 });
  await page.unroute(sealRoute);
  const retried = page.waitForRequest((req) => req.url().endsWith(`/reviews/${r.id}/seals`) && req.method() === 'POST');
  const replied = page.waitForResponse((res) => res.url().endsWith(`/reviews/${r.id}/seals`));
  await page.getByRole('button', { name: 'Retry' }).click();
  expect(JSON.parse((await retried).postData() ?? '{}').requestId).toBe(JSON.parse(sent[0]).requestId);
  expect((await replied).status()).toBe(200);
  await expect(sealedStatus(page)).toContainText(/^Sealed as seal 1 on /);
  await page.goto(s16Url);
  await expect(page.getByText(/^Seal 1 \./)).toHaveCount(1);
  await expect(page.getByText(/^Seal 2 \./)).toHaveCount(0);
});

test('FR-DEC-07 NFR-INT-02 (C4 ruling on hunter H1): after a lost reply, a reload and a new press replay the first request id, the route answers 200 with that seal, and no second seal exists', async ({ page, baseURL }) => {
  test.setTimeout(60_000);
  const p = await newProject(baseURL!, `Reload seal ${randomUUID().slice(0, 8)}`);
  const r = await openReview(baseURL!, p.id);
  const s16Url = `/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}`;
  await signIn(page, 'reviewer');
  await page.goto(`${s16Url}/seal`);
  const sealRoute = `**/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seals`;
  const sent: string[] = [];
  await page.route(sealRoute, async (route) => {
    sent.push(route.request().postData() ?? '');
    await route.fetch();                    // the server commits seal 1
    await route.abort('connectionreset');   // and the reply is lost
  });
  await page.getByRole('button', { name: 'Seal as seal 1' }).click();
  await expect(page.locator('main').getByRole('alert')).toContainText('Not sealed yet: no reply from the server. It may have arrived. Retry is safe: it will not seal twice.');
  await page.unroute(sealRoute);
  await page.reload();
  const again = page.waitForRequest((req) => req.url().endsWith(`/reviews/${r.id}/seals`) && req.method() === 'POST');
  const answer = page.waitForResponse((res) => res.url().endsWith(`/reviews/${r.id}/seals`));
  await page.getByRole('button', { name: /^Seal as seal \d$/ }).click();
  expect(JSON.parse((await again).postData() ?? '{}').requestId).toBe(JSON.parse(sent[0]).requestId);
  expect((await answer).status()).toBe(200);
  await expect(sealedStatus(page)).toContainText(/^Sealed as seal 1 on /);
  expect(await testDb.seal.count({ where: { stageReviewId: r.id } })).toBe(1);
});

test('FR-REV-03 UX-18: S-17 by address as an assessor shows the refusal line and no seal button', async ({ page, baseURL }) => {
  const p = await newProject(baseURL!, `Refusal ${randomUUID().slice(0, 8)}`);
  const r = await openReview(baseURL!, p.id);
  await signIn(page, 'assessor');
  const res = await page.goto(`/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}/seal`);
  expect(res?.status()).toBe(200);   // owner question B21 default
  await expect(page.getByText('Only owners, admins and reviewers can seal a stage review.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Seal as seal/ })).toHaveCount(0);
});

test('UX-31 NFR-A11Y-05: S-16 and S-17 have no serious axe violation at 1280 and 320 pixels in both themes, and no form when archived', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const p = await newProject(baseURL!, `Axe ${randomUUID().slice(0, 8)}`);
  const r = await openReview(baseURL!, p.id);
  const s16Url = `/orgs/${org.slug}/projects/${p.id}/reviews/${r.id}`;
  const s17Url = `${s16Url}/seal`;
  await signIn(page, 'reviewer');
  for (const width of [1280, 320]) for (const scheme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: scheme });
    for (const url of [s16Url, s17Url]) { await page.goto(url); await expectNoSeriousA11yViolations(page, `${url} ${width} ${scheme}`); }
  }
  // PRJ's archive route is not built yet (PENDING_ROUTES), so the fixture archives the project as the database owner.
  await testDb.project.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  await page.goto(s17Url);
  await expect(page.getByText(PROJECT_COPY.archivedBanner)).toBeVisible();
  await expect(page.getByRole('button', { name: /Seal as seal/ })).toHaveCount(0);
});

test('NFR-SEC-02 FR-AUTHZ-01 (C4 SO-2): S-16 of another organisation\'s review is not found, and a reviewer gets the open form\'s refusal line', async ({ page, baseURL }) => {
  const orgB = manifest.orgs[1];
  const ownerB = manifest.users.find((u) => u.orgSlug === orgB.slug && u.role === 'owner' && u.index === 0)!;
  const ctxB = await pwRequest.newContext({ baseURL, storageState: ownerB.storageStatePath });
  let pB: { id: string }; let rB: { id: string };
  try {
    pB = await (await ctxB.post(`/api/v1/orgs/${orgB.slug}/projects`, { data: { requestId: randomUUID(), name: `B ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' } })).json();
    rB = await (await ctxB.post(`/api/v1/orgs/${orgB.slug}/projects/${pB.id}/reviews`, { data: { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null } })).json();
  } finally {
    await ctxB.dispose();
  }
  await signIn(page, 'assessor');
  for (const path of [`/orgs/${org.slug}/projects/${pB.id}/reviews/${rB.id}`, `/orgs/${org.slug}/projects/${pB.id}/reviews/${rB.id}/seal`]) {
    expect((await page.goto(path))?.status(), path).toBe(404);
  }
  const p = await newProject(baseURL!, `Open refusal ${randomUUID().slice(0, 8)}`);
  await signIn(page, 'reviewer');
  expect((await page.goto(`/orgs/${org.slug}/projects/${p.id}/reviews/new`))?.status()).toBe(200);
  await expect(page.getByText('Only owners, admins and assessors can open a stage review.')).toBeVisible();
  await expect(page.getByLabel('Prepared for (optional)')).toHaveCount(0);
});

test.afterAll(async () => {
  await testDb.$disconnect();
});
