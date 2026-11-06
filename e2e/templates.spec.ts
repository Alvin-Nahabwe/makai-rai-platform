import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { expectNoSeriousA11yViolations } from './helpers/a11y';

/**
 * Task 9 of units/C-TPL.md. Every template that data/resources.json lists (the reviewed ones, FR-SUG-06) is opened as the
 * server serves it, at a desktop and a phone width, and axe-core reports no serious or critical violation (NFR-A11Y-01).
 * The file list is read from the resources file, so a template added there is checked without editing this spec.
 */
const resources = JSON.parse(readFileSync(join(process.cwd(), 'data', 'resources.json'), 'utf8')) as {
  templates: Array<{ file: string }>;
};
const WIDTHS = [1280, 360];

test('TC-5 NFR-A11Y-01: each template has no serious or critical axe violation at 1280 and 360 widths', async ({ page }) => {
  expect(resources.templates.length, 'data/resources.json lists the reviewed templates').toBeGreaterThan(0);
  for (const { file } of resources.templates) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(file);
      expect(response?.status(), `${file} is served`).toBe(200);
      await expectNoSeriousA11yViolations(page, `${file} ${width}`);
    }
  }
});
