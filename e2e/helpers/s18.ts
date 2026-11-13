import { readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { MANIFEST_PATH, type FixtureManifest } from '../fixtures/manifest';

/** What the S-18 specs share (documents.spec.ts, document-actions.spec.ts): the fixture organisation, its seats, and keyboard and reflow helpers. */
export const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
export const org = manifest.orgs[0];

export function seat(role: OrgRole) {
  const s = manifest.users.find((u) => u.orgSlug === org.slug && u.role === role && u.index === 0);
  if (!s) throw new Error(`the fixture manifest has no ${role} seat for ${org.slug}`);
  return s;
}

/** Replaces the page's session cookies with the fixture seat's. */
export async function signIn(page: Page, role: OrgRole): Promise<void> {
  await page.context().clearCookies();
  const state = JSON.parse(readFileSync(seat(role).storageStatePath, 'utf8')) as { cookies: Array<{ name: string; value: string; domain: string; path: string }> };
  await page.context().addCookies(state.cookies);
}

/** Presses Tab until `target` has focus (keyboard only, NFR-A11Y-02), failing after 120 presses. */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 120; i++) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('tabTo: the target never took focus');
}

/** From 1024 px .shell__main is a scroll container (overflow-y auto makes overflow-x auto too), so overflow inside it never reaches the root that expectNoHorizontalScroll reads (C4 m4); below 1024 px the document scrolls and both checks read the same overflow. */
export async function expectMainDoesNotScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => { const el = document.querySelector('.shell__main') as HTMLElement; return { scroll: el.scrollWidth, client: el.clientWidth }; });
  expect(m.scroll, '.shell__main scrollWidth').toBeLessThanOrEqual(m.client);
}
