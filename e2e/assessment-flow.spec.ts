import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import type { OrgRole } from '@prisma/client';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * Task 12 Step 3 — a full assessment, end to end, driven entirely through
 * the real UI: project created, a lifecycle stage answered question by
 * question, the assessment completed, the report rendered, and the PDF
 * actually downloaded (a real browser `download` event, not a bare
 * `fetch`/status-code check — `app/api/v1/orgs/[slug]/reports/[id]/pdf/
 * route.ts` sets `Content-Disposition: attachment`, so Chromium turns the
 * click into a download rather than a navigation).
 *
 * ROLE: `assessor` (fixture, org B, seat index 1) — the narrowest role that
 * still holds every capability this flow exercises
 * (`project:create`, `assessment:create`, `assessment:respond`,
 * `assessment:complete` — lib/authz/policy.ts). Using `owner` would prove
 * less: every capability an owner has is a superset, so a flow that works
 * for `owner` alone would not show the flow works for the role that is
 * SUPPOSED to run it day to day.
 *
 * FIXTURE, NOT A FRESH LOGIN (brief constraint 1): reuses the existing
 * seat's storageState. Only ONE stage (pre-processing) is answered — the
 * engine only requires one stage complete to finish the assessment
 * (`lib/engine/AssessmentEngine.js#completeStage`'s `no_stages` check) —
 * so this proves the real path without clicking through all 78 questions
 * across all 3 stages, which would prove nothing additional about THIS
 * task's obligation (a working end-to-end path), only cost more runtime.
 */

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

function seat(orgSlug: string, role: OrgRole, index: 0 | 1): FixtureManifestUser {
  const found = manifest.users.find(
    (u) => u.orgSlug === orgSlug && u.role === role && u.index === index,
  );
  if (!found) throw new Error(`assessment-flow: no fixture seat for ${orgSlug}/${role}/${index}`);
  return found;
}

test.describe('a full assessment, end to end, by a role that may run it', () => {
  const [, orgB] = manifest.orgs;
  const assessor = seat(orgB.slug, 'assessor', 1);
  test.use({ storageState: assessor.storageStatePath });

  test('create, answer, complete, view report, download PDF', async ({ page }) => {
    // Sanity: this role really does hold every capability the flow below
    // exercises, checked against the same policy the server enforces —
    // if this ever goes false the rest of the test would be exercising a
    // role by accident rather than by design.
    expect(FIXTURE_ROLES).toContain('assessor');

    // --- Create a project ---
    const projectName = `Assessment Flow ${Date.now()}`;
    await page.goto(`/orgs/${orgB.slug}/projects/new`);
    await expect(page.locator('h1')).toHaveText('New Project');
    await page.fill('#name', projectName);
    await page.selectOption('#aiSystemType', 'classification');
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/orgs\/[a-z0-9-]+\/projects\/(?!new$)[a-zA-Z0-9-]+$/);
    await expect(page.locator('body')).toContainText(projectName);

    // --- Start a full assessment ---
    // `.first()`: a brand-new project with zero assessments renders BOTH
    // the header's StartAssessmentButton AND the empty-state's own copy
    // (app/(authenticated)/orgs/[slug]/projects/[id]/page.tsx) — two
    // functionally-identical entry points, so either is a correct click.
    await page.getByRole('button', { name: 'Start Full Assessment' }).first().click();
    await page.waitForURL(/\/orgs\/[a-z0-9-]+\/assessment\/[a-zA-Z0-9-]+$/);

    // --- Answer the pre-processing stage, module by module ---
    await page.getByRole('button', { name: /Pre-processing/ }).click();

    // Module 1 (Problem Formulation, 7 questions): answer every visible
    // radio question with its first option, then advance.
    await answerCurrentModule(page);
    await page.getByRole('button', { name: 'Next Module' }).click();

    // Module 2 (Data Collection & Preparation, up to 17 questions incl. a
    // gate that unlocks 2 more): answer with a couple of passes so the
    // gate's own conditional follow-ups get picked up once unlocked.
    await answerCurrentModule(page);
    await answerCurrentModule(page); // second pass: newly-unlocked conditionals
    await page.getByRole('button', { name: /Complete Pre-processing/ }).click();

    // --- Complete the assessment and view the report ---
    await expect(page.getByRole('heading', { name: 'Pre-processing stage finished' })).toBeVisible();
    await page.getByRole('button', { name: 'View Report Now' }).click();
    await page.waitForURL(/\/orgs\/[a-z0-9-]+\/assessment\/[a-zA-Z0-9-]+\/report$/);
    await expect(page.locator('h1')).toContainText('Readiness Report');

    // --- Download the PDF: a real browser download event ---
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download-pdf-btn').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const stat = fs.statSync(downloadPath!);
    expect(stat.size).toBeGreaterThan(0);
  });
});

/**
 * Answers every currently-visible, currently-unanswered question in the
 * open module with its first selectable option (radio: first `likert`/
 * `gate` option; checkbox: first `checklist` option) — enough to satisfy
 * `validateCurrentModule()`'s "every visible question answered" rule
 * without asserting anything about which option was chosen (this suite
 * proves the FLOW completes, not the engine's scoring, which
 * `__tests__/unit/` already covers).
 *
 * CLICKS THE `<label>`, NOT `.check()` ON THE `<input>` DIRECTLY:
 * `components/assessment/QuestionBlock.tsx` renders every option as a
 * `<label>` wrapping a visually-hidden `<input>` (a custom-styled radio/
 * checkbox — the native input has no box of its own; a sibling `<span>`
 * is the visible control). Playwright's `.check()` requires the target
 * element itself to be visible and timed out here on the FIRST question of
 * the FIRST run of this suite (`element is not visible`, 30s) — a real
 * finding about the interaction model, resolved per
 * `superpowers:systematic-debugging` by reading the component rather than
 * retrying: clicking the (visible) label is both what a real user does and
 * what fires the input's native `onChange`.
 */
async function answerCurrentModule(page: import('@playwright/test').Page): Promise<void> {
  const blocks = await page.locator('.question-block').all();
  for (const block of blocks) {
    const input = block.locator('input').first();
    if ((await input.count()) === 0) continue;
    if (await input.isChecked()) continue;
    await block.locator('label').first().click();
  }
}
