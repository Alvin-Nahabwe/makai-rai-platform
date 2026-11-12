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

test('FR-RM-04 UX-07 (helper): text the test wrote itself is left out of the count checks, and a total anywhere else still fails', async ({ page }) => {
  // A fixture organisation's name carries a random run id (__tests__/helpers/recordFixture.ts, `runId`), and S-10 prints
  // the name in its breadcrumb. This id holds the sum, 71.
  const NAME = 'Fixture Org PRJSENT mwdfwl71-ffa0ab';
  const SLUG = 'fixture-org-prjsent-mwdfwl71-ffa0ab';
  const own = [NAME, SLUG];
  const stages = THREE_STAGES('37 open findings', '23 open findings', '11 open findings');
  const withCrumb = (html: string, name = NAME) => html.replace('<main>', `<main><nav aria-label="Breadcrumb"><a href="/orgs/${SLUG}/dashboard">${name}</a> &gt; <span>Counts</span></nav>`);

  for (const check of [expectCountsAsWholeNumbersPerStage, expectNoCrossStageTotal]) {
    // Not told whose text it is, the check reads the id's digits as a total: the false finding.
    await page.setContent(withCrumb(stages));
    await expect(check(page, SENTINELS), check.name).rejects.toThrow(/the sum 71 of three stages' counts appears: ".*mwdfwl71-ffa0ab/);
    // Told, it passes, however the page spaces the name and whatever punctuation follows it.
    await check(page, SENTINELS, { ownText: own });
    await page.setContent(withCrumb(stages, 'Fixture Org\n   PRJSENT  mwdfwl71-ffa0ab'));
    await check(page, SENTINELS, { ownText: own });
    await page.setContent(withCrumb(stages, `Welcome to ${NAME}. Its address is /orgs/${SLUG}/dashboard.`));
    await check(page, SENTINELS, { ownText: own });

    const twoStages = THREE_STAGES('37 open findings', 'None open.', '11 open findings');
    const NAME_23 = 'Fixture Org PRJSENT mwdfwl23-ffa0ab';
    const ENDS_71 = 'Fixture Org PRJSENT mwdfwl-ffa0ab 71';
    const bad: Array<[html: string, finding: RegExp, ownText?: string[]]> = [
      // A total anywhere else on the page, with the name on it as well.
      [withCrumb(stages).replace('</main>', '<p>71 open findings</p></main>'), /the sum 71 .*"[^"]*71 open findings/],
      // A total printed against the name, before it or after it, in the same element.
      [withCrumb(stages, `71 ${NAME}`), /the sum 71/],
      [withCrumb(stages, `${NAME} 71`), /the sum 71/],
      [withCrumb(stages, `${NAME}: 71 open findings`), /the sum 71/],
      // Text that only starts or ends like the test's own is the page's: another run id, a letter or a digit run on.
      [withCrumb(stages, 'Fixture Org PRJSENT mwdfwl71-ffa0ac'), /the sum 71/],
      [withCrumb(stages, `${NAME}c`), /the sum 71/],
      [withCrumb(stages, `x${NAME}`), /the sum 71/],
      [withCrumb(stages, `${NAME}1`), /the sum 71/],
      // A count that is on the page only inside the test's own text is not on the page.
      [withCrumb(twoStages, NAME_23), /sentinel 23 \(in-processing\) does not appear/, [NAME_23]],
      // Own text that ends in digits does not take the front off a longer number and leave a count behind: 7123 is not 23.
      [withCrumb(twoStages, `${ENDS_71}23`), /sentinel 23 \(in-processing\) does not appear/, [ENDS_71]],
    ];
    for (const [i, [html, finding, ownText = own]] of bad.entries()) {
      await page.setContent(html);
      await expect(check(page, SENTINELS, { ownText }), `${check.name} bad ${i}: ${html}`).rejects.toThrow(finding);
    }

    // Own text is a name or an address, never a number: a caller cannot hand the check the total to look away from.
    await page.setContent(stages.replace('</main>', '<p>71</p></main>'));
    for (const ownText of [['71'], [''], ['  '], ['71 - 2026'], [NAME, '71']]) {
      await expect(check(page, SENTINELS, { ownText }), `${check.name} own text ${JSON.stringify(ownText)}`).rejects.toThrow(/own text/);
    }
  }
});

test('UX-06 NFR-A11Y-05 (helper): status labels are words in a neutral colour, and the warning tint sits only on the three warning labels', async ({ page }) => {
  const labels = (inner: string) => `${TOKENS}<main>${inner}</main>`;

  await page.setContent(
    labels(
      '<span class="status-label body">Done</span><span class="status-label muted">No decision</span>' +
        '<span class="status-label status-label--warning">Overdue</span>' +
        '<span class="status-label status-label--warning">Owner cannot act</span>' +
        '<span class="status-label status-label--warning">Legal name not recorded</span>' +
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

test('FR-RM-01: the no-score check still reads a legal page\'s text', async ({ page }) => {
  // data-legal-text exempts claim words only (owner ruling R1); the no-score check skips data-claims-allowed and nothing else.
  await page.setContent('<main><p>Version 2.</p><div data-legal-text><p>Score: 85%</p></div></main>');
  // Both paths: the score-word check and the percentage check read inside the block.
  await expect(expectNoScoreShapes(page, 'legal page')).rejects.toThrow(/score word "Score:"/);
  await expect(expectNoScoreShapes(page, 'legal page')).rejects.toThrow(/percentage "85%"/);
});
