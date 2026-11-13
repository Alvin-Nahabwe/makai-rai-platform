import { test, expect } from '@playwright/test';
import {
  SCORE_WORDS,
  expectNoScoreShapes,
  expectCountsAsWholeNumbersPerStage,
  expectStatusMarksInk,
  expectNoCrossStageTotal,
  isGreenColour,
  tickShapeOf,
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

// Tokens and classes a snippet needs for the colour checks; a real page has them in the kit's stylesheets. Shapes take
// their fill and stroke from the mark's colour, as the kit's do; an attribute on a shape's own graphic wins.
const TOKENS =
  '<style>:root{--color-mark:rgb(26, 31, 54);--color-ink:rgb(27, 27, 31);--color-ink-muted:rgb(74, 80, 96);--color-saved:rgb(31, 122, 77)}' +
  '.ui-mark,[data-mark-kind]{color:var(--color-mark)}.ui-mark__words{color:var(--color-ink)}' +
  '.ui-route-row__point{color:inherit}svg{fill:currentColor;stroke:currentColor}.ui-saved__shape{color:var(--color-saved)}' +
  '.ink{color:var(--color-ink)}.muted{color:var(--color-ink-muted)}.green{color:rgb(22, 163, 74)}.red{color:rgb(180, 35, 24)}</style>';

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
    ['<main>12 questions (45 %)</main>', /percentage "45 %"/],
    ['<main><div class="ui-route-row"><div style="width: 40%"></div></div></main>', /proportional fill/],
    ['<main><div class="ui-route-row"><div style="inline-size: 40%"></div></div></main>', /proportional fill/],
    ['<main><span data-upload-progress><meter value="1" max="3"></meter></span></main>', /<meter>/],
    ['<main><div class="ui-route-row"><span data-upload-progress><progress value="1" max="3"></progress></span></div></main>', /<progress>/],
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

  // A progress element is allowed inside an upload's own element and nowhere else; a width in per cent is a fill only
  // in a route row, and a width in pixels never is.
  await page.setContent(
    '<main><span data-upload-progress><progress value="1" max="3"></progress></span>' +
      '<div style="width: 40%"></div><div class="ui-route-row"><div style="width: 24px"></div></div></main>',
  );
  await expectNoScoreShapes(page, 'upload progress');
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
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<p>12 questions in all</p></main>'), /in all/i],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<div class="ui-route-row"><div style="width: 40%"></div></div></main>'), /proportional fill/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<div class="ui-route-row"><div style="inline-size: 40%"></div></div></main>'), /proportional fill/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<span data-upload-progress><meter value="1" max="3"></meter></span></main>'), /<meter>/],
    [THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>', '<div class="ui-route-row"><span data-upload-progress><progress value="1" max="3"></progress></span></div></main>'), /<progress>/],
  ];
  for (const [i, [html, finding]] of bad.entries()) {
    await page.setContent(html);
    await expect(expectCountsAsWholeNumbersPerStage(page, SENTINELS), `bad ${i}: ${html}`).rejects.toThrow(finding);
  }

  // An upload's own progress element is allowed; a per cent width outside a route row and a pixel width inside one are not fills.
  await page.setContent(THREE_STAGES('37 questions with no decision', '23 questions with no decision', '11 questions with no decision').replace('</main>',
    '<span data-upload-progress><progress value="1" max="3"></progress></span><div style="width: 40%"></div><div class="ui-route-row"><div style="width: 24px"></div></div></main>'));
  await expectCountsAsWholeNumbersPerStage(page, SENTINELS);

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

// What the kit draws, written out as the kit writes it (components/ui StatusMark, RouteRow, SavedMark).
const page_ = (inner: string) => `${TOKENS}<main>${inner}</main>`;
const shape = (inner: string, extra = '') => `<svg class="ui-mark__shape" aria-hidden="true" viewBox="0 0 24 24"${extra}>${inner}</svg>`;
const DISC = '<circle cx="12" cy="12" r="8"/>';
const HALF = '<path d="M12 4a8 8 0 0 1 0 16z"/>';
const RING_SLASH = '<circle cx="12" cy="12" r="8" fill="none"/><line x1="6" y1="18" x2="18" y2="6"/>';
const mark = (inner = DISC, words = 'Done', attrs = '') =>
  `<span class="ui-mark ui-mark--done" data-mark-kind="done"${attrs}>${shape(inner)}<span class="ui-mark__words">${words}</span></span>`;
const stop = (kind: string, inner: string, word: string, point = '<span class="ui-route-row__point">', liStyle = '') =>
  `<li class="ui-route-row__stop" data-mark-kind="${kind}"${liStyle}>${point}${shape(inner)}<span class="visually-hidden">${word}</span>${point.startsWith('<a') ? '</a>' : '</span>'}</li>`;
const routeRow = (liStyle = '') =>
  '<div class="ui-route-row"><ol class="ui-route-row__stops">' +
  stop('done', DISC, 'Done', undefined, liStyle) +
  stop('partly', HALF, 'Partly') +
  stop('not-applicable', RING_SLASH, 'Not applicable') +
  stop('not-yet', DISC, 'Not yet', '<a class="ui-route-row__point" href="#" style="border: 2px solid rgb(154, 77, 16)">') +
  '</ol><p class="ui-route-row__tally">9 done, 6 partly</p></div>';
const SAVED_SVG = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m16 9-5.5 5.5L8 12"/></svg>';
const SAVED = `<div class="ui-saved"><span class="ui-saved__shape">${SAVED_SVG}</span><span>Saved</span></div>`;
const GREEN = 'rgb(22, 163, 74)';

test('spec 7.2 NFR-A11Y-05 (helper): a status mark is a shape and words in ink, with no tick and no green', async ({ page }) => {
  // The kit's own markup passes, with a saved mark beside the row (its tick and its green are outside any mark).
  for (const [name, html] of [
    ['a mark', page_(mark())],
    ['a route row', page_(routeRow())],
    ['a route row and a saved mark', page_(routeRow() + SAVED)],
    ['legacy labels', page_(
      '<span class="status-label ink">Done</span><span class="status-label muted">No decision</span>' +
        '<span class="status-label status-label--warning ink" style="background-color: rgb(230, 233, 240)">Overdue</span>')],
  ] as const) {
    await page.setContent(html);
    await expectStatusMarksInk(page);
    if (name !== 'legacy labels') await expectNoScoreShapes(page, name);
  }

  const bad: Array<[string, string, RegExp]> = [
    // K1: the mark's colour.
    ['K1 mark in ink', page_(mark(DISC, 'Done', ' style="color: rgb(27, 27, 31)"')), /is not --color-mark/],
    ['K1 route stop in another colour', page_(routeRow(' style="color: rgb(180, 35, 24)"')), /is not --color-mark/],
    // K2: fill and stroke.
    ['K2 fill', page_(mark('<circle cx="12" cy="12" r="8" fill="rgb(180, 35, 24)"/>')), /fill rgb\(180, 35, 24\) is not --color-mark/],
    ['K2 stroke', page_(mark('<circle cx="12" cy="12" r="8" stroke="rgb(180, 35, 24)"/>')), /stroke rgb\(180, 35, 24\) is not --color-mark/],
    // K3: no tick.
    ['K3 path', page_(mark('<path d="M8 12.5l2.7 2.7L16 9.8"/>')), /tick/],
    ['K3 polyline', page_(mark('<polyline points="8,12.5 10.7,15.2 16,9.8"/>')), /tick/],
    ['K3 character', page_(mark(DISC, '✓ Done')), /tick/],
    ['K3 unreadable path', page_(mark('<path d="M2 2c1 1 2 2 3 3m2 2 2 2 4-4"/>')), /cannot read path/],
    // K4: no green.
    ['K4 colour', page_(mark(DISC, 'Done', ` style="color: ${GREEN}"`)), /green/],
    ['K4 saved colour', page_(mark(DISC, 'Done', ' style="color: rgb(31, 122, 77)"')), /green/],
    ['K4 fill', page_(mark(`<circle cx="12" cy="12" r="8" fill="${GREEN}"/>`)), /green/],
    ['K4 background', page_(mark(DISC, 'Done', ` style="background-color: ${GREEN}"`)), /green/],
    ['K4 border', page_(mark(DISC, 'Done', ` style="border: 2px solid ${GREEN}"`)), /green/],
    ['K4 words', page_(mark(DISC, `<span style="color: ${GREEN}">Done</span>`).replace('class="ui-mark__words"', `class="ui-mark__words" style="color: ${GREEN}"`)), /green/],
    ['K4 child of a kind element with no shape', page_(`<span data-mark-kind="done">Done<span style="color: ${GREEN}">x</span></span>`), /green/],
    ['K4 colour in a form it cannot read', page_(mark(DISC, 'Done', ' style="background-color: oklch(0.6 0.1 150)"')), /cannot read colour/],
    // K5: words in ink.
    ['K5 words in muted ink', page_(mark().replace('class="ui-mark__words"', 'class="ui-mark__words" style="color: rgb(74, 80, 96)"')), /is not --color-ink/],
    // K6: words exist.
    ['K6 mark with no words', page_(`<span class="ui-mark" data-mark-kind="done">${shape(DISC)}</span>`), /no words/],
    ['K6 bare shape, parent without words', page_(`<p>${shape(DISC)}</p>`), /no words/],
    // Legacy labels.
    ['L1 no words', page_('<span class="status-label ink">3</span>'), /no words/],
    ['L2 green', page_('<span class="status-label green">Done</span>'), /green/],
    ['L2 colour', page_('<span class="status-label red">Done</span>'), /neither --color-ink/],
    ['L2 warning has no exemption', page_('<span class="status-label status-label--warning red">Overdue</span>'), /neither --color-ink/],
    ['L3 green background', page_('<span class="status-label ink" style="background-color: rgb(22, 163, 74)">Done</span>'), /green/],
    ['L4 tick', page_('<span class="status-label ink">✔ Done</span>'), /tick/],
    ['L4 tick path', page_('<span class="status-label ink"><svg><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>Done</span>'), /tick/],
    // The page and the tokens.
    ['nothing to read', page_('<p class="ink">no status on this page</p>'), /no status mark/],
    ['no main', '<p><span class="status-label">Done</span></p>', /no <main>/],
    ['--color-mark undefined', '<main><span class="status-label">Done</span></main>', /--color-mark is not defined/],
    ['--color-saved undefined', page_('<span class="status-label ink">Done</span>').replace('--color-saved:', '--other:'), /--color-saved is not defined/],
  ];
  for (const [name, html, finding] of bad) {
    await page.setContent(html);
    await expect(expectStatusMarksInk(page), name).rejects.toThrow(finding);
  }

  // Moving the saved mark's tick inside a mark makes it a tick on a status.
  await page.setContent(page_(`<span class="ui-mark" data-mark-kind="done">${SAVED_SVG}<span class="ui-mark__words">Saved</span></span>`));
  await expect(expectStatusMarksInk(page)).rejects.toThrow(/tick/);
});

test('spec 7.2 (helper): isGreenColour and tickShapeOf judge the vectors the spec lists', () => {
  const SAVED_RGB = 'rgb(31, 122, 77)';
  for (const c of ['rgb(31, 122, 77)', 'rgb(111, 207, 151)', 'rgb(22, 163, 74)', 'rgb(154, 205, 50)', 'rgba(22, 163, 74, 0.5)']) {
    expect(isGreenColour(c, SAVED_RGB), c).toBe(true);
  }
  expect(isGreenColour('rgb(1, 2, 3)', 'rgb(1, 2, 3)'), 'equal to saved').toBe(true);
  for (const c of ['rgb(26, 31, 54)', 'rgb(199, 204, 224)', 'rgb(27, 27, 31)', 'rgb(180, 35, 24)', 'rgb(154, 77, 16)', 'rgb(0, 128, 128)',
    'rgb(200, 220, 50)', 'rgb(100, 110, 100)', 'rgb(230, 233, 240)', 'rgb(0, 0, 0)', 'rgba(22, 163, 74, 0)', 'none', 'transparent']) {
    expect(isGreenColour(c, SAVED_RGB), c).toBe(false);
  }
  expect(() => isGreenColour('oklch(0.6 0.1 150)', SAVED_RGB)).toThrow(/cannot read colour/);
  expect(() => isGreenColour('color(srgb 0.1 0.6 0.3)', SAVED_RGB)).toThrow(/cannot read colour/);

  for (const d of ['M8 12.5l2.7 2.7L16 9.8', 'M20 6 9 17l-5-5', 'm9 12 2 2 4-4', 'm16 9-5.5 5.5L8 12', 'M18 6 7 17l-5-5M22 10l-7.5 7.5L13 16']) {
    expect(tickShapeOf(d), d).toBe('tick');
  }
  for (const d of ['M12 4a8 8 0 0 1 0 16z', 'M6 18L18 6', 'M18 6 6 18M6 6l12 12', 'M4 4h16v16h-16z', 'M4 12h16', 'm6 15 6-6 6 6', '']) {
    expect(tickShapeOf(d), d).toBe('clear');
  }
  expect(tickShapeOf('M2 2c1 1 2 2 3 3m2 2 2 2 4-4')).toBe('unreadable');
});

test('spec 7.2 (helper): the kit as built on /dev/ui-kit passes both checks in light and dark, and a planted green fails', async ({ page }) => {
  const response = await page.goto('/dev/ui-kit');
  expect(response?.status(), '/dev/ui-kit status').toBe(200);
  await page.waitForLoadState('networkidle');
  const settle = () => page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition)));
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle();
    expect(await page.locator('main .ui-mark').count(), `${scheme}: marks on the kit`).toBeGreaterThan(0);
    expect(await page.locator('main .ui-route-row .ui-mark__shape').count(), `${scheme}: route row shapes`).toBeGreaterThan(0);
    await expectStatusMarksInk(page);
    await expectNoScoreShapes(page, `/dev/ui-kit ${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await settle();
  // Hydration can undo a change made too early, so the plant and the assertion are retried together.
  await expect(async () => {
    await page.evaluate(() => {
      (document.querySelector('main .ui-route-row__stop') as HTMLElement).style.color = 'rgb(31, 122, 77)';
    });
    await expect(expectStatusMarksInk(page)).rejects.toThrow(/green/);
  }).toPass({ timeout: 10_000 });
});

test('UX-07 (helper): a findings list grouped by stage with a count per group and no sum passes; a sum or a total fails', async ({ page }) => {
  const group = (a: string, b: string, c: string) => THREE_STAGES(`${a} findings`, `${b} findings`, `${c} findings`);

  await page.setContent(group('37', '23', '11'));
  await expectNoCrossStageTotal(page, SENTINELS);

  const bad: Array<[string, RegExp]> = [
    [group('37', '23', '11').replace('</main>', '<p>71 findings</p></main>'), /71/],
    [group('37', '23', '11').replace('</main>', '<p>Total: 71</p></main>'), /71|total/i],
    [group('37', '23', '11').replace('</main>', '<h2>Total</h2></main>'), /total/i],
    [group('37', '23', '11').replace('</main>', '<p>12 questions in all</p></main>'), /in all/i],
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
