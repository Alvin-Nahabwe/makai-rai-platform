import { closeSync, fchmodSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import type { PerfManifest } from '../../scripts/load/seed-perf-fixture';

/**
 * The image config's setup step (V Task 3 Step 2): signs in the owner seat of scripts/load/seed-perf-fixture.ts's manifest
 * on the served build and keeps its storage state, which e2e/first-visit-transfer.spec.ts's image run measures with. The
 * default config never runs this file: no project there matches a name ending `.image.ts` (playwright.config.ts: `setup`
 * matches auth.setup.ts, `chromium` the default .spec/.test names). The storage state holds a live session, so it is made
 * mode 600; it lives beside the manifest, outside the repository.
 */
setup('NFR-PERF-02: the seeded owner signs in on the served build and keeps its storage state', async ({ page }) => {
  const path = process.env.PERF_MANIFEST;
  if (!path) throw new Error('PERF_MANIFEST is not set');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as PerfManifest;
  const owner = manifest.users.find((u) => u.role === 'owner');
  if (!owner) throw new Error(`${path} has no owner user`);
  await page.goto('/login');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Password').fill(owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => /^\/orgs\/[^/]+\/dashboard$/.test(u.pathname));
  // Created mode 600 before the session is written into it, so the live session is never readable by others.
  const state = await page.context().storageState();
  const fd = openSync(owner.storageStatePath, 'w', 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(state)); } finally { closeSync(fd); }   // fchmod: an existing file keeps its mode on open
});
