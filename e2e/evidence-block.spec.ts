import { readFileSync } from 'node:fs';
import { expect, request as pwRequest, test, type Page } from '@playwright/test';
import type { OrgRole as FixtureRole } from '@prisma/client';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { failOnDialog } from './helpers/dialogs';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { applyNetworkProfile } from './helpers/network';

/**
 * The evidence block on S-12 (UX-30, NFR-PERF-06, NFR-A11Y-02, NFR-A11Y-05, M-14 to M-19). S-12 answers an error until
 * DEC-b fills `loadQuestionPanel`, so the spec skips while the page is not ready. Under RELEASE_CANDIDATE=1 the skip
 * is off, so a release cannot pass with it skipped.
 */
const QUESTION = 'Q-PP-01';
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
const org = manifest.orgs[0];

function seat(role: FixtureRole) {
  const s = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === 0);
  if (!s) throw new Error(`the fixture manifest has no ${role} seat for ${org.slug}`);
  return s;
}

const projectIds: Partial<Record<FixtureRole, string>> = {};

async function s12Url(role: FixtureRole, baseURL: string): Promise<string> {
  if (projectIds[role] === undefined) {
    const owner = await pwRequest.newContext({ baseURL, storageState: seat('owner').storageStatePath });
    try {
      const res = await owner.post(`/api/v1/orgs/${org.slug}/projects`, { data: { name: `Evidence block (${role})`, aiSystemType: 'classification' } });
      if (!res.ok()) throw new Error(`project create answered ${res.status()}`);
      projectIds[role] = ((await res.json()) as { id: string }).id;
    } finally {
      await owner.dispose();
    }
  }
  return `/orgs/${org.slug}/projects/${projectIds[role]}/stages/pre-processing/questions/${QUESTION}`;
}

test.beforeEach(async ({ baseURL }, info) => {
  if (process.env.RELEASE_CANDIDATE === '1') return;
  const probe = await pwRequest.newContext({ baseURL, storageState: seat('assessor').storageStatePath });
  try {
    const res = await probe.get(await s12Url('assessor', baseURL as string));
    info.skip(res.status() !== 200, 'S-12 needs DEC-b');
  } finally {
    await probe.dispose();
  }
});

async function openS12(page: Page, role: FixtureRole, baseURL: string): Promise<void> {
  const state = JSON.parse(readFileSync(seat(role).storageStatePath, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  await page.context().addCookies(state.cookies);
  await page.goto(await s12Url(role, baseURL));
}

const pdfOf = (size: number, name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(Math.max(0, size - 9), 0x20)]) });
const bytesOf = (size: number, name: string) => ({ name, mimeType: 'application/pdf', buffer: Buffer.alloc(size, 0x20) });

async function chooseFile(page: Page, f: { name: string; mimeType?: string; buffer?: Buffer; bytes?: Buffer }): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({ name: f.name, mimeType: f.mimeType ?? 'application/octet-stream', buffer: f.buffer ?? f.bytes ?? Buffer.alloc(0) });
}
async function uploadLine(page: Page, name: string): Promise<string> {
  return (await page.getByText(new RegExp(`^Uploading ${name.replace('.', '\\.')}:`)).first().textContent()) ?? '';
}
async function focusByKeyboard(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute('aria-label') ?? el.textContent ?? '').trim() : '';
    });
    if (focused === name) return;
  }
  throw new Error(`no element named "${name}" took focus within 60 Tab presses`);
}
function decisionRequests(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/decisions$/.test(new URL(r.url()).pathname)) n++; });
  return () => n;
}

test('UX-30 NFR-PERF-06: under the Poor profile the line shows changing byte counts as text and no progress element', async ({ page, baseURL }) => {
  await applyNetworkProfile(page, 'Poor');
  await openS12(page, 'assessor', baseURL as string);
  await chooseFile(page, pdfOf(2_400_000, 'costing.pdf'));
  await expect(page.getByText(/^2\.4 MB\. Large files are slow on poor connections/)).toBeVisible();
  const first = await uploadLine(page, 'costing.pdf');
  await page.waitForTimeout(3000);
  expect(await uploadLine(page, 'costing.pdf')).not.toBe(first);
  expect(first).toMatch(/^Uploading costing\.pdf: \d\.\d of 2\.4 MB\.$/);
  await expect(page.locator('progress, [role="progressbar"]')).toHaveCount(0);
});

test('M-18 UX-30: reloading mid-upload names the file that was not uploaded', async ({ page, baseURL }) => {
  await applyNetworkProfile(page, 'Poor');
  await openS12(page, 'assessor', baseURL as string);
  await chooseFile(page, pdfOf(2_400_000, 'costing.pdf'));
  await page.reload();
  await expect(page.getByText('costing.pdf was not uploaded before the page closed. Choose the file again.')).toBeVisible();
});

test('M-15 M-16: a too-large file and a wrong type show their messages', async ({ page, baseURL }) => {
  await openS12(page, 'assessor', baseURL as string);
  await chooseFile(page, bytesOf(11_000_000, 'big.pdf'));
  await expect(page.getByText('Not uploaded: big.pdf is larger than 10 MB. Add a link to where it is kept instead.')).toBeVisible();
  await chooseFile(page, { name: 'x.html', buffer: Buffer.from('<html>') });
  await expect(page.getByText('Not uploaded: x.html is not a PDF, PNG, JPEG, Office document or ZIP file.')).toBeVisible();
});

test('M-19: the eleventh upload in a minute shows the upload limit', async ({ page, baseURL }) => {
  await openS12(page, 'admin', baseURL as string);   // its own account, so the limiter window of the other tests is untouched
  for (let i = 0; i < 10; i++) await chooseFile(page, pdfOf(1000, `f${i}.pdf`));
  await chooseFile(page, pdfOf(1000, 'f10.pdf'));
  await expect(page.getByText('Not uploaded: you can upload 10 files a minute. Wait a minute, then retry.')).toBeVisible();
});

test('M-17 M-14: an upload cut off offers Retry upload, which then uploads', async ({ page, context, baseURL }) => {
  await openS12(page, 'assessor', baseURL as string);
  await context.setOffline(true);
  await chooseFile(page, pdfOf(200_000, 'cut.pdf'));
  await expect(page.getByText('Not uploaded: connection lost.')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: /Retry upload/ }).click();
  await expect(page.getByText('Uploaded cut.pdf (200 KB).')).toBeVisible();
});

test('NFR-A11Y-02 NFR-A11Y-05 UX-30: the block works by keyboard alone, at 320 px, with no serious axe violation', async ({ page, baseURL }) => {
  failOnDialog(page);
  await page.setViewportSize({ width: 320, height: 800 });
  await openS12(page, 'assessor', baseURL as string);
  const posted = decisionRequests(page);
  await focusByKeyboard(page, 'Add a link');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('ftp://x');
  await page.keyboard.press('Enter');   // Enter adds the link; it must not submit the decision form
  await expect(page.getByText('Enter a web address that starts with http:// or https://.')).toBeVisible();
  expect(posted()).toBe(0);
  await expectFocusVisibleAndUncovered(page);
  await expectNoSeriousA11yViolations(page, 'S-12 evidence block with a link error at 320 px');
});
