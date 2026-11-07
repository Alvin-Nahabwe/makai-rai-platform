/**
 * The live run's check of RM's three counting helpers on the screens that print stage counts (SRS 12.2 step 4;
 * V Task 2 Step 0, R12-16; contract row e2e/helpers/noScore.ts). It builds an organisation of its own holding only
 * the findings below, so no other spec, fixture seat or earlier run can add to a stage count or to the sum (R13-6).
 * The counts are FR-RM-04's own (SRS line 470): they differ per stage, none is zero, and their sum, 71, must appear
 * on no page.
 */
import 'dotenv/config';
import { expect, test } from './helpers/loopbackOnly';
import { addAcceptedRisk, addFinding, addMitigationVersion, addProject, buildOrg, type OrgFixture } from '../__tests__/helpers/recordFixture';
import type { Stage } from '../types/record';
import { expectCountsAsWholeNumbersPerStage, expectNeutralStatusLabels, expectNoCrossStageTotal } from './helpers/noScore';

const COUNTS: Record<Stage, number> = { 'pre-processing': 37, 'in-processing': 23, 'post-processing': 11 };
const STAGES = Object.keys(COUNTS) as Stage[];
const sentinels = Object.fromEntries(STAGES.map((s) => [s, [COUNTS[s]]])) as Record<Stage, number[]>;
const SUM = STAGES.reduce((n, s) => n + COUNTS[s], 0);

let fx: OrgFixture;
let projectId: string;

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  // The brief's label 'Live-run screens' puts a space into the seats' emails and the slug (recordFixture.ts:78,83).
  // Text with no digits: the default fixture text is 'Fixture <field> <seq>', and the 71st title printed "71", the sum the
  // cross-stage check refuses, on S-14.
  const letters = (n: number): string => n.toString(26).split('').map((d) => String.fromCharCode(97 + parseInt(d, 26))).join('');
  fx = await buildOrg({ label: 'live-run-screens', text: (field, seq) => `Live-run ${field} ${letters(seq)}` });
  projectId = (await addProject(fx, { name: 'Stage counts' })).id;
  // One open in-processing finding carries the owner's planned mitigation, due in 2099, so S-08 has a status label to
  // check (FIX-6; as prj-screens.spec.ts does). It is one of the 23, so the open counts stay as set.
  for (const stage of STAGES) {
    const plain = stage === 'in-processing' ? COUNTS[stage] - 1 : COUNTS[stage];
    for (let i = 0; i < plain; i += 1) await addFinding(fx, projectId, { stage, source: 'team' });
  }
  await addMitigationVersion(fx, (await addFinding(fx, projectId, { stage: 'in-processing', source: 'team' })).id, { status: 'planned', owner: 'owner', dueDate: '2099-01-01' });
  // One accepted risk, on a finding that is then closed, gives S-10 something recorded, so it has status labels to check
  // (FIX-6). A closed finding is in no open count.
  await addAcceptedRisk(fx, (await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team' })).id, {});
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
    // The helpers refuse a sentinel set with an empty stage (e2e/helpers/noScore.ts:146), so a one-stage page is checked
    // as e2e/stage-workspace.spec.ts checks S-11: its own count as a whole number, no cross-stage sum, no total word.
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text, `S-11 ${stage}: its own count`).toMatch(new RegExp(`(^|\\D)${COUNTS[stage]}(\\D|$)`));
    expect(text, `S-11 ${stage}: no cross-stage sum`).not.toMatch(new RegExp(`(^|\\D)${SUM}(\\D|$)`));
    expect(text, `S-11 ${stage}: no total word`).not.toMatch(/\b(total|overall|in all)\b/i);
  }

  // S-08 last, so a failure here (FIX-6: no status label on S-08 for open team findings) does not hide the others.
  await page.goto(`${base}/dashboard`);                                          // S-08
  await expectNoCrossStageTotal(page, sentinels);
  await expectNeutralStatusLabels(page);
});
