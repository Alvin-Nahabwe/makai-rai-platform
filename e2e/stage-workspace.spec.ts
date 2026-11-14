import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { failOnDialog } from './helpers/dialogs';
import { expectStatusMarksInk } from './helpers/noScore';
import { actAsSeat, draftKeys, draftValues, fillValid, newProject, openQuestion, stagePath } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { QUESTION_COPY } from '../lib/question/copy';
import { STAGE_LIST_COPY } from '../lib/question/list/copy';

/**
 * S-11, the stage workspace (W-2; FR-DEC-06, FR-CNT-08, NFR-PERF-05, NFR-PRIV-04, UX-26; RM's FR-RM-04, UX-06 and
 * UX-07 helpers). Every project is new. Question ids are fixture ids.
 */
type Stage = 'pre-processing' | 'in-processing' | 'post-processing';
const Q = 'Q-PP-01';

test.beforeEach(async ({ page }) => { failOnDialog(page); });

async function openStage(page: Page, role: OrgRole, stage: Stage, baseURL: string, projectId?: string): Promise<string> {
  const id = projectId ?? await newProject(baseURL);
  await actAsSeat(page, role);
  await page.goto(stagePath(id, stage));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForFunction(() => document.querySelector('[data-question-id]') !== null);
  return id;
}

test('FR-RM-04 UX-06 UX-07 (S-11, R12-16): each stage page prints its own question count as a whole number, no cross-stage total, and neutral status labels', async ({ page, baseURL }) => {
  // the sentinels are the question counts of 0.0.1-fixture's questionBank.json (24, 26 and 28: they differ per stage, and their sum, 78, must appear on no page)
  const bank = JSON.parse(readFileSync('__tests__/fixtures/content/0.0.1-fixture/questionBank.json', 'utf8')) as { stages: Record<Stage, { modules: Array<{ questions: unknown[] }> }> };
  const count = (stage: Stage): number => bank.stages[stage].modules.reduce((n, m) => n + m.questions.length, 0);
  const sentinels = { 'pre-processing': [count('pre-processing')], 'in-processing': [count('in-processing')], 'post-processing': [count('post-processing')] };
  const projectId = await newProject(baseURL!);
  for (const stage of ['pre-processing', 'in-processing', 'post-processing'] as const) {
    await openStage(page, 'assessor', stage, baseURL!, projectId);
    expect(await page.locator('main [data-question-id] .ui-mark').count()).toBe(sentinels[stage][0]);   // one mark per row, so the helper below does not pass over zero marks
    expect(await page.locator('main').innerText()).toMatch(new RegExp(`\\b${sentinels[stage][0]}\\b`));
    await expectStatusMarksInk(page);
    // RM's expectNoCrossStageTotal needs all three stages' sentinels on the page (e2e/helpers/noScore.ts:172-181), which
    // fits S-10 and not a one-stage page; its other two properties are asserted here directly (UX-07).
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    const sum = sentinels['pre-processing'][0] + sentinels['in-processing'][0] + sentinels['post-processing'][0];
    expect(text).not.toMatch(new RegExp(`(^|\\D)${sum}(\\D|$)`));
    expect(text).not.toMatch(/\b(total|overall|in all)\b/i);
  }
});

test('UX-26 FR-DEC-06: a draft is marked on S-11 and listed by Drafts on this device', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', Q, baseURL!);
  await page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`).fill('A draft');
  await page.getByRole('navigation', { name: QUESTION_COPY.nav.label }).getByRole('link', { name: QUESTION_COPY.nav.allQuestions, exact: true }).click();
  await page.waitForURL(`**${stagePath(projectId, 'pre-processing')}`);
  const row = page.locator(`[data-question-id="${Q}"]`);
  await expect(row).toContainText(/not saved yet \(kept in this browser until \d{1,2} [A-Z][a-z]{2} \d{4}\)/);
  await page.getByRole('radio', { name: `${STAGE_LIST_COPY.filters.drafts} 1`, exact: true }).check();
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
  expect(new URL(page.url()).search).toBe('?show=drafts');
  // the address S-17 links to (contract "S-11 address") opens the same filter
  await page.goto(`${stagePath(projectId, 'pre-processing')}?show=drafts`);
  await expect(page.locator('[data-question-id]')).toHaveCount(1);
});

test('FR-DEC-06 NFR-REL-05: Retry all re-sends each pressed draft with its own request id and shows each result', async ({ page, baseURL }) => {
  const projectId = await openQuestion(page, 'assessor', 'Q-PP-01', baseURL!);
  await page.route('**/decisions', (r) => r.abort('failed'));   // every send fails until the Retry all below, so both drafts stay pressed
  await fillValid(page, { reason: 'First' });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('alert')).toContainText('Not saved');
  await openQuestion(page, 'assessor', 'Q-PP-02', baseURL!, projectId);
  await fillValid(page, { reason: 'Second' });
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.locator('[data-region="answer-form"] .save-status').getByRole('alert')).toContainText('Not saved');
  const stored = (await draftValues(page)).map((t) => (JSON.parse(t) as { retry: { requestId: string } }).retry.requestId).sort();
  expect(stored).toHaveLength(2);
  await page.unroute('**/decisions');
  const sent: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/decisions')) sent.push((r.postDataJSON() as { requestId: string }).requestId); });
  await openStage(page, 'assessor', 'pre-processing', baseURL!, projectId);
  await expect(page.getByText(STAGE_LIST_COPY.unsent(2))).toBeVisible();
  await page.getByRole('button', { name: STAGE_LIST_COPY.saveAll(2) }).click();
  await expect(page.locator('[data-question-id="Q-PP-01"]')).toContainText(/Saved at .+ as version 1\./);
  await expect(page.locator('[data-question-id="Q-PP-02"]')).toContainText(/Saved at .+ as version 1\./);
  expect(sent.sort()).toEqual(stored);
  expect(await draftKeys(page)).toHaveLength(0);
});

test('NFR-PERF-05: no request repeats more than once a minute in a 5-minute idle capture of S-11', async ({ page, baseURL }) => {
  await page.clock.install();
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await openStage(page, 'viewer', 'pre-processing', baseURL!);
  urls.length = 0;
  await page.clock.fastForward('05:00');
  const counts = new Map<string, number>();
  for (const u of urls) counts.set(u, (counts.get(u) ?? 0) + 1);
  expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(5);   // at most once a minute over five minutes
});
