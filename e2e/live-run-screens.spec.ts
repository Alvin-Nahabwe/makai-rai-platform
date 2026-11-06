/**
 * The live run's check of RM's three counting helpers on the screens that print stage counts (SRS 12.2 step 4;
 * V Task 2 Step 0, R12-16; contract row e2e/helpers/noScore.ts). It builds an organisation of its own holding only
 * the findings below, so no other spec, fixture seat or earlier run can add to a stage count or to the sum (R13-6).
 * The counts are FR-RM-04's own (SRS line 470): they differ per stage, none is zero, and their sum, 71, must appear
 * on no page.
 */
import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { addFinding, addProject, buildOrg, type OrgFixture } from '../__tests__/helpers/recordFixture';
import type { Stage } from '../types/record';
import { expectCountsAsWholeNumbersPerStage, expectNeutralStatusLabels, expectNoCrossStageTotal } from './helpers/noScore';

const COUNTS: Record<Stage, number> = { 'pre-processing': 37, 'in-processing': 23, 'post-processing': 11 };
const STAGES = Object.keys(COUNTS) as Stage[];
const sentinels = Object.fromEntries(STAGES.map((s) => [s, [COUNTS[s]]])) as Record<Stage, number[]>;
const onlyStage = (stage: Stage) => Object.fromEntries(STAGES.map((s) => [s, s === stage ? [COUNTS[s]] : []])) as Record<Stage, number[]>;

let fx: OrgFixture;
let projectId: string;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  // The brief's label 'Live-run screens' puts a space into the seats' emails and the slug (recordFixture.ts:78,83).
  fx = await buildOrg({ label: 'live-run-screens' });
  projectId = (await addProject(fx, { name: 'Stage counts' })).id;
  for (const stage of STAGES) {
    for (let i = 0; i < COUNTS[stage]; i += 1) await addFinding(fx, projectId, { stage, source: 'team' });
  }
});

test('FR-RM-04 UX-06 UX-07: S-08, S-10, S-11 and S-14 print the stage counts as whole numbers, no cross-stage total and neutral status labels', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.getByLabel('Email').fill(fx.members.owner.email);
  await page.getByLabel('Password').fill(fx.members.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((u) => u.pathname !== '/login');
  // A fixture owner holds seats in more than one organisation, so the sign-in lands on the picker first, not on S-08.
  await expect(page.getByRole('heading', { level: 1, name: 'Choose an organization' })).toBeVisible();

  const base = `/orgs/${fx.org.slug}`;
  for (const path of [`${base}/projects/${projectId}`, `${base}/projects/${projectId}/findings`]) {   // S-10, S-14
    await page.goto(path);
    await expectCountsAsWholeNumbersPerStage(page, sentinels);
    await expectNoCrossStageTotal(page, sentinels);
    await expectNeutralStatusLabels(page);
  }

  for (const stage of STAGES) {                                                   // S-11 of each stage
    await page.goto(`${base}/projects/${projectId}/stages/${stage}`);
    await expectNeutralStatusLabels(page);
    await expectNoCrossStageTotal(page, sentinels);
    await expectCountsAsWholeNumbersPerStage(page, onlyStage(stage));
  }

  // S-08 last, so a failure here (FIX-6: no status label on S-08 for open team findings) does not hide the others.
  await page.goto(`${base}/dashboard`);                                          // S-08
  await expectNoCrossStageTotal(page, sentinels);
  await expectNeutralStatusLabels(page);
});
