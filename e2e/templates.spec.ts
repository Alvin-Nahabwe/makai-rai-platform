import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { ResourcesFile } from '../types/content';
import { expectNoSeriousA11yViolations } from './helpers/a11y';

/**
 * Task 9 of units/C-TPL.md. Every template that data/resources.json lists as passed (FR-SUG-06) is opened as the server
 * serves it. The served bytes must equal the entry's sha256 (T3: served bytes equal reviewed bytes), and axe-core reports
 * no serious or critical violation at a desktop and a phone width (NFR-A11Y-01). A failed entry is held back, not served,
 * so it is not visited. The file list is read from the resources file, so a template added there is checked without
 * editing this spec; each path is checked against the contract pattern before it is visited.
 */
const FILE = /^\/templates\/[A-Za-z0-9._-]+\.html$/;
const passed = (JSON.parse(readFileSync(join(process.cwd(), 'data', 'resources.json'), 'utf8')) as ResourcesFile).templates.filter(
  (e) => e.review.outcome === 'passed',
);
const WIDTHS = [1280, 360];

test('TC-7 T3 FR-SUG-06: each passed template is served with the bytes that were reviewed', async ({ request }) => {
  expect(passed.length, 'data/resources.json lists the passed templates').toBeGreaterThan(0);
  for (const { file, sha256, bytes } of passed) {
    expect(file).toMatch(FILE);
    const response = await request.get(file);
    expect(response.status(), `${file} is served`).toBe(200);
    const body = await response.body();
    expect(body.length, `${file} bytes`).toBe(bytes);
    expect(createHash('sha256').update(body).digest('hex'), `${file} sha256`).toBe(sha256);
  }
});

test('TC-5 NFR-A11Y-01: each template has no serious or critical axe violation at 1280 and 360 widths', async ({ page }) => {
  expect(passed.length, 'data/resources.json lists the passed templates').toBeGreaterThan(0);
  for (const { file } of passed) {
    expect(file).toMatch(FILE);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(file);
      expect(response?.status(), `${file} is served`).toBe(200);
      await expectNoSeriousA11yViolations(page, `${file} ${width}`);
    }
  }
});
