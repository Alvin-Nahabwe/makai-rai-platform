import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { MANIFEST_PATH, type FixtureManifest } from './fixtures/manifest';
import { NOT_FOUND_COPY } from '../lib/errors/not-found/copy';
import { pageTitle } from '../lib/ui/title';

/**
 * UX-05 and FR-AUTHZ-01 (SRS lines 1646-1647): a non-member opening an organisation's page, a member opening a
 * record that does not exist, and anyone opening an organisation that does not exist all get the same S-31,
 * with status 404, so the answer says nothing about what exists. The three main contents are compared with each
 * other, so this holds on whatever not-found page the branch has (Next's own until UI adds app/not-found.tsx);
 * M-27's text is pinned by UI's and ORG's own S-31 tests.
 *
 * The status matters: Next 16 sends 404 only "before streaming starts"
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/not-found.md:15), so a page that
 * streams before its gate would answer 200 and fail here.
 */

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const [orgA, orgB] = manifest.orgs;
const viewerOfA = manifest.users.find((u) => u.orgSlug === orgA.slug && u.role === 'viewer' && u.index === 0);

test('UX-05 FR-AUTHZ-01: non-member, missing record and unknown organisation get the same S-31', async ({ browser }) => {
  if (!viewerOfA) throw new Error('not-found-parity: no viewer seat in organisation A');
  const context = await browser.newContext({ storageState: viewerOfA.storageStatePath });
  const page = await context.newPage();
  const pages = [
    `/orgs/${orgB.slug}/dashboard`,                                             // a non-member
    `/orgs/${orgA.slug}/projects/00000000-0000-4000-8000-000000000000`,         // a record that does not exist
    '/orgs/no-such-organisation/dashboard',                                     // an organisation that does not exist
  ];
  const mains: string[] = [];
  const titles: string[] = [];
  try {
    for (const p of pages) {
      const r = await page.goto(p);
      expect({ p, status: r?.status() }).toEqual({ p, status: 404 });
      mains.push(await page.locator('main').innerHTML());
      titles.push(await page.title());
    }
  } finally {
    await context.close();
  }
  expect(mains[0].length).toBeGreaterThan(0);
  expect(new Set(mains).size).toBe(1);   // one page for all three (M-27's text is pinned by UI and ORG)
  // Spec 7.5 (Task 10): the same non-empty tab title for all three, so the title says no more than the page.
  console.log(`not-found-parity titles: ${JSON.stringify(titles)}`);
  expect(titles).toEqual(pages.map(() => pageTitle(NOT_FOUND_COPY.title)));
});
