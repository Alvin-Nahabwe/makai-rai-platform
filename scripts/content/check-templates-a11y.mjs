#!/usr/bin/env node
/**
 * Accessibility check of the HTML templates, run from disk with system Chrome.
 *
 *   flock /home/alvin/Downloads/MAK_RAI/.worktrees/v060-env/heavy.lock \
 *     node scripts/content/check-templates-a11y.mjs public/templates [docs/content/templates-review]
 *
 * For each `*.html` file in the folders it opens the file by `file://` URL at
 * 1280, 360 and 320 pixels wide, injects axe-core with the rule tags of the e2e
 * helper (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa) and prints
 *   <file> <width> serious=<n> critical=<n> incomplete=<n> hscroll=<yes|no>
 * It exits 1 when any file has a serious or critical violation, a result axe
 * could not decide (`incomplete`) or a page that scrolls sideways at 360 or
 * 320 pixels (WCAG 1.4.10; a wide table scrolls inside its own region). Each
 * of these is listed with the elements it names. Moderate and minor findings
 * are listed but do not fail the run.
 *
 * A drop-down whose chosen text does not fit is a failure too, on screen and in
 * the print layout (718 px, the width of A4 inside Chrome's default margins):
 * the empty option "Select" was once cut to "Selec" in a narrow table column.
 *
 * It prints the number of pages each template really prints to:
 *   <file> print pages=<n>
 * counted from the PDF that Chrome produces (`page.pdf()`, A4, 15 mm margins).
 * Sections are kept whole when printing, so this is more than the height of the
 * page divided by the height of a sheet. The count is of `/Type /Page` objects
 * in the PDF; a count of zero fails the run, because it means the PDF format
 * no longer matches what the script expects.
 *
 * At the narrow widths a wide table scrolls inside its own region, and axe
 * cannot hit-test text that sits outside the viewport, so it reports that
 * contrast as undecided. Colour contrast is therefore judged for the table
 * cells at 1280 pixels, where nothing is clipped (the colours do not change
 * with width), and at the narrow widths for everything outside the scroll
 * regions; every other rule runs over the whole page at every width.
 *
 * No server is started, so a content slot can run it. Nothing is fetched: the
 * browser is the system Chrome channel and axe-core comes from node_modules.
 * Which templates must exist is the content test's job (TC-7), not this one's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const RULE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [1280, 360, 320];
const REFLOW_WIDTHS = new Set([360, 320]);
const PRINT_LAYOUT_WIDTH_PX = 718;
const PDF_MARGIN = { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' };

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/content/check-templates-a11y.mjs <folder of .html files> [<folder> ...]');
  process.exit(2);
}

const files = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.resolve(dir, f)),
);
if (files.length === 0) {
  console.error(`no .html files in ${dirs.join(', ')}`);
  process.exit(2);
}
console.log(`checking ${files.length} files`);

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
const axeSource = readFileSync(axePath, 'utf8');

function listNodes(items, indent) {
  for (const node of items.slice(0, 5)) console.log(`${indent}${node.target.join(' ')}`);
  if (items.length > 5) console.log(`${indent}... and ${items.length - 5} more`);
}

/** Drop-downs whose chosen text is wider than the room inside them (16 px is left for the arrow). */
async function clippedSelects(page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas').getContext('2d');
    const clipped = [];
    for (const select of document.querySelectorAll('select')) {
      const style = getComputedStyle(select);
      canvas.font = style.font;
      // A select with no option has selectedIndex -1 and shows nothing that could be cut off.
      if (select.selectedIndex < 0) continue;
      const text = select.options[select.selectedIndex].text;
      const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
      if (canvas.measureText(text).width > room) {
        const name = select.id ? `#${select.id}` : `[aria-labelledby="${select.getAttribute('aria-labelledby')}"]`;
        clipped.push(`select${name} shows "${text}" in ${Math.round(room)} px`);
      }
    }
    return clipped;
  });
}

let failed = false;
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  let axeVersion;
  for (const file of files) {
    const name = path.basename(file);
    const url = pathToFileURL(file).href;
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url);
      const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      await page.addScriptTag({ content: axeSource });
      const results = await page.evaluate(
        async ({ tags, narrow }) => {
          const whole = await globalThis.axe.run(document, {
            runOnly: { type: 'tag', values: tags },
            rules: narrow ? { 'color-contrast': { enabled: false } } : {},
          });
          if (!narrow) return whole;
          const contrast = await globalThis.axe.run(
            { exclude: [['.table-scroll']] },
            { runOnly: { type: 'rule', values: ['color-contrast'] } },
          );
          return {
            testEngine: whole.testEngine,
            violations: [...whole.violations, ...contrast.violations],
            incomplete: [...whole.incomplete, ...contrast.incomplete],
          };
        },
        { tags: RULE_TAGS, narrow: width < WIDTHS[0] },
      );
      if (axeVersion === undefined) {
        axeVersion = results.testEngine.version;
        console.log(`axe-core ${axeVersion} from ${axePath}`);
      }
      const byImpact = (impact) => results.violations.filter((v) => v.impact === impact);
      const serious = byImpact('serious');
      const critical = byImpact('critical');
      const undecided = results.incomplete;
      const reflowFails = hscroll && REFLOW_WIDTHS.has(width);
      const cutOff = await clippedSelects(page);
      console.log(
        `${name} ${width} serious=${serious.length} critical=${critical.length} incomplete=${undecided.length} hscroll=${hscroll ? 'yes' : 'no'}`,
      );
      for (const v of [...critical, ...serious]) {
        failed = true;
        console.log(`  ${v.impact} ${v.id}: ${v.help}`);
        listNodes(v.nodes, '    ');
      }
      for (const v of undecided) {
        failed = true;
        console.log(`  undecided ${v.id}: ${v.help}`);
        listNodes(v.nodes, '    ');
      }
      for (const v of [...byImpact('moderate'), ...byImpact('minor')]) {
        console.log(`  note ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
      }
      if (reflowFails) {
        failed = true;
        console.log(`  the page scrolls sideways at ${width} px`);
      }
      for (const text of cutOff) {
        failed = true;
        console.log(`  cut-off text at ${width} px: ${text}`);
      }
    }
    await page.emulateMedia({ media: 'print' });
    await page.setViewportSize({ width: PRINT_LAYOUT_WIDTH_PX, height: 900 });
    await page.goto(url);
    for (const text of await clippedSelects(page)) {
      failed = true;
      console.log(`${name} cut-off text in the print layout: ${text}`);
    }
    const pdf = await page.pdf({ format: 'A4', margin: PDF_MARGIN });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-z])/g) ?? []).length;
    console.log(`${name} print pages=${pages}`);
    if (pages === 0) {
      failed = true;
      console.log('  could not count the pages of the PDF');
    }
    await page.emulateMedia({ media: null });
  }
} finally {
  await browser.close().catch((error) => console.error('browser.close failed:', error));
}

process.exit(failed ? 1 : 0);
