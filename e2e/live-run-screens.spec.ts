/**
 * The live run's check of RM's three counting helpers on the screens that print stage counts (SRS 12.2 step 4;
 * V Task 2 Step 0, R12-16; contract row e2e/helpers/noScore.ts). It builds an organisation of its own holding only
 * the findings below, so no other spec, fixture seat or earlier run can add to a stage count or to the sum (R13-6).
 * The counts are FR-RM-04's own (SRS line 470): they differ per stage, none is zero, and their sum, 71, must appear
 * on no page.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { expect, test } from './helpers/loopbackOnly';
import { addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { testDb } from '../__tests__/helpers/db';
import type { Stage } from '../types/record';
import { expectCountsAsWholeNumbersPerStage, expectStatusMarksInk, expectNoCrossStageTotal } from './helpers/noScore';

const COUNTS: Record<Stage, number> = { 'pre-processing': 37, 'in-processing': 23, 'post-processing': 11 };
const STAGES = Object.keys(COUNTS) as Stage[];
const sentinels: Record<Stage, number[]> = { 'pre-processing': [37], 'in-processing': [23], 'post-processing': [11] };
const SUM = STAGES.reduce((n, s) => n + COUNTS[s], 0);
// The two label-giving items below move two other measures' cross-stage sums off 71: open findings with no mitigation
// (37 + 22 + 11 = 70) and all findings (38 + 23 + 11 = 72). Neither may appear either.
const OTHER_SUMS = [70, 72];
// n as a token of its own: not inside a longer number, a decimal or a word (a run id such as '2ed72d' must not count).
const whole = (n: number) => new RegExp(`(?<![0-9A-Za-z.,-])${n}(?![0-9A-Za-z-]|[.,][0-9])`);
// S-11 prints one status label per question row; the live server runs the fixture bundle (playwright.config.ts).
const bank = JSON.parse(readFileSync('__tests__/fixtures/content/0.0.1-fixture/questionBank.json', 'utf8')) as { stages: Record<Stage, { modules: Array<{ questions: unknown[] }> }> };
const questionsIn = (stage: Stage): number => bank.stages[stage].modules.reduce((n, m) => n + m.questions.length, 0);
async function expectNoOtherSums(page: import('@playwright/test').Page, where: string): Promise<void> {
  const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  for (const n of OTHER_SUMS) expect(text, `${where}: no cross-stage sum ${n}`).not.toMatch(whole(n));
}

let fx: OrgFixture;
let projectId: string;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  // The brief's label 'Live-run screens' puts a space into the seats' emails and the slug (recordFixture.ts:78,83).
  // Text with no digits: the default fixture text is 'Fixture <field> <seq>', and the 71st title printed "71", the sum the
  // cross-stage check refuses, on S-14.
  const letters = (n: number): string => String(n).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]);
  fx = await buildOrg({ label: 'live-run-screens', text: (field, seq) => `Live-run ${field} ${letters(seq)}` });
  // buildOrg names the organisation 'Fixture Org <LABEL> <run id>', and a run id such as '2ed72d' put "72" (or "71") on
  // the pages next to the counts; a name with no digits keeps every count check about the counts.
  await testDb.organization.update({ where: { id: fx.org.id }, data: { name: 'Live-run counting screens' } });
  projectId = (await addProject(fx, { name: 'Stage counts' })).id;
  // One open in-processing finding carries the owner's planned mitigation, due in 2099, so S-08 has a status label to
  // check (FIX-6; as prj-screens.spec.ts does). It is one of the 23, so the open counts stay as set.
  for (const stage of STAGES) {
    const plain = stage === 'in-processing' ? COUNTS[stage] - 1 : COUNTS[stage];
    for (let i = 0; i < plain; i += 1) await addFinding(fx, projectId, { stage, source: 'team' });
  }
  await addMitigationVersion(fx, (await addFinding(fx, projectId, { stage: 'in-processing', source: 'team' })).id, { status: 'planned', owner: 'owner', dueDate: '2099-01-01' });
  // One accepted risk, on a finding that is then closed, gives S-10's "Recorded so far" its accepted-risk line (FIX-6). A
  // closed finding is in no open count. The status label S-10's ink check reads here is the planned mitigation's above
  // (this project has no decisions, so no tally shapes); the tally's shapes are checked on S-10 in prj-screens.spec.ts.
  await addAcceptedRisk(fx, (await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team' })).id, {});
});

test('FR-RM-04 UX-06 UX-07: S-08, S-10, S-11 and S-14 print the stage counts as whole numbers, no cross-stage total and neutral status labels', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.getByLabel('Email').fill(fx.members.owner.email);
  await page.getByLabel('Password').fill(fx.members.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Where a first sign-in lands (the picker, for an account with no lastActiveOrgId) is org-routing.spec.ts's to check.
  await page.waitForURL((u) => u.pathname !== '/login');

  const base = `/orgs/${fx.org.slug}`;
  for (const path of [`${base}/projects/${projectId}`, `${base}/projects/${projectId}/findings`]) {   // S-10, S-14
    await page.goto(path);
    await expectCountsAsWholeNumbersPerStage(page, sentinels);
    await expectNoCrossStageTotal(page, sentinels);
    await expectStatusMarksInk(page);
    await expectNoOtherSums(page, path);
    if (path.endsWith(projectId)) {                                                // S-10's "Still open" reads the open count itself, as a link
      await expect(page.locator('[data-stage="pre-processing"]').getByRole('link', { name: '37 open findings', exact: true })).toBeVisible();
    }
  }

  for (const stage of STAGES) {                                                   // S-11 of each stage
    await page.goto(`${base}/projects/${projectId}/stages/${stage}`);
    // The helpers refuse a sentinel set with an empty stage (e2e/helpers/noScore.ts:149-153), so a one-stage page is checked
    // as e2e/stage-workspace.spec.ts checks S-11, with the count read from its own words ("<n> open findings",
    // components/followup/StageFollowUpCounts.tsx:16): question ids such as Q-IP-23 also carry the digits.
    expect(await page.locator('main [data-question-id] .ui-mark').count(), `S-11 ${stage}: one status mark per question row`).toBe(questionsIn(stage));
    await expectStatusMarksInk(page);
    await expect(page.locator('main').getByRole('link', { name: `${COUNTS[stage]} open findings`, exact: true })).toBeVisible();
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text, `S-11 ${stage}: its count as a whole number`).toMatch(new RegExp(`(?<![0-9.,])${COUNTS[stage]} open findings`));
    expect(text, `S-11 ${stage}: no %`).not.toContain('%');
    await expect(page.locator('main :is(progress, meter, [role=progressbar], [role=meter])'), `S-11 ${stage}: no progress or meter`).toHaveCount(0);
    expect(text, `S-11 ${stage}: no cross-stage sum`).not.toMatch(whole(SUM));
    expect(text, `S-11 ${stage}: no total word`).not.toMatch(/\b(total|overall|in all)\b/i);
  }

  // S-08 last, so a failure here does not hide the others.
  await page.goto(`${base}/dashboard`);                                          // S-08
  await expectNoCrossStageTotal(page, sentinels);
  await expectStatusMarksInk(page);
  await expectNoOtherSums(page, 'S-08');
});
