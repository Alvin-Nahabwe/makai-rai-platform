import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { REVIEW_COPY } from '../lib/review/copy';

/**
 * Design G2 and SRS FR-DOC-09 clause 10: the seal step on the stage page (S-11), for the fixture organisation's seats of
 * e2e/fixtures/manifest.ts. Each test makes its own project through the owner's API, so what it sees does not depend on
 * what other specs wrote.
 */
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
const org = manifest.orgs[0];
const C = REVIEW_COPY.sealStep;

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

async function newProject(baseURL: string): Promise<{ id: string }> {
  const ctx = await pwRequest.newContext({ baseURL, storageState: seat('owner').storageStatePath });
  try {
    const res = await ctx.post(`/api/v1/orgs/${org.slug}/projects`, { data: { requestId: randomUUID(), name: `Seal step ${randomUUID().slice(0, 8)}`, aiSystemType: 'classification' } });
    if (!res.ok()) throw new Error(`creating the project answered ${res.status()}: ${await res.text()}`);
    return (await res.json()) as { id: string };
  } finally {
    await ctx.dispose();
  }
}

const stagePage = (projectId: string) => `/orgs/${org.slug}/projects/${projectId}/stages/pre-processing`;
const step = (page: Page) => page.locator('.seal-step');

test('G2: an Assessor asks on the stage page; the step reads Review opened · waiting for an Owner, Admin or Reviewer to seal; a Reviewer then sees Seal this stage', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = await newProject(baseURL!);

  // A Reviewer holds review:seal but not review:open: before any review is open there is nothing for them to press.
  await signIn(page, 'reviewer');
  await page.goto(stagePage(p.id));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(step(page)).toHaveCount(0);

  await signIn(page, 'assessor');
  await page.goto(stagePage(p.id));
  const ask = page.getByRole('button', { name: C.ask });
  await expect(ask).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  // By keyboard: focus the button and press Enter.
  await ask.focus();
  await page.keyboard.press('Enter');
  const waiting = step(page).getByText(C.waiting, { exact: true });
  await expect(waiting).toBeVisible();
  await expect(ask).toHaveCount(0);
  // The button is gone, so focus moves to the line that replaced it.
  await expect(waiting).toBeFocused();
  // A reload shows the same line: the review is open on the server.
  await page.reload();
  await expect(step(page).getByText(C.waiting, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: C.ask })).toHaveCount(0);

  await signIn(page, 'reviewer');
  await page.goto(stagePage(p.id));
  const seal = page.getByRole('link', { name: C.seal });
  await expect(seal).toBeVisible();
  await expect(step(page).getByText(C.waiting)).toHaveCount(0);
  await seal.click();
  await expect(page).toHaveURL(/\/reviews\/[0-9a-f-]{36}\/seal$/);
});

test('a Viewer sees no seal action on the stage page', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = await newProject(baseURL!);
  await signIn(page, 'viewer');
  await page.goto(stagePage(p.id));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(step(page)).toHaveCount(0);

  // With a review open (an Assessor asked), the Viewer sees the status line and still no action.
  const ctx = await pwRequest.newContext({ baseURL: baseURL!, storageState: seat('assessor').storageStatePath });
  try {
    const res = await ctx.post(`/api/v1/orgs/${org.slug}/projects/${p.id}/reviews/seal-request`, { data: { requestId: randomUUID(), stage: 'pre-processing' } });
    expect(res.status()).toBe(201);
  } finally {
    await ctx.dispose();
  }
  await page.reload();
  await expect(step(page).getByText(C.waiting, { exact: true })).toBeVisible();
  await expect(step(page).getByRole('button')).toHaveCount(0);
  await expect(step(page).getByRole('link')).toHaveCount(0);
  for (const name of [C.ask, C.seal, C.openAndSeal]) await expect(page.getByText(name, { exact: true })).toHaveCount(0);
});

test('design §8: an Owner opens and seals in one step, landing on the review\'s seal page', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const p = await newProject(baseURL!);
  await signIn(page, 'owner');
  await page.goto(stagePage(p.id));
  await page.getByRole('button', { name: C.openAndSeal }).click();
  await expect(page).toHaveURL(/\/reviews\/[0-9a-f-]{36}\/seal$/);
  // Back on the stage page, the review is open: the Owner now sees Seal this stage.
  await page.goto(stagePage(p.id));
  await expect(page.getByRole('link', { name: C.seal })).toBeVisible();
});
