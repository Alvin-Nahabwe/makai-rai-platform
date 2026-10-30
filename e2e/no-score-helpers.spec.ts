import { test, expect } from '@playwright/test';
import {
  SCORE_WORDS,
  expectNoScoreShapes,
  expectCountsAsWholeNumbersPerStage,
  expectNeutralStatusLabels,
  expectNoCrossStageTotal,
} from './helpers/noScore';

/**
 * Self-test of the shared no-score checks (e2e/helpers/noScore.ts). Every case
 * runs on `page.setContent`, so it needs no fixture, no login and no route:
 * each helper is shown to reject a snippet that has the shape it polices, and
 * to accept one that does not. A failing snippet names the finding the helper
 * must give, so a helper that rejects for the wrong reason (for example, no
 * <main>) does not pass as a detector of the shape.
 */

// 37 + 23 + 11 = 71, which therefore must appear nowhere on a page.
const SENTINELS = { 'pre-processing': [37], 'in-processing': [23], 'post-processing': [11] };

// Tokens a snippet needs for the colour checks; a real page has them in app/globals.css.
const TOKENS =
  '<style>:root{--text-body:rgb(31, 41, 55);--text-muted:rgb(107, 114, 128)}' +
  '.body{color:var(--text-body)}.muted{color:var(--text-muted)}.green{color:rgb(22, 163, 74)}</style>';

const THREE_STAGES = (a: string, b: string, c: string) =>
  `<main><section><h2>Pre-processing</h2><p>${a}</p></section>` +
  `<section><h2>In-processing</h2><p>${b}</p></section>` +
  `<section><h2>Post-processing</h2><p>${c}</p></section></main>`;

test('FR-RM-01 (helper): score words, progress bars, meters and drawn charts fail; allowed sentences and decorative icons pass', async ({ page }) => {
  // SRS line 451's regex, with its `score:` alternative outside the word-boundary group so that
  // 'Score: 3' matches (owner default B39).
  for (const s of ['Maturity: 3', 'Level 2 band', 'Overall score: 80', 'Assessment scores', 'Readiness score 80', 'Score: 3', 'score:3', 'Score : 3']) {
    expect(SCORE_WORDS.test(s), s).toBe(true);
  }
  // Not a score shape: the educational sentences the About page allows name a "confidence score" without a colon.
  for (const s of ['a model’s confidence score', 'an overall accuracy score of the model', 'scoreboard']) {
    expect(SCORE_WORDS.test(s), s).toBe(false);
  }

  const bad: Array<[string, RegExp]> = [
    ['<main>Maturity: 3</main>', /score word "Maturity"/],
    ['<main>Score: 80</main>', /score word "Score:"/],
    ['<main><progress value="3" max="5"></progress></main>', /<progress>/],
    ['<main><meter value="3" min="0" max="5"></meter></main>', /<meter>/],
    ['<main><div role="progressbar"></div></main>', /role=progressbar/],
    ['<main><div role="meter" aria-valuenow="3"></div></main>', /role=meter/],
    ['<main><canvas width="40" height="40"></canvas></main>', /<canvas>/],
    ['<main><svg><circle r="4"/></svg></main>', /<svg>/],
    ['<main><svg role="img" aria-label="trend"><path d="M0 0"/></svg></main>', /<svg>/],
    ['<main>Level 2 band</main>', /score word/],
    ['<main>12 questions (40%)</main>', /percentage "40%"/],
    ['<main>12 questions (40<span>%</span>)</main>', /percentage/],
    // An allowed element exempts only its own text.
    ['<main><p data-claims-allowed="about-model-scores">Maturity</p><p>Maturity</p></main>', /score word "Maturity"/],
    // Text that is in the page but not shown is still on the page.
    ['<main><p hidden>Maturity: 3</p></main>', /score word/],
    ['<body><p>nothing here is inside a main</p></body>', /no <main>/],
  ];
  for (const [i, [html, finding]] of bad.entries()) {
    await page.setContent(html);
    await expect(expectNoScoreShapes(page, `bad ${i}`), html).rejects.toThrow(finding);
  }

  await page.setContent(
    '<main><p data-claims-allowed="about-model-scores">an overall accuracy score of 60%</p>' +
      '<svg aria-hidden="true"></svg><svg aria-hidden="true"><svg><path d="M0 0"/></svg></svg>' +
      '<p>Uploading a.pdf: 0.8 of 2.4 MB</p><p>12 questions with no decision</p></main>',
  );
  await expectNoScoreShapes(page, 'clean');
});

test('FR-RM-04 (helper): counts must be whole numbers in text, per stage, with no percentage and no total', async ({ page }) => {
  await page.setContent(THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision'));
  await expectCountsAsWholeNumbersPerStage(page, SENTINELS);

  const bad: Array<[string, RegExp]> = [
    // The sum of the three, anywhere.
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<p>71 in the project</p></main>'), /71/],
    // A sentinel missing, or present only inside a longer number.
    [THREE_STAGES('37 questions with no decision', '24 questions with no decision', '11 questions with no decision'), /23/],
    [THREE_STAGES('37 questions with no decision', '123 questions with no decision', '11 questions with no decision'), /23/],
    [THREE_STAGES('37 questions with no decision', '23.5 questions with no decision', '11 questions with no decision'), /23/],
    // A percentage, a progress element, a total label.
    [THREE_STAGES('37 questions (52%)', '23 questions with no decision', '11 questions with no decision'), /%/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<progress value="3" max="5"></progress></main>'), /<progress>/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<div role="meter" aria-valuenow="3"></div></main>'), /role=meter/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<p>Total</p></main>'), /total/i],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<p>Overall</p></main>'), /overall/i],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 in all').replace('</main>', '<p>31 questions</p></main>'), /in all/i],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('<main>', '<main aria-label="Total">'), /total/i],
  ];
  for (const [i, [html, finding]] of bad.entries()) {
    await page.setContent(html);
    await expect(expectCountsAsWholeNumbersPerStage(page, SENTINELS), `bad ${i}: ${html}`).rejects.toThrow(finding);
  }

  // A sum that is only part of a longer number is not the sum on the page.
  await page.setContent(THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<p>171 files</p></main>'));
  await expectCountsAsWholeNumbersPerStage(page, SENTINELS);

  // A sentinel set that cannot tell the stages apart is refused before the page is read.
  await page.setContent(THREE_STAGES('37', '23', '11'));
  await expect(expectCountsAsWholeNumbersPerStage(page, { ...SENTINELS, 'post-processing': [0] })).rejects.toThrow(/sentinel/);
  await expect(expectCountsAsWholeNumbersPerStage(page, { ...SENTINELS, 'post-processing': [37] })).rejects.toThrow(/sentinel/);
});

test('UX-06 NFR-A11Y-05 (helper): status labels are words in a neutral colour, and the warning tint sits only on the three warning labels', async ({ page }) => {
  const labels = (inner: string) => `${TOKENS}<main>${inner}</main>`;

  await page.setContent(
    labels(
      '<span class="status-label body">Done</span><span class="status-label muted">No decision</span>' +
        '<span class="status-label status-label--warning">Overdue</span>' +
        '<span class="status-label status-label--warning">Owner cannot act</span>' +
        '<span class="status-label status-label--warning">No agreement recorded</span>' +
        '<span class="status-label status-label--warning">Overdue: 3</span>' +
        '<div class="body"><span class="status-label">Open</span></div>',
    ),
  );
  await expectNeutralStatusLabels(page);

  const bad: Array<[string, RegExp]> = [
    [labels('<span class="status-label green">Done</span>'), /Done.*colour/],
    [labels('<span class="status-label body">Done</span><span class="status-label">Open</span>'), /colour/],
    [labels('<span class="status-label body status-label--warning">Done</span>'), /warning tint.*Done/],
    [labels('<span class="status-label body">Overdue</span><span class="status-label--warning">Done</span>'), /warning tint.*Done/],
    [labels('<span class="status-label body"></span>'), /no words/],
    [labels('<span class="status-label body">3</span>'), /no words/],
    [labels('<p class="body">no label on this page</p>'), /no \.status-label/],
    ['<main><span class="status-label">Done</span></main>', /--text-body/],
    ['<p><span class="status-label">Done</span></p>', /no <main>/],
  ];
  for (const [i, [html, finding]] of bad.entries()) {
    await page.setContent(html);
    await expect(expectNeutralStatusLabels(page), `bad ${i}: ${html}`).rejects.toThrow(finding);
  }
});

test('UX-07 (helper): a findings list grouped by stage with a count per group and no sum passes; a sum or a total fails', async ({ page }) => {
  const group = (a: string, b: string, c: string) => THREE_STAGES(`${a} findings`, `${b} findings`, `${c} findings`);

  await page.setContent(group('37', '23', '11'));
  await expectNoCrossStageTotal(page, SENTINELS);

  const bad: Array<[string, RegExp]> = [
    [group('37', '23', '11').replace('</main>', '<p>71 findings</p></main>'), /71/],
    [group('37', '23', '11').replace('</main>', '<p>Total: 71</p></main>'), /71|total/i],
    [group('37', '23', '11').replace('</main>', '<h2>Total</h2></main>'), /total/i],
    // A page that shows none of the counts proves nothing about their sum.
    ['<main><p>No findings recorded</p></main>', /37/],
  ];
  for (const [i, [html, finding]] of bad.entries()) {
    await page.setContent(html);
    await expect(expectNoCrossStageTotal(page, SENTINELS), `bad ${i}: ${html}`).rejects.toThrow(finding);
  }
});
