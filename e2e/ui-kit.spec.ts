import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, settleHover } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectTargetsAtLeast24px } from './helpers/targetSize';
import { TERM_DONE, TERM_PARTLY } from '../lib/vocabulary/terms';
import { tallyWords } from '../lib/ui/copy';
import { tallyOf } from '../lib/ui/marks';
import type { StatusMarkKind } from '../components/ui/types';

/**
 * The development gallery /dev/ui-kit (plan 1A Task 3): every components/ui component in every state, driven in a
 * real browser. The page is served because Playwright's server sets MAKRAI_TEST_SEAMS=1 (lib/ui/devGallery.ts);
 * its 404 in production is unit-tested in __tests__/unit/ui/dev-gallery.test.tsx.
 *
 * Page-level helpers come first, for every component's cases: a later task adds one `test.describe` per component.
 */

const KIT = '/dev/ui-kit';
const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 375, height: 812 },
  { width: 320, height: 640 },
] as const;

/**
 * Opens the gallery and waits until React has hydrated it, so a click is not lost (the saved demo's button reacts only
 * then). The signal is one only hydration produces: LocalTime's server render ends in " UTC", and its hydrated render,
 * in whatever zone the browser has, never names a zone.
 */
async function openKit(page: Page): Promise<void> {
  const response = await page.goto(KIT);
  expect(response?.status(), `${KIT} status`).toBe(200);
  await expect(page.locator('[data-kit-section="local-time"] time').first()).not.toHaveText(/UTC$/);
}

/**
 * Runs `check` in each theme, by the operating system's preference the tokens follow (app/globals.css). A theme change
 * starts every colour transition on the page (links and buttons fade over --duration-state), and a contrast check taken
 * inside that fade reads the old theme's ink on the new theme's ground, so `check` waits until no transition runs.
 */
async function inEachTheme(page: Page, check: (theme: (typeof THEMES)[number]) => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition)));
    await check(theme);
  }
}

/**
 * Runs `check` with forced colours on (Windows high contrast), then turns them off again. First it proves the emulation
 * repaints rather than only flipping the media query: the query matches, and an author colour (the primary button's
 * orange fill) computes to something else than it does in normal colours. Every forced-colours claim rests on this.
 */
async function withForcedColors(page: Page, check: () => Promise<void>): Promise<void> {
  const fill = () => page.locator('.ui-button--primary').first().evaluate((b) => getComputedStyle(b).backgroundColor);
  const normal = await fill();
  await page.emulateMedia({ forcedColors: 'active' });
  try {
    await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition)));
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'forced colours emulated').toBe(true);
    expect(await fill(), 'forced colours repaint an author colour').not.toBe(normal);
    await check();
  } finally {
    await page.emulateMedia({ forcedColors: 'none' });
  }
}

/**
 * The hydration errors among console and page error messages, in both of React's wordings. Development React writes
 * words ("Hydration failed because the server rendered text didn't match the client", "A tree hydrated but some
 * attributes of the server rendered HTML didn't match"); the production build CI serves writes only a code. In the
 * React that Next.js 16.4.5 bundles (node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.production.js),
 * a mismatch throws #418 (`throwOnHydrationMismatch`), and the recovery React logs is #422 (client rendering from the
 * nearest Suspense boundary) or #423 (client rendering the entire root). #425 is React 18's text-mismatch code and is
 * not in this build; it is matched anyway, at no cost, in case the bundled React changes back.
 */
function hydrationErrors(messages: readonly string[]): string[] {
  return messages.filter((m) => /hydrat|did not match|didn't match|server rendered|Minified React error #(?:418|422|423|425)(?!\d)/i.test(m));
}

/** A locator's box, failing the case with its name when the element is not rendered (no non-null assertion). */
async function boxOf(locator: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box, `${what} has a box`).not.toBeNull();
  if (box === null) throw new Error(`${what} has no box`);
  return box;
}

/**
 * Waits until the page has stopped scrolling. The page scrolls smoothly (`html { scroll-behavior: smooth }`,
 * app/globals.css), so a script's focus() or scrollIntoView() starts an animation; a key pressed or a box measured
 * during it acts on a page in motion.
 */
async function scrollSettled(page: Page): Promise<void> {
  // Settled: the same scroll position on two polls 100 ms apart. The predicate is synchronous: waitForFunction takes a
  // returned Promise as a truthy answer at once, without waiting for it.
  await page.evaluate(() => { (window as unknown as { kitLastY?: number }).kitLastY = Number.NaN; });
  await page.waitForFunction(() => {
    const w = window as unknown as { kitLastY?: number };
    const settled = w.kitLastY === window.scrollY;
    w.kitLastY = window.scrollY;
    return settled;
  }, undefined, { polling: 100 });
}

/** A kit section by its id (`data-kit-section`). */
const section = (page: Page, id: string) => page.locator(`[data-kit-section="${id}"]`);

/** The first item plate's link. */
const plateLink = (page: Page) => section(page, 'item-plate').locator('.ui-plate__link').first();

/**
 * The drawn shapes inside `selector` whose paint is missing or equals the page background: each shape's computed stroke
 * when it has one, else its fill (a <line> has a default black fill it never paints), against the body's background.
 */
async function shapesVisible(page: Page, selector: string): Promise<{ count: number; invisible: string[] }> {
  return page.evaluate((sel) => {
    const ground = getComputedStyle(document.body).backgroundColor;
    const invisible: string[] = [];
    const shapes = Array.from(document.querySelectorAll(`${sel} svg *`));
    for (const shape of shapes) {
      // Done's check is the surface colour (the canvas in forced colours) on its green disc, by the owner's ruling R8: it is
      // drawn against the disc, not the page, so only the disc is held to the page. Every other shape is ink.
      if (shape.classList.contains('ui-mark__done-check')) continue;
      const style = getComputedStyle(shape);
      const paint = style.stroke !== 'none' ? style.stroke : style.fill;
      if (paint === 'none' || paint === ground || paint === 'rgba(0, 0, 0, 0)') invisible.push(`${shape.tagName} ${paint}`);
    }
    return { count: shapes.length, invisible };
  }, selector);
}

/**
 * Each element's top border, and whether it is drawn: a border is drawn when it has a style, a width and a colour that is
 * neither transparent nor the page background. `marked` says whether the element matches `markedSelector`, the state that
 * should be the one ringed. Forced
 * colours repaint every author border, a transparent one included, so a state shown by a border must be the only border.
 */
async function drawnBorders(locator: Locator, markedSelector: string): Promise<Array<{ marked: boolean; drawn: boolean; ring: string }>> {
  return locator.evaluateAll((els, marked) => {
    const ground = getComputedStyle(document.body).backgroundColor;
    return els.map((el) => {
      const s = getComputedStyle(el);
      const drawn = s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0
        && s.borderTopColor !== 'rgba(0, 0, 0, 0)' && s.borderTopColor !== ground;
      return { marked: el.matches(marked), drawn, ring: `${s.borderTopStyle} ${s.borderTopWidth} ${s.borderTopColor}` };
    });
  }, markedSelector);
}

test.describe('the gallery page', () => {
  test('answers 200 and shows its heading', async ({ page }) => {
    await openKit(page);
    await expect(page.getByRole('heading', { level: 1, name: 'UI kit' })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
  });

  test('has no serious accessibility violation in either theme, at each width, and never scrolls sideways', async ({ page }) => {
    await openKit(page);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await inEachTheme(page, async (theme) => {
        await expectNoSeriousA11yViolations(page, `${KIT}, ${theme}, ${viewport.width} px`);
        await expectNoHorizontalScroll(page);
      });
    }
  });

  test('every pointer target is at least 24 by 24', async ({ page }) => {
    await openKit(page);
    await expectTargetsAtLeast24px(page);
  });

  test('the skip link is the first stop and moves focus to the main landmark', async ({ page }) => {
    await openKit(page);
    await page.keyboard.press('Tab');
    const skip = page.locator('a.skip-link');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    // The target takes focus only because it carries tabindex="-1" (UX-04; __tests__/unit/shell-footer.test.tsx).
    await expect(page.locator('main#main-content')).toBeFocused();
  });
});

test.describe('Icon', () => {
  test('all 29 icons draw, hidden from assistive technology, beside their names', async ({ page }) => {
    await openKit(page);
    const icons = section(page, 'icons').locator('[data-icon] svg.ui-icon');
    // Plan B7's 28 and pencil (lane 4 Task B round 1, "Edit project details").
    await expect(icons).toHaveCount(29);
    for (const svg of await icons.all()) {
      await expect(svg).toHaveAttribute('aria-hidden', 'true');
      const box = await svg.boundingBox();
      expect(box?.width).toBeCloseTo(20, 1);
    }
  });
});

test.describe('StatusMark', () => {
  test('marks draw at 16, 20 and 24 px, every kind', async ({ page }) => {
    await openKit(page);
    for (const size of [16, 20, 24]) {
      const shapes = section(page, 'status-marks').locator(`table:has(caption:text-is("Every kind at ${size} px")) .ui-mark__shape`);
      await expect(shapes).toHaveCount(7);
      for (const shape of await shapes.all()) {
        const box = await shape.boundingBox();
        expect(box?.width, `mark at ${size} px`).toBeCloseTo(size, 1);
        expect(box?.height, `mark at ${size} px`).toBeCloseTo(size, 1);
      }
    }
  });

  test('marks are painted in ink in both themes and stay visible in forced colours', async ({ page }) => {
    await openKit(page);
    await inEachTheme(page, async (theme) => {
      const painted = await shapesVisible(page, '[data-kit-section="status-marks"] .ui-mark');
      expect(painted.count, theme).toBeGreaterThan(20);
      expect(painted.invisible, theme).toEqual([]);
    });
    await withForcedColors(page, async () => {
      const painted = await shapesVisible(page, '[data-kit-section="status-marks"] .ui-mark');
      expect(painted.invisible, 'forced colours').toEqual([]);
      await expect(section(page, 'status-marks').getByText('Done, no evidence attached')).toBeVisible();
    });
  });
});

test.describe('RouteRow', () => {
  test('22 stops wrap at 320 px with no horizontal scroll, one current, then the tally', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const row = page.getByRole('list', { name: 'Sample stage', exact: true });
    const stops = row.locator('.ui-route-row__stop');
    await expect(stops).toHaveCount(22);
    const tops = new Set(await stops.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top))));
    expect(tops.size, 'rows the 22 stops wrap onto').toBeGreaterThan(1);
    await expectNoHorizontalScroll(page);
    await expect(row.locator('[aria-current="step"]')).toHaveCount(1);
    await expect(row.getByRole('link', { name: 'Sample question 4: Not yet' })).toHaveAttribute('aria-current', 'step');
    // The tally, keyed by the marks (lane 4 Task B): a list whose items, as assistive technology reads them, say the tally in
    // words in its order. The gallery's row counts its stops' kinds with 2 done questions lacking evidence.
    const kinds = await stops.evaluateAll((els) => els.map((el) => el.getAttribute('data-mark-kind')));
    const tally = section(page, 'route-row').locator('.ui-route-row').first().locator('ul.ui-route-row__tally');
    const items = tally.getByRole('listitem');
    const spoken = (await tally.ariaSnapshot()).split('\n').map((l) => /^\s*- listitem: (.*)$/.exec(l)?.[1]).filter((t): t is string => t !== undefined);
    expect(spoken.join(', ')).toBe(tallyWords(tallyOf(kinds as StatusMarkKind[], 2)));
    await expect(items.first()).toHaveText(/^\d+ done \(2 with no evidence attached\)$/);
    // K2: at 320 px each count stays on one line with its word, and the evidence caveat on one line of its own at most;
    // every item stays inside the list.
    const listBox = (await tally.boundingBox())!;
    const parts = await items.evaluateAll((els) => els.map((el) => ({
      text: el.textContent, right: el.getBoundingClientRect().right,
      // An inline part on one line is one line box tall (under two font sizes); on two it would be two 24 px lines.
      oneLine: Array.from(el.querySelectorAll('.ui-route-row__tally-count, .ui-route-row__tally-caveat')).map((p) => p.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(p).fontSize)),
    })));
    for (const part of parts) {
      expect(part.oneLine, `${part.text}: each part on one line`).toEqual(part.oneLine.map(() => true));
      expect(part.right, `${part.text}: inside the list`).toBeLessThanOrEqual(listBox.x + listBox.width + 0.5);
    }
    expect(new Set(await items.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))).size, 'the items wrap between each other').toBeGreaterThan(1);
  });

  test('the current stop is the only ringed one, in normal and in forced colours', async ({ page }) => {
    await openKit(page);
    const row = page.getByRole('list', { name: 'Sample stage', exact: true });
    const expectOneRing = async (mode: string) => {
      const rings = await drawnBorders(row.locator('.ui-route-row__point'), '[aria-current="step"]');
      expect(rings.filter((r) => r.marked), mode).toHaveLength(1);
      expect(rings.filter((r) => r.drawn).map((r) => r.marked), `${mode}, rings drawn: ${JSON.stringify(rings.filter((r) => r.drawn))}`).toEqual([true]);
    };
    await expectOneRing('normal colours');
    await withForcedColors(page, () => expectOneRing('forced colours'));
  });

  test('the row shows no progress bar, meter or percentage', async ({ page }) => {
    await openKit(page);
    const routeRow = section(page, 'route-row');
    await expect(routeRow.locator('progress, [role="progressbar"], [role="meter"]')).toHaveCount(0);
    expect(await routeRow.innerText()).not.toMatch(/%/);
  });
});

test.describe('SavedMark', () => {
  test.use({ timezoneId: 'Africa/Nairobi' });

  test('the saved region announces: its text changes after "Simulate save", in the reader\'s time zone', async ({ page }) => {
    await openKit(page);
    const region = section(page, 'saved-mark').getByRole('status');
    await expect(region).toHaveCount(1);
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveText('');
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await expect(region).toContainText('Saved as version 1');
    await expect(region).toContainText('Decided on 11 Feb 2026 · Saved 11 Nov 2026, 11:23');
    await expect(region).not.toContainText('kept in the history');
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await expect(region).toContainText('Saved as version 2');
    await expect(region).toContainText('This decision is saved on the platform. Version 1 is kept in the history.');
    await settleHover(page);
    await inEachTheme(page, (theme) => expectNoSeriousA11yViolations(page, `${KIT} saved mark after a save, ${theme}`));
  });

  test('the saved mark stays visible in forced colours', async ({ page }) => {
    await openKit(page);
    await page.getByRole('button', { name: 'Simulate save' }).click();
    await withForcedColors(page, async () => {
      const region = section(page, 'saved-mark').getByRole('status');
      await expect(region.getByText('Saved as version 1')).toBeVisible();
      const painted = await shapesVisible(page, '[data-kit-section="saved-mark"] .ui-saved__shape');
      expect(painted.count).toBeGreaterThan(0);
      expect(painted.invisible).toEqual([]);
    });
  });
});

test.describe('the app font', () => {
  /**
   * The middle dot of the " · " separator (SavedMark, and every other screen that has one), the backtick and the spacing
   * accents take their own width. Upstream Overpass classes these glyphs as marks (GDEF class 3, and GPOS mark
   * coverage), and the shaper gives a mark no advance, so the dot was drawn on top of the space after it;
   * scripts/fonts/subset.sh makes them plain spacing glyphs. Advances in units of 2000 at the default weight, 400
   * (fontTools, hmtx of app/fonts/*.woff2): a 1052, b 1124, space 470, middle dot 450, the backtick and the accents 736.
   */
  test('the middle dot, the backtick and the spacing accents each take their own advance, and "a · b" is as wide as its parts', async ({ page }) => {
    await openKit(page);
    const px = (units: number) => (units * 16) / 2000;
    const measured = await page.evaluate(async () => {
      const font = '16px overpass';
      const texts = ['·', '`', '´', 'ˇ', 'a', 'b', ' ', 'a · b', 'a·b'];
      // Each text loads the face whose unicode-range holds it; an empty answer means it would draw in a fallback font.
      // This is the guard against measuring a fallback: Arial's backtick is within a pixel of Overpass's.
      const faces = await Promise.all(texts.map(async (t) => (await document.fonts.load(font, t)).length));
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx === null) throw new Error('no 2d canvas context');
      ctx.font = font;
      const m = (t: string) => ctx.measureText(t);
      return {
        faces,
        width: Object.fromEntries(texts.map((t) => [t, m(t).width])),
        // Where the ink ends, from the start of the text: of "a" alone, and of "a·" (the dot's ink is the last).
        aInk: m('a').actualBoundingBoxRight,
        aDotInk: m('a·').actualBoundingBoxRight,
        // A glyph still in a GPOS mark coverage is attached to the a's anchor even with its own advance: the backtick
        // was then drawn on top of the a.
        aGraveInk: m('a`').actualBoundingBoxRight,
      };
    });
    console.log(`font widths at 16px: ${JSON.stringify(measured)}`);
    expect(measured.faces.every((n) => n > 0), 'every text has an overpass face').toBe(true);
    const w = measured.width;
    expect(Math.abs(w['·'] - px(450)), `"·" is ${w['·']} px, its advance ${px(450)} px`).toBeLessThan(1);
    expect(Math.abs(w['`'] - px(736)), `"\`" is ${w['`']} px, its advance ${px(736)} px`).toBeLessThan(1);
    expect(Math.abs(w['´'] - px(736)), `"´" (rest file) is ${w['´']} px, its advance ${px(736)} px`).toBeLessThan(1);
    expect(Math.abs(w['ˇ'] - px(736)), `"ˇ" (ext-rest file) is ${w['ˇ']} px, its advance ${px(736)} px`).toBeLessThan(1);
    const parts = w.a + w[' '] + w['·'] + w[' '] + w.b;
    expect(Math.abs(w['a · b'] - parts), `"a · b" is ${w['a · b']} px, its parts ${parts} px`).toBeLessThan(1);
    expect(Math.abs(w['a·b'] - (w.a + w['·'] + w.b)), `"a·b" is ${w['a·b']} px`).toBeLessThan(1);
    // In "a·", the dot's ink starts after the a's ink and ends within the a's and the dot's advances: not moved onto the a.
    expect(measured.aDotInk, 'the dot ink ends after the a ink').toBeGreaterThan(measured.aInk + 0.5);
    expect(measured.aDotInk, 'the dot ink ends inside its own advance').toBeLessThanOrEqual(w.a + w['·'] + 0.5);
    expect(measured.aGraveInk, 'the backtick ink in "a`" ends after the a ink').toBeGreaterThan(measured.aInk + 0.5);
    expect(measured.aGraveInk, 'the backtick ink ends inside its own advance').toBeLessThanOrEqual(w.a + w['`'] + 0.5);
  });
});

test.describe('LocalTime', () => {
  test.use({ timezoneId: 'Africa/Nairobi' });

  test('the server render in UTC is replaced after hydration by the reader\'s zone, with no hydration error', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    const served = await (await page.request.get(KIT)).text();
    expect(served, 'server render').toContain('11 Nov 2026, 08:23 UTC');
    await openKit(page);
    const times = section(page, 'local-time').locator('time');
    await expect(times.first()).toHaveText('11 Nov 2026, 11:23');
    await expect(times.first()).toHaveAttribute('dateTime', '2026-11-11T08:23:00.000Z');
    await expect(times.nth(1)).toHaveText('11 Nov 2026');
    expect(hydrationErrors(errors)).toEqual([]);
  });
});

test.describe('Button', () => {
  test('every default button is 44 px high at least, a compact one 32 px, and busy keeps focus without being disabled', async ({ page }) => {
    await openKit(page);
    const buttons = section(page, 'buttons');
    for (const button of await buttons.locator('.ui-button:not(.ui-button--compact)').all()) {
      expect((await button.boundingBox())?.height, await button.innerText()).toBeGreaterThanOrEqual(44);
    }
    for (const button of await buttons.locator('.ui-button--compact').all()) {
      const box = await button.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(32);
      expect(box?.width).toBeGreaterThanOrEqual(24);
    }
    const busy = buttons.getByRole('button', { name: 'Saving', exact: true }).first();
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy).toBeEnabled();
    await busy.focus();
    await expect(busy).toBeFocused();
    await busy.click();
    await expect(busy).toBeFocused();
    await expect(buttons.getByRole('button', { name: 'Save decision', exact: true }).last()).toBeDisabled();
  });
});

test.describe('TextInput and TextArea', () => {
  test('the error is read with the field; the count follows the typing and says when the text is too long', async ({ page }) => {
    await openKit(page);
    const invalid = page.getByLabel('Organisation name (required)', { exact: true });
    await expect(invalid).toHaveAttribute('aria-invalid', 'true');
    await expect(invalid).toHaveAccessibleDescription("As it appears on your letterhead. Enter the organisation's name.");
    await expect(page.locator('#kit-error-error')).toHaveText("Enter the organisation's name.");
    await expect(page.getByLabel('Sign-in email', { exact: true })).toHaveAttribute('readonly', '');
    const reason = page.getByLabel('Reason (required)', { exact: true });
    await reason.fill('Checked the consent forms.');
    const count = page.locator('#kit-reason-count');
    await expect(count).toHaveText('26 of 40 characters');
    await expect(count).not.toHaveClass(/ui-count--over/);
    await reason.fill('Checked the consent forms against the protocol.');
    await expect(count).toHaveText('7 characters too many. Shorten the text to 40 characters.');
    await expect(count).toHaveClass(/ui-count--over/);
    await expect(reason).toHaveAccessibleDescription(/^Say what was checked and what it showed\. 7 characters too many/);
  });
});

test.describe('Select', () => {
  test('a 44 px closed control with the chevron, which a person can choose from', async ({ page }) => {
    await openKit(page);
    const select = page.getByLabel('Decided by (required)', { exact: true });
    expect((await select.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(section(page, 'select').locator('.ui-select__icon svg').first()).toBeVisible();
    await select.selectOption({ label: 'Ethics committee' });
    await expect(select).toHaveValue('role:ethics');
    await expect(page.getByLabel('Decided by, while saving', { exact: true })).toBeDisabled();
  });
});

test.describe('RadioCards', () => {
  test('each radio is named by its label alone; Tab reaches the group, Space chooses, the arrows move the choice', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true });
    const done = group.getByRole('radio', { name: 'Done', exact: true });
    await expect(done).toHaveCount(1);
    await expect(done).toHaveAccessibleDescription(TERM_DONE.definition);
    await page.locator('#kit-select-error').focus();
    await page.keyboard.press('Tab');
    await expect(done).toBeFocused();
    await page.keyboard.press('Space');
    await expect(done).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(group.getByRole('radio', { name: 'Partly', exact: true })).toBeChecked();
    await expect(page.locator('[data-demo-output="status"]')).toHaveText('Chosen: partly');
  });

  test('a click on the help sentence chooses its card', async ({ page }) => {
    await openKit(page);
    // The label's stretched ::after lies over the help sentence, so the click lands on the label, as a person's would;
    // force skips Playwright's check that the sentence itself receives the pointer.
    await page.getByText(TERM_PARTLY.definition).click({ force: true });
    await expect(section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true }).getByRole('radio', { name: 'Partly', exact: true })).toBeChecked();
  });

  test('the chosen card is the only one with a border and the only one with a mark, in normal and in forced colours (critique P1 4)', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true });
    await expect(group.locator('.ui-mark__shape'), 'no mark until a card is chosen').toHaveCount(0);
    await group.getByRole('radio', { name: 'Not yet', exact: true }).check();
    const expectSelection = async (mode: string) => {
      const cards = await drawnBorders(group.locator('.ui-radio-card'), ':has(:checked)');
      expect(cards.filter((c) => c.marked), mode).toHaveLength(1);
      expect(cards.filter((c) => c.drawn).map((c) => c.marked), `${mode}, borders drawn: ${JSON.stringify(cards.filter((c) => c.drawn))}`).toEqual([true]);
      // One mark in the group, on the chosen card, and it is painted against the page.
      await expect(group.locator('.ui-mark__shape'), mode).toHaveCount(1);
      await expect(group.locator('.ui-radio-card:has(:checked) .ui-mark__shape'), mode).toHaveCount(1);
      const painted = await shapesVisible(page, '[data-kit-section="radio-cards"] .ui-radio-card:has(:checked) .ui-radio-card__label');
      expect(painted.count, `${mode}, the chosen mark's primitives`).toBeGreaterThan(0);
      expect(painted.invisible, `${mode}, the chosen mark`).toEqual([]);
      // The unchosen cards draw a ring, never a mark, and the ring is painted against the page.
      const rings = await group.locator('.ui-radio-card:not(:has(:checked)) .ui-radio-card__ring').evaluateAll((els) =>
        els.map((e) => getComputedStyle(e).borderTopColor !== getComputedStyle(document.body).backgroundColor));
      expect(rings, `${mode}, rings on the unchosen cards`).toEqual([true, true, true]);
    };
    await expectSelection('normal colours');
    await withForcedColors(page, () => expectSelection('forced colours'));
  });

  test('forced colours: Done\'s chosen mark stays visible (disc and check apart)', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true });
    await group.getByRole('radio', { name: 'Done', exact: true }).check();
    await withForcedColors(page, async () => {
      const paint = await group.locator('.ui-mark__done-disc, .ui-mark__done-check').evaluateAll((els) =>
        els.map((e) => { const s = getComputedStyle(e); return { cls: e.getAttribute('class'), fill: s.fill, stroke: s.stroke }; }));
      const disc = paint.find((p) => p.cls === 'ui-mark__done-disc')!;
      const check = paint.find((p) => p.cls === 'ui-mark__done-check')!;
      expect(disc.fill).not.toBe('none');
      expect(check.stroke).not.toBe(disc.fill);
    });
  });

  test('an option with no mark shows its choice as a drawn dot, in normal and in forced colours', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'Does the data hold personal information?', exact: true });
    await group.getByRole('radio', { name: 'No', exact: true }).check();
    const expectDot = async (mode: string) => {
      const dot = await group.locator('.ui-radio-card:has(:checked) .ui-radio-card__ring').evaluate((ring) => {
        const s = getComputedStyle(ring, '::before');
        return { width: parseFloat(s.borderTopWidth), colour: s.borderTopColor, ground: getComputedStyle(document.body).backgroundColor };
      });
      expect(dot.width, `${mode}, the chosen dot`).toBeGreaterThan(0);
      expect(dot.colour, `${mode}, the chosen dot`).not.toBe(dot.ground);
      await expect(group.locator('.ui-radio-card:not(:has(:checked)) .ui-radio-card__ring[data-on="true"]'), mode).toHaveCount(0);
    };
    await expectDot('normal colours');
    await withForcedColors(page, () => expectDot('forced colours'));
  });

  test('a 40-character label wraps inside its card in the decision card\'s own grid at 320 px and at 200% zoom (160 CSS px), the whole document not scrolling sideways; the radio is named by the label alone', async ({ page }) => {
    const LABEL = 'Yes, we compared each group in the data.';
    expect([...LABEL]).toHaveLength(40);
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'A long answer label', exact: true });
    const radio = group.getByRole('radio', { name: LABEL, exact: true });
    await expect(radio).toHaveCount(1);
    await radio.check();
    await expect(radio).toHaveAccessibleName(LABEL);
    // Hide every other part of the gallery (its own sections are not this check's business at 160 px), leaving the demo's path.
    await page.evaluate(() => {
      let el: Element | null = document.getElementById('kit-long-label-wrap');
      while (el !== null && el !== document.body) {
        for (const sib of Array.from(el.parentElement!.children)) if (sib !== el) (sib as HTMLElement).style.display = 'none';
        el = el.parentElement;
      }
    });
    const inside = async (what: string) => {
      const m = await page.evaluate(() => {
        const card = document.querySelector('#kit-long-label-wrap .ui-radio-card:has(input[value="compared"])')!;
        const label = card.querySelector('.ui-radio-card__label')!;
        const c = card.getBoundingClientRect();
        const text = Array.from(label.childNodes).filter((n) => n.nodeType === 3 || n.nodeType === 1)
          .map((n) => { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect(); });
        const de = document.documentElement;
        return { card: { left: c.left, right: c.right }, text: text.map((r) => ({ left: r.left, right: r.right, height: r.height })), documentOverflow: de.scrollWidth - de.clientWidth };
      });
      expect(m.documentOverflow, `${what}: the document scrolls sideways`).toBeLessThanOrEqual(0);
      for (const t of m.text) {
        if (t.height === 0) continue;
        expect(t.left, `${what}: text starts inside the card`).toBeGreaterThanOrEqual(m.card.left - 0.5);
        expect(t.right, `${what}: text ends inside the card`).toBeLessThanOrEqual(m.card.right + 0.5);
      }
    };
    await inside('320 px');
    await page.setViewportSize({ width: 160, height: 640 });   // 200% zoom of a 320 px window
    await inside('200% zoom (160 CSS px)');
  });
});

test.describe('Checkbox', () => {
  test('Tab moves between boxes and Space ticks them; the group reports what is ticked', async ({ page }) => {
    await openKit(page);
    await page.locator('#kit-agree').focus();
    await page.keyboard.press('Tab');
    const checked = page.getByLabel('Keep me signed in on this device', { exact: true });
    await expect(checked).toBeFocused();
    await expect(checked).toBeChecked();
    await page.keyboard.press('Space');
    await expect(checked).not.toBeChecked();
    await page.locator('#kit-in-place-policy').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    await expect(page.locator('[data-demo-output="in-place"]')).toHaveText('Ticked: policy, owner');
    for (const row of await section(page, 'checkbox').locator('.ui-checkbox__label').all()) {
      expect((await row.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('a ticked box keeps its tick in forced colours, and an empty one shows none', async ({ page }) => {
    await openKit(page);
    await withForcedColors(page, async () => {
      const ticks = await section(page, 'checkbox').locator('.ui-checkbox__input:not(:disabled)').evaluateAll((boxes) => boxes.map((box) => {
        const s = getComputedStyle(box, '::before');
        return { checked: (box as HTMLInputElement).checked, drawn: parseFloat(s.borderRightWidth) > 0 && s.borderRightColor !== getComputedStyle(document.body).backgroundColor };
      }));
      expect(ticks.some((t) => t.checked)).toBe(true);
      expect(ticks.every((t) => t.drawn === t.checked), JSON.stringify(ticks)).toBe(true);
    });
  });
});

test.describe('DateField', () => {
  test('Enter on Today fills the reader\'s date, a shortcut fills its own, and nothing is filled before', async ({ page }) => {
    await openKit(page);
    const field = section(page, 'date-field').getByRole('group', { name: 'Decided on (required)', exact: true });
    const boxes = [field.getByLabel('Day', { exact: true }), field.getByLabel('Month', { exact: true }), field.getByLabel('Year', { exact: true })];
    for (const box of boxes) {
      await expect(box).toHaveValue('');
      await expect(box).toHaveAttribute('inputmode', 'numeric');
    }
    await field.getByRole('button', { name: 'Today', exact: true }).focus();
    await page.keyboard.press('Enter');
    const today = await page.evaluate(() => { const d = new Date(); return [String(d.getDate()), String(d.getMonth() + 1), String(d.getFullYear())]; });
    for (const [i, box] of boxes.entries()) await expect(box).toHaveValue(today[i]);
    await field.getByRole('button', { name: 'Same as version 2 (11 Feb 2026)', exact: true }).click();
    await expect(page.locator('[data-demo-output="decided-on"]')).toHaveText('Reads as: 2026-02-11');
    await boxes[0].fill('31');
    await expect(page.locator('[data-demo-output="decided-on"]')).toHaveText('Reads as: not_a_date');
  });

  test('the error is read with each box, and at 320 px the boxes and buttons wrap without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const field = section(page, 'date-field').getByRole('group', { name: 'Decided on, with an error', exact: true });
    await expect(field.getByLabel('Day', { exact: true })).toHaveAccessibleDescription('Enter a date that exists. February 2026 has 28 days.');
    await expect(page.locator('#kit-date-error-message')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('ErrorSummary', () => {
  test('each link goes to a field on the page, and a script\'s focus lands on the element holding the title', async ({ page }) => {
    await openKit(page);
    const summary = section(page, 'error-summary').locator('.ui-error-summary');
    for (const link of await summary.getByRole('link').all()) {
      const href = (await link.getAttribute('href')) ?? '';
      expect(href).toMatch(/^#./);
      await expect(page.locator(`[id="${href.slice(1)}"]`)).toHaveCount(1);
    }
    await page.getByRole('button', { name: 'Move focus to the summary', exact: true }).click();
    // The protected e2e/decision-save.spec.ts:294 asserts focus this way, by the title's text.
    const title = page.getByText('There is a problem', { exact: true });
    await expect(title).toBeFocused();
    expect(await title.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });
});

test.describe('Button, busy in a form', () => {
  test('a busy submit button submits nothing: not by click, Space or Enter on it, nor Enter in the form\'s field', async ({ page }) => {
    await openKit(page);
    const form = page.getByRole('form', { name: 'A form while it saves' });
    const busy = form.getByRole('button', { name: 'Saving the project', exact: true });
    const submits = form.locator('[data-demo-output="busy-submits"]');
    await busy.click();
    await busy.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await form.getByLabel('Project name, in a form that is saving', { exact: true }).press('Enter');
    await expect(submits).toHaveText('Submits: 0');
  });
});

test.describe('forced colours, the remaining states', () => {
  test('the focus ring, an invalid field, a disabled control, the select\'s arrow and a read-only field stay distinct', async ({ page }) => {
    await openKit(page);
    await withForcedColors(page, async () => {
      const ground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const border = (sel: string) => page.locator(sel).evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.borderTopStyle, width: parseFloat(s.borderTopWidth), colour: s.borderTopColor };
      });
      // Focus ring, by keyboard so :focus-visible applies.
      await page.locator('#kit-name').focus();
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const s = getComputedStyle(document.activeElement as Element);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth), colour: s.outlineColor };
      });
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeGreaterThanOrEqual(3);
      expect(ring.colour).not.toBe(ground);
      // An invalid field's border is thicker than a valid one's.
      const valid = await border('#kit-name');
      const invalid = await border('#kit-error');
      expect(invalid.width).toBeGreaterThan(valid.width);
      expect(invalid.colour).not.toBe(ground);
      // A disabled control's border is dashed.
      expect((await border('#kit-disabled')).style).toBe('dashed');
      // A read-only field draws no border, so it does not look like a box to type in.
      expect((await border('#kit-readonly')).width).toBe(0);
      expect((await border('#kit-reason-readonly')).width).toBe(0);
      expect(valid.width).toBeGreaterThan(0);
      // The select's arrow is painted.
      const arrow = await shapesVisible(page, '[data-kit-section="select"] .ui-select__icon');
      expect(arrow.count).toBeGreaterThan(0);
      expect(arrow.invisible).toEqual([]);
    });
  });
});

test.describe('Callout', () => {
  test('a caution keeps its 4 px start border and its icon in both themes and in forced colours; a note has neither', async ({ page }) => {
    await openKit(page);
    const caution = section(page, 'callout').locator('.ui-callout--caution');
    const startBorder = () => caution.first().evaluate((el) => {
      const s = getComputedStyle(el);
      // WCAG relative luminance of a computed rgb() colour, then the contrast of the border against the callout's own fill.
      const luminance = (c: string) => {
        const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map((v) => {
          const x = v / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const [hi, lo] = [luminance(s.borderInlineStartColor), luminance(s.backgroundColor)].sort((x, y) => y - x);
      return { width: s.borderInlineStartWidth, style: s.borderInlineStartStyle, colour: s.borderInlineStartColor, contrast: (hi + 0.05) / (lo + 0.05) };
    });
    await inEachTheme(page, async (theme) => {
      const border = await startBorder();
      expect(border.width, theme).toBe('4px');
      expect(border.contrast, `${theme}: the border against the callout's own fill`).toBeGreaterThanOrEqual(3);
      expect((await shapesVisible(page, '[data-kit-section="callout"] .ui-callout--caution')).invisible, theme).toEqual([]);
    });
    await withForcedColors(page, async () => {
      const border = await startBorder();
      expect(border.width).toBe('4px');
      expect(border.style).toBe('solid');
      expect(border.colour).not.toBe('rgba(0, 0, 0, 0)');
      const shapes = await shapesVisible(page, '[data-kit-section="callout"] .ui-callout--caution');
      expect(shapes.count).toBeGreaterThan(0);
      expect(shapes.invisible).toEqual([]);
    });
    await expect(section(page, 'callout').locator('.ui-callout--note svg')).toHaveCount(0);
    await expect(section(page, 'callout').locator('[role], [aria-live]')).toHaveCount(0);
  });
});

test.describe('StatusRegion', () => {
  test('the region is in the page before its message, receives it, and empties again without leaving', async ({ page }) => {
    await openKit(page);
    const region = page.locator('#kit-status-live');
    await expect(region).toHaveAttribute('role', 'status');
    await expect(region).toBeEmpty();
    await section(page, 'status-region').getByRole('button', { name: 'Show a message' }).click();
    await expect(region).toHaveText('Sample member invited.');
    await section(page, 'status-region').getByRole('button', { name: 'Show an error' }).click();
    await expect(region).toHaveText('The sample invitation was not sent. Try again.');
    await expect(region).toHaveClass(/ui-status--error/);
    expect(await region.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('700');
    await section(page, 'status-region').getByRole('button', { name: 'Clear' }).click();
    await expect(region).toBeEmpty();
    await expect(region).toBeAttached();
  });
});

test.describe('Banner', () => {
  test('each kind shows its icon and words in both themes and in forced colours; the actions sit in __action', async ({ page }) => {
    await openKit(page);
    const banners = section(page, 'banner').locator('.ui-banner');
    await expect(banners).toHaveCount(4);
    for (const [kind, icon] of [['offline', 'wifi-off'], ['archived', 'archive'], ['session', 'clock'], ['info', 'info']] as const) {
      await expect(section(page, 'banner').locator(`.ui-banner--${kind} .ui-banner__icon svg`), `${kind} draws ${icon}`).toHaveCount(1);
    }
    await expect(section(page, 'banner').locator('.ui-banner__action > a')).toHaveCount(2);
    await expect(section(page, 'banner').locator('.ui-banner--info .ui-banner__action').getByRole('link', { name: 'Read the sample guidance' })).toBeVisible();
    await inEachTheme(page, async (theme) => {
      expect((await shapesVisible(page, '[data-kit-section="banner"] .ui-banner')).invisible, theme).toEqual([]);
    });
    await withForcedColors(page, async () => {
      expect((await shapesVisible(page, '[data-kit-section="banner"] .ui-banner')).invisible).toEqual([]);
      for (const b of await banners.all()) await expect(b.locator('.ui-banner__body')).toBeVisible();
    });
    expect(await banners.evaluateAll((els) => els.map((el) => getComputedStyle(el).position))).toEqual(['static', 'static', 'static', 'static']);
  });

  test('at 320 px the action wraps below the words and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const session = section(page, 'banner').locator('.ui-banner--session');
    const body = await boxOf(session.locator('.ui-banner__body'), 'the session banner\'s words');
    const action = await boxOf(session.locator('.ui-banner__action'), 'the session banner\'s action');
    expect(action.y).toBeGreaterThanOrEqual(body.y + body.height - 1);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Skeleton', () => {
  test('nothing moves, and each says what is loading through a visually hidden status line', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openKit(page);
    const running = await page.evaluate(() => document.getAnimations()
      .filter((a) => a.effect instanceof KeyframeEffect && a.effect.target instanceof Element && a.effect.target.closest('.ui-skeleton') !== null).length);
    expect(running).toBe(0);
    const lines = section(page, 'skeleton').locator('.ui-skeleton > p[role="status"].visually-hidden');
    await expect(lines).toHaveText(['Loading the sample text', 'Loading the sample question', 'Loading the sample table']);
    await expect(section(page, 'skeleton').locator('.ui-skeleton > [aria-hidden="true"] .ui-skeleton__line')).toHaveCount(9);
  });
});

test.describe('EmptyState', () => {
  test('says what is empty and how it fills, with its action after the words', async ({ page }) => {
    await openKit(page);
    const empty = section(page, 'empty-state').locator('.ui-empty').first();
    await expect(empty.locator('.ui-empty__title')).toHaveText('No findings yet');
    await expect(empty.locator('.ui-empty__action').getByRole('link', { name: 'Open the sample stage' })).toBeVisible();
    await expect(section(page, 'empty-state').locator('.ui-empty').nth(1).locator('.ui-empty__action')).toHaveCount(0);
  });
});

test.describe('Dialog', () => {
  test('opens as a native modal, the safe action takes focus, Escape closes it once and focus returns to the invoker', async ({ page }) => {
    await openKit(page);
    const opener = section(page, 'dialog').getByRole('button', { name: 'Open the sample dialog' });
    const output = page.locator('[data-demo-output="dialog"]');
    const rootOverflow = () => page.evaluate(() => [getComputedStyle(document.body).overflow, getComputedStyle(document.documentElement).overflow]);
    const overflowBefore = await rootOverflow();
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Archive the sample project?' });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
    expect(await dialog.evaluate((d) => [d.getAttribute('role'), d.getAttribute('aria-modal')])).toEqual([null, null]);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // Nothing trapped by script: no inert attribute anywhere, and opening changes neither root's overflow.
    expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
    expect(await rootOverflow()).toEqual(overflowBefore);
    await inEachTheme(page, async (theme) => {
      await expectNoSeriousA11yViolations(page, `${KIT} dialog open, ${theme}`);
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(output).toHaveText('Closed by the browser: 1. Chosen: dismissed.');
    await expect(opener).toBeFocused();
  });

  test('sits in the centre of the window with at least a 16 px gutter at 1280 and 320 px, and a long one scrolls inside itself', async ({ page }) => {
    await openKit(page);
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      await page.setViewportSize(viewport);
      for (const [opener, title] of [['Open the sample dialog', 'Archive the sample project?'], ['Open the long sample dialog', 'A long sample dialog']] as const) {
        await section(page, 'dialog').getByRole('button', { name: opener }).click();
        const dialog = page.getByRole('dialog', { name: title });
        await expect(dialog).toBeVisible();
        const box = await boxOf(dialog, title);
        const where = `${title} at ${viewport.width} px`;
        expect(Math.abs(box.x + box.width / 2 - viewport.width / 2), `${where}: centred across`).toBeLessThanOrEqual(2);
        expect(Math.abs(box.y + box.height / 2 - viewport.height / 2), `${where}: centred down`).toBeLessThanOrEqual(2);
        expect(box.x, where).toBeGreaterThanOrEqual(16);
        expect(box.y, where).toBeGreaterThanOrEqual(16);
        expect(box.x + box.width, where).toBeLessThanOrEqual(viewport.width - 16);
        expect(box.y + box.height, where).toBeLessThanOrEqual(viewport.height - 16);
        if (title === 'A long sample dialog') {
          expect(await dialog.evaluate((d) => d.scrollHeight > d.clientHeight), `${where}: scrolls inside itself`).toBe(true);
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      }
    }
  });

  test('an action closes it through the caller, which onClose does not report', async ({ page }) => {
    await openKit(page);
    const opener = section(page, 'dialog').getByRole('button', { name: 'Open the sample dialog' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Archive the sample project?' });
    await dialog.getByRole('button', { name: 'Archive project' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-demo-output="dialog"]')).toHaveText('Closed by the browser: 0. Chosen: archive.');
    await expect(opener).toBeFocused();
    await opener.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-demo-output="dialog"]')).toHaveText('Closed by the browser: 1. Chosen: dismissed.');
  });
});

test.describe('InlineConfirm', () => {
  test('Cancel comes first on screen at every width, the destructive variant is the kit\'s, and a busy confirm is aria-busy, not disabled, keeps focus and does nothing when pressed', async ({ page }) => {
    await openKit(page);
    const groups = section(page, 'inline-confirm').getByRole('group');
    await expect(groups).toHaveCount(3);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      for (const group of await groups.all()) {
        const [cancel, confirm] = await group.locator('.ui-confirm__actions button').all();
        const a = await boxOf(cancel, 'Cancel');
        const b = await boxOf(confirm, 'the confirm button');
        expect(a.y < b.y - 1 || (Math.abs(a.y - b.y) <= 1 && a.x < b.x), `${viewport.width} px: Cancel before confirm`).toBe(true);
      }
    }
    await expect(groups.nth(1).getByRole('button', { name: 'Archive project' })).toHaveClass(/ui-button--destructive/);
    await expect(groups.nth(1).getByRole('button', { name: 'Keep it open' })).toBeVisible();
    // SC 2.4.3 (D-386): busy is the kit's Button busy state, not disabled, so a focused confirm button keeps focus while its
    // request is sent, and a press on it confirms nothing.
    const busy = groups.nth(2).getByRole('button', { name: 'Revoke invitation' });
    await expect(busy).toHaveAttribute('aria-busy', 'true');
    await expect(busy).toBeEnabled();
    await busy.focus();
    await expect(busy).toBeFocused();
    await page.keyboard.press('Enter');
    await busy.click();
    await expect(busy).toBeFocused();
    await expect(page.locator('[data-demo-output="confirm"]')).toHaveText('Pressed: nothing yet.');
    await expect(groups.nth(2).getByRole('button', { name: 'Cancel' })).toBeEnabled();
  });

  test('SC 2.4.11 (D-386): the kit page loads at the top: the confirmations that come with its HTML do not scroll it on hydration', async ({ page }) => {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      await page.setViewportSize(viewport);
      await openKit(page);
      await scrollSettled(page);
      // Every vertical scroller on the page, the document included, is still at its top (a sideways scroll, such
      // as the tab row bringing its current tab into view, is not this case's).
      const moved = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
        .filter((el) => el.scrollTop !== 0)
        .map((el) => `${el.tagName.toLowerCase()}.${Array.from(el.classList).join('.')} at ${el.scrollTop}`));
      expect(moved, `${viewport.width} px: nothing scrolled`).toEqual([]);
      // The case can fail: the kit's confirmations start below the fold, so a reveal on hydration would have scrolled.
      const lastTop = await section(page, 'inline-confirm').getByRole('group').last().evaluate((el) => el.getBoundingClientRect().top);
      expect(lastTop, `${viewport.width} px: the last kit confirmation starts below the window`).toBeGreaterThan(viewport.height);
    }
  });

  test('Enter on Cancel cancels and never confirms; the confirm runs only from its own button', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'inline-confirm').getByRole('group').first();
    const output = page.locator('[data-demo-output="confirm"]');
    await group.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Enter');
    await expect(output).toHaveText('Pressed: cancel.');
    await group.getByRole('button', { name: 'Withdraw document' }).click();
    await expect(output).toHaveText('Pressed: withdraw.');
  });
});

test.describe('Table', () => {
  const demo = (page: Page) => section(page, 'table').locator('[data-demo="sortable-table"]');

  /** How the demo table is laid out: the table's display, the cell labels' display, and each body row's box. */
  const layout = (page: Page) => demo(page).evaluate((root) => {
    const table = root.querySelector('table') as HTMLElement;
    const rows = Array.from(root.querySelectorAll('tbody tr')).map((tr) => {
      const r = tr.getBoundingClientRect();
      const cells = Array.from(tr.children).map((c) => Math.round(c.getBoundingClientRect().top));
      return { top: r.top, bottom: r.bottom, cellTops: cells };
    });
    // Every cell of the first card: its label's box and its value's box (the cell's content after the label).
    const firstCells = Array.from(root.querySelectorAll('tbody tr:first-child td')).map((cell) => {
      const label = cell.querySelector('.ui-table__cell-label') as HTMLElement;
      const valueRange = document.createRange();
      valueRange.selectNodeContents(cell);
      valueRange.setStartAfter(label);
      const l = label.getBoundingClientRect();
      const v = valueRange.getBoundingClientRect();
      return { label: label.textContent, labelBottom: l.bottom, labelLeft: l.left, valueTop: v.top, valueLeft: v.left, cellLeft: cell.getBoundingClientRect().left };
    });
    const label = root.querySelector('td .ui-table__cell-label') as HTMLElement;
    const caption = root.querySelector('caption') as HTMLElement;
    const wrap = root.querySelector('.ui-table-wrap') as HTMLElement;
    const captionText = document.createRange();
    captionText.selectNodeContents(caption);
    return {
      table: getComputedStyle(table).display,
      label: getComputedStyle(label).display,
      firstCells,
      captionWidth: caption.getBoundingClientRect().width,
      captionLines: new Set(Array.from(captionText.getClientRects()).map((r) => Math.round(r.top))).size,
      wrapContentWidth: wrap.clientWidth - parseFloat(getComputedStyle(wrap).paddingLeft) - parseFloat(getComputedStyle(wrap).paddingRight),
      rows,
      width: Math.round(root.getBoundingClientRect().width),
    };
  });

  test('becomes cards in a 600 px container and stays a table at 800 px, whatever the window', async ({ page }) => {
    await openKit(page);
    expect(page.viewportSize()?.width).toBe(1280);
    await demo(page).evaluate((el) => { (el as HTMLElement).style.inlineSize = '600px'; });
    const cards = await layout(page);
    expect(cards.width).toBe(600);
    expect(cards.table).toBe('block');
    expect(cards.label).toBe('block');
    expect(cards.firstCells.map((c) => c.label)).toEqual(['Stage', 'Opened', 'Evidence files']);
    for (const c of cards.firstCells) {
      expect(c.labelBottom, `${c.label}: the label sits above its value`).toBeLessThanOrEqual(c.valueTop + 1);
      expect(Math.abs(c.labelLeft - c.cellLeft), `${c.label}: the label starts at the cell's start`).toBeLessThanOrEqual(1);
      expect(Math.abs(c.valueLeft - c.cellLeft), `${c.label}: the value starts at the cell's start`).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(cards.captionWidth - cards.wrapContentWidth), 'the visible caption spans the wrapper').toBeLessThanOrEqual(1);
    expect(cards.captionLines, 'the two-word caption stays on one line').toBe(1);
    for (const [i, row] of cards.rows.entries()) {
      expect(new Set(row.cellTops).size, `card ${i}: its cells stack`).toBe(row.cellTops.length);
      if (i > 0) expect(row.top, `card ${i} is below card ${i - 1}`).toBeGreaterThanOrEqual(cards.rows[i - 1].bottom);
    }
    await expect(demo(page).getByRole('button', { name: 'Opened', exact: true })).toBeVisible();
    await expect(demo(page).getByRole('columnheader', { name: 'Stage', exact: true })).toHaveCSS('position', 'absolute');

    await demo(page).evaluate((el) => { (el as HTMLElement).style.inlineSize = '800px'; });
    const table = await layout(page);
    expect(table.width).toBe(800);
    expect(table.table).toBe('table');
    expect(table.label).toBe('none');
    for (const row of table.rows) expect(new Set(row.cellTops).size, 'a row\'s cells share a line').toBe(1);
  });

  for (const viewport of [VIEWPORTS[0], VIEWPORTS[1]]) {
    test(`a sort click moves the rows, announces in the column's words, and keeps focus in view, at ${viewport.width} px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await openKit(page);
      const status = demo(page).getByRole('status');
      const firstRowHeader = demo(page).locator('tbody tr').first().getByRole('rowheader');
      await expect(status).toHaveText('');
      await expect(demo(page).locator('[aria-sort]')).toHaveCount(0);
      // A probe on one row's element: React must move that element, not rebuild it.
      await demo(page).locator('tbody tr', { hasText: 'Consent does not cover' }).evaluate((tr) => { (tr as unknown as { kitProbe: number }).kitProbe = 1; });

      const opened = demo(page).getByRole('button', { name: 'Opened', exact: true });
      await opened.click();
      await expect(status).toHaveText('Sorted by Opened, earliest first');
      await expect(firstRowHeader).toHaveText('Bias check on the triage model is pending');
      await expect(demo(page).locator('[aria-sort]')).toHaveCount(1);
      await expect(demo(page).getByRole('columnheader', { name: 'Opened', exact: true })).toHaveAttribute('aria-sort', 'ascending');
      await expect(opened).toBeFocused();
      await expect(opened).toBeInViewport({ ratio: 1 });

      await page.keyboard.press('Enter');
      await expect(status).toHaveText('Sorted by Opened, latest first');
      await expect(firstRowHeader).toHaveText('Appeal route for patients is unclear');
      await expect(demo(page).getByRole('columnheader', { name: 'Opened', exact: true })).toHaveAttribute('aria-sort', 'descending');

      await demo(page).getByRole('button', { name: 'Evidence files', exact: true }).click();
      await expect(status).toHaveText('Sorted by Evidence files, lowest first');
      await expect(firstRowHeader).toHaveText('Retention period is not set');
      await expect(demo(page).locator('[aria-sort]')).toHaveCount(1);
      expect(await demo(page).locator('tbody tr', { hasText: 'Consent does not cover' }).evaluate((tr) => (tr as unknown as { kitProbe?: number }).kitProbe)).toBe(1);
      await expect(demo(page).getByRole('button', { name: 'Evidence files', exact: true })).toBeInViewport({ ratio: 1 });

      await settleHover(page);
      await inEachTheme(page, (theme) => expectNoSeriousA11yViolations(page, `${KIT} table sorted, ${theme}, ${viewport.width} px`));
    });
  }

  test('the sort arrows are drawn in both themes and forced colours: two-way arrows unsorted, one arrow sorted, turned when descending', async ({ page }) => {
    await openKit(page);
    const header = (name: string) => demo(page).getByRole('columnheader', { name, exact: true });
    const shown = (name: string) => header(name).locator('svg').evaluateAll((svgs) => svgs.map((s) => ({
      shown: getComputedStyle(s).display !== 'none', rotate: getComputedStyle(s).rotate,
    })));
    await demo(page).getByRole('button', { name: 'Opened', exact: true }).click();
    await demo(page).getByRole('button', { name: 'Opened', exact: true }).click();
    await expect(header('Opened')).toHaveAttribute('aria-sort', 'descending');
    const check = async (mode: string) => {
      expect((await shown('Finding')).map((s) => s.shown), `${mode}: unsorted shows the two-way arrows`).toEqual([true, false]);
      const opened = await shown('Opened');
      expect(opened.map((s) => s.shown), `${mode}: sorted shows the one arrow`).toEqual([false, true]);
      expect(opened[1].rotate, `${mode}: descending turns the arrow`).toBe('180deg');
      const painted = await shapesVisible(page, '[data-demo="sortable-table"] th');
      expect(painted.count).toBeGreaterThan(0);
      expect(painted.invisible, mode).toEqual([]);
    };
    await inEachTheme(page, (theme) => check(theme));
    await withForcedColors(page, () => check('forced colours'));
  });

  test('the region is a keyboard stop named by its caption; a hidden caption still names it; no rows shows the empty words', async ({ page }) => {
    await openKit(page);
    await expect(page.getByRole('region', { name: 'Sample findings', exact: true })).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('region', { name: 'Sample members', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Sample members', exact: true }).locator('caption')).toHaveCSS('position', 'absolute');
    await expect(section(page, 'table').locator('.ui-table__empty')).toHaveText('No invitations are waiting. Invited people appear here until they accept.');
  });
});

test.describe('TabNav', () => {
  const nav = (page: Page) => page.getByRole('navigation', { name: 'Sample findings', exact: true });

  /** Each link's underline: the ::after box's border and where it sits against the link. */
  const underlines = (page: Page, name: string) => page.getByRole('navigation', { name, exact: true }).getByRole('link').evaluateAll((links) => links.map((a) => {
    const s = getComputedStyle(a, '::after');
    return {
      current: a.getAttribute('aria-current'),
      drawn: s.content !== 'none' && s.borderBottomStyle === 'solid' && parseFloat(s.borderBottomWidth) > 0,
      width: s.borderBottomWidth, bottom: s.bottom, left: s.left, right: s.right, position: s.position,
      // The pseudo-element's used width and height, and its owner's: its box is read from its computed size, and its
      // place from `bottom: 0` against an owner that is `position: relative` (so the owner is its containing block).
      usedWidth: parseFloat(s.width), usedHeight: parseFloat(s.height), linkWidth: a.getBoundingClientRect().width,
      linkPosition: getComputedStyle(a).position,
      colour: s.borderBottomColor, ground: getComputedStyle(document.body).backgroundColor,
    };
  }));

  test('links whose text carries the count; aria-current="page" on the current one only', async ({ page }) => {
    await openKit(page);
    await expect(nav(page).getByRole('link')).toHaveText(['Open 13', 'Closed 4', 'Accepted risk']);
    await expect(nav(page).locator('[aria-current]')).toHaveCount(1);
    await expect(nav(page).getByRole('link', { name: 'Open 13', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).locator('[role="tab"], [role="tablist"], [aria-selected]')).toHaveCount(0);
  });

  test('the current tab alone has a 3 px underline along its bottom edge, in normal and forced colours', async ({ page }) => {
    await openKit(page);
    const check = async (mode: string) => {
      const lines = await underlines(page, 'Sample findings');
      expect(lines.filter((l) => l.drawn).map((l) => l.current), mode).toEqual(['page']);
      const line = lines.find((l) => l.drawn);
      expect(line, mode).toMatchObject({ width: '3px', bottom: '0px', left: '0px', right: '0px', position: 'absolute', linkPosition: 'relative' });
      expect(Math.abs((line?.usedWidth ?? 0) - (line?.linkWidth ?? -9)), `${mode}: the underline spans the tab`).toBeLessThanOrEqual(1);
      // Border-box (app/globals.css), so a used height of 3 px is the border alone; with bottom 0 against the
      // relatively positioned link, that border's bottom edge is the link's bottom edge.
      expect(line?.usedHeight, `${mode}: the underline is its 3 px border alone`).toBe(3);
      expect(line?.colour, mode).not.toBe(line?.ground);
    };
    await check('normal colours');
    await withForcedColors(page, () => check('forced colours'));
  });

  test('Tab moves through the tabs from left to right', async ({ page }) => {
    await openKit(page);
    const links = nav(page).getByRole('link');
    await links.first().focus();
    const xs: number[] = [(await boxOf(links.first(), 'first tab')).x];
    for (let i = 1; i < 3; i += 1) {
      await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
      xs.push((await boxOf(links.nth(i), `tab ${i + 1}`)).x);
    }
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(new Set(xs).size).toBe(3);
  });

  test('the count is drawn apart from its label, "Open 13", not "Open13"', async ({ page }) => {
    await openKit(page);
    const gap = await nav(page).getByRole('link').first().evaluate((a) => {
      const words = document.createRange();
      words.selectNodeContents(a.firstChild as Node);
      const count = a.querySelector('.ui-tabnav__count') as Element;
      return count.getBoundingClientRect().left - words.getBoundingClientRect().right;
    });
    expect(gap).toBeGreaterThanOrEqual(3);
  });

  test('at 320 px the current tab is brought into view inside its row, and the page does not move', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const list = page.getByRole('navigation', { name: 'Sample guidance', exact: true }).getByRole('list');
    const current = list.getByRole('link', { name: 'In processing', exact: true });
    await expect(current).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => list.evaluate((ul) => ul.scrollLeft), 'the row scrolled itself').toBeGreaterThan(0);
    const row = await boxOf(list, 'the row');
    const tab = await boxOf(current, 'the current tab');
    expect(tab.x, 'the current tab starts inside the row').toBeGreaterThanOrEqual(row.x);
    expect(tab.x + tab.width, 'the current tab ends inside the row').toBeLessThanOrEqual(row.x + row.width);
    expect(await page.evaluate(() => window.scrollY), 'the page did not scroll').toBe(0);
  });

  test('at 320 px the tabs beside the current one show their first and last letters at the row\'s edges', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const list = page.getByRole('navigation', { name: 'Sample guidance', exact: true }).getByRole('list');
    // The row looks at its current tab once more when the fonts are in: measure after that.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await expect.poll(() => list.evaluate((ul) => ul.scrollLeft), 'the row scrolled itself').toBeGreaterThan(0);
    // There is no fade at the row's edges, so the words of the tab cut off at an edge are what says that tabs follow.
    // The words are measured, not the link's box: a link begins and ends with its own blank padding.
    const edges = await list.evaluate((ul) => {
      const links = Array.from(ul.querySelectorAll('a'));
      const at = links.findIndex((a) => a.getAttribute('aria-current') === 'page');
      const words = (a: Element) => {
        const range = document.createRange();
        range.selectNodeContents(a);
        return range.getBoundingClientRect();
      };
      const rowBox = ul.getBoundingClientRect();
      const previous = links[at - 1];
      const next = links[at + 1];
      return {
        tabs: [previous.textContent, links[at].textContent, next.textContent],
        // How far inside the row's end the next tab's words start, and inside its start the previous tab's words end.
        nextWordsInside: Math.round(rowBox.right - words(next).left),
        previousWordsInside: Math.round(words(previous).right - rowBox.left),
        previousWhole: previous.getBoundingClientRect().left >= rowBox.left,
      };
    });
    expect(edges.tabs).toEqual(['Pre-processing', 'In processing', 'Post-processing']);
    expect(edges.nextWordsInside, 'the next tab\'s words start at least 8 px inside the row\'s end').toBeGreaterThanOrEqual(8);
    expect(edges.previousWhole || edges.previousWordsInside >= 8,
      `the previous tab is wholly in view, or its words end at least 8 px inside the row's start (${edges.previousWordsInside} px)`).toBe(true);
  });

  test('at 320 px a row of tabs that does not fit scrolls inside itself, on one line, and the page does not', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const list = page.getByRole('navigation', { name: 'Sample guidance', exact: true }).getByRole('list');
    expect(await list.evaluate((ul) => ul.scrollWidth > ul.clientWidth)).toBe(true);
    const tops = new Set(await list.getByRole('link').evaluateAll((as) => as.map((a) => Math.round(a.getBoundingClientRect().top))));
    expect(tops.size).toBe(1);
    await expectNoHorizontalScroll(page);
    // By keyboard: from the row's first tab, Tab along the row to the last. Every stop is checked, not the last alone:
    // Chrome's own scroll on focus brings in a tab that is wholly hidden and leaves one that already shows a strip of
    // itself where it is (measured on this row in Chrome 157, when its scroll padding was 16 px: the third tab stayed
    // with 43 px showing and the last with 70 px of its 207), so the row itself brings the focused tab in.
    const links = list.getByRole('link');
    /** How far tab `i` runs past each end of the row, in whole pixels: both 0 when it is wholly in view inside the row. */
    const pastRow = (i: number) => links.nth(i).evaluate((a) => {
      const box = a.getBoundingClientRect();
      const rowBox = (a.closest('ul') as Element).getBoundingClientRect();
      return { start: Math.max(0, Math.round(rowBox.left - box.left)), end: Math.max(0, Math.round(box.right - rowBox.right)) };
    });
    await links.first().focus();
    await scrollSettled(page);
    for (let i = 1; i < 5; i += 1) {
      await page.keyboard.press('Tab');
      await expect(links.nth(i)).toBeFocused();
      expect(await pastRow(i), `tab ${i + 1}, reached by Tab, is wholly inside the row`).toEqual({ start: 0, end: 0 });
    }
    await scrollSettled(page);
    const last = list.getByRole('link', { name: 'Cross-cutting questions', exact: true });
    await expect(last).toBeFocused();
    await expect(last).toBeInViewport({ ratio: 1 });
    const ring = await last.evaluate((a) => {
      const s = getComputedStyle(a);
      const box = a.getBoundingClientRect();
      const rowBox = (a.closest('ul') as Element).getBoundingClientRect();
      // The ring is drawn inside the link (a negative offset as deep as the ring), so its outer edge is the link's box.
      const outset = parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset);
      return { focusVisible: a.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth, outset,
        inside: box.left - outset >= rowBox.left - 0.5 && box.right + outset <= rowBox.right + 0.5 };
    });
    expect(ring).toEqual({ focusVisible: true, style: 'solid', width: '3px', outset: 0, inside: true });
    // And back along the row with Shift+Tab, to the first.
    for (let i = 3; i >= 0; i -= 1) {
      await page.keyboard.press('Shift+Tab');
      await expect(links.nth(i)).toBeFocused();
      expect(await pastRow(i), `tab ${i + 1}, reached by Shift+Tab, is wholly inside the row`).toEqual({ start: 0, end: 0 });
    }
    expect(await page.evaluate(() => window.scrollX), 'the page did not scroll sideways').toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test('at 320 px a pointer press on a partly shown tab leaves the row where it is, and the click reaches that tab', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const list = page.getByRole('navigation', { name: 'Sample guidance', exact: true }).getByRole('list');
    await list.scrollIntoViewIfNeeded();
    await scrollSettled(page);
    // The row's own look at its current tab runs once more when the fonts are in: wait for it before placing the row.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    // The fourth tab runs 60 px past the row's end, and the press is 6 px inside that end. A row that moved on the press
    // to bring the tab in would put the next tab under the pointer before the release (seen without the keyboard-only
    // rule: this case failed on a row that had moved).
    const at = await list.evaluate((ul) => {
      const tab = ul.querySelectorAll('a')[3];
      ul.scrollLeft += tab.getBoundingClientRect().right - ul.getBoundingClientRect().right - 60;
      const rowBox = ul.getBoundingClientRect();
      const box = tab.getBoundingClientRect();
      const x = rowBox.right - 6;
      const y = box.top + box.height / 2;
      return { x, y, left: ul.scrollLeft, past: Math.round(box.right - rowBox.right), under: document.elementFromPoint(x, y)?.textContent };
    });
    expect({ past: at.past, under: at.under }, 'the fourth tab is partly shown, under the pointer').toEqual({ past: 60, under: 'Post-processing' });
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    expect(await list.evaluate((ul) => ul.scrollLeft), 'the press did not move the row').toBe(at.left);
    await page.mouse.up();
    await expect(page).toHaveURL(/\?guide=post$/);
  });
});

test.describe('Breadcrumb', () => {
  test('aria-current on the last item only; the separators sit between the items, drawn in both themes and forced colours', async ({ page }) => {
    await openKit(page);
    const crumb = section(page, 'breadcrumb').getByRole('navigation', { name: 'Breadcrumb' }).first();
    const items = crumb.getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(crumb.locator('[aria-current]')).toHaveCount(1);
    await expect(items.last().locator('[aria-current="page"]')).toHaveText('Pre-processing');
    const boxes = [await boxOf(items.nth(0), 'item 1'), await boxOf(items.nth(1), 'item 2'), await boxOf(items.nth(2), 'item 3')];
    for (let i = 1; i < 3; i += 1) {
      expect(boxes[i].x, `item ${i + 1} follows item ${i} on the line`).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width - 1);
      expect(Math.abs(boxes[i].y - boxes[0].y), 'one line at 1280 px').toBeLessThanOrEqual(2);
    }
    const separators = () => items.evaluateAll((lis) => lis.map((li) => {
      const s = getComputedStyle(li, '::before');
      const link = li.querySelector('a, span') as Element;
      return {
        content: s.content, top: s.borderTopWidth, end: s.borderRightWidth, colour: s.borderTopColor, rotate: s.rotate,
        // The separator is the item's first box: the item's text starts after it.
        gap: link.getBoundingClientRect().left - li.getBoundingClientRect().left,
        ground: getComputedStyle(document.body).backgroundColor,
      };
    }));
    const check = async (mode: string) => {
      const seps = await separators();
      expect(seps[0].content, `${mode}: none before the first item`).toBe('none');
      for (const s of seps.slice(1)) {
        expect(s.content, mode).toBe('""');
        expect([s.top, s.end, s.rotate], mode).toEqual(['2px', '2px', '45deg']);
        expect(s.colour, mode).not.toBe(s.ground);
        expect(s.gap, `${mode}: the separator takes room before the item's words`).toBeGreaterThan(8);
      }
      expect(await crumb.textContent(), `${mode}: no separator character`).toBe('ProjectsMaternal health triagePre-processing');
    };
    await inEachTheme(page, (theme) => check(theme));
    await withForcedColors(page, () => check('forced colours'));
  });

  test('a long organisation name wraps at 320 px with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const crumb = section(page, 'breadcrumb').getByRole('navigation', { name: 'Breadcrumb' }).nth(1);
    const link = crumb.getByRole('link');
    const box = await boxOf(link, 'the long name');
    expect(box.height, 'the long name takes more than one line').toBeGreaterThan(30);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('PageHeader', () => {
  test('the page\'s one h1 is the header\'s title: breadcrumb above it, the code after its words, then the lead and the action', async ({ page }) => {
    await openKit(page);
    const header = page.locator('main > .ui-page-header');
    await expect(header).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(header.getByRole('heading', { level: 1, name: 'UI kit', exact: true })).toBeVisible();
    const crumb = await boxOf(header.getByRole('navigation', { name: 'Breadcrumb' }), 'breadcrumb');
    const title = await boxOf(header.getByRole('heading', { level: 1 }), 'title');
    const code = await boxOf(header.locator('.ui-page-header__code'), 'code');
    const lead = await boxOf(header.locator('.ui-page-header__lead'), 'lead');
    const action = await boxOf(header.getByRole('link', { name: 'Go to the table' }), 'action');
    expect(crumb.y + crumb.height).toBeLessThanOrEqual(title.y + 1);
    expect(code.x, 'the code follows the title on its line').toBeGreaterThanOrEqual(title.x + title.width - 1);
    expect(code.y).toBeLessThan(title.y + title.height);
    expect(lead.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(action.y).toBeGreaterThanOrEqual(lead.y + lead.height - 1);
    await expect(header.locator('.ui-page-header__code')).toHaveText('DEV-UI');
  });
});

test.describe('ItemPlate', () => {
  const plates = (page: Page) => section(page, 'item-plate').locator('.ui-plate');

  test('words, then code, then the mark and state; the current plate alone has the thicker border and the pin, in normal and forced colours', async ({ page }) => {
    await openKit(page);
    const current = plates(page).nth(1);
    await expect(section(page, 'item-plate').locator('[aria-current]')).toHaveCount(1);
    await expect(current.getByRole('link', { name: 'A data protection impact assessment exists', exact: true })).toHaveAttribute('aria-current', 'step');
    const first = plates(page).first();
    const [title, code, mark, state] = [
      await boxOf(first.locator('.ui-plate__title'), 'title'), await boxOf(first.locator('.ui-plate__code'), 'code'),
      await boxOf(first.locator('.ui-plate__mark'), 'mark'), await boxOf(first.locator('.ui-plate__state'), 'state'),
    ];
    expect(code.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(mark.y).toBeGreaterThanOrEqual(code.y + code.height - 1);
    expect(Math.abs(state.y + state.height / 2 - (mark.y + mark.height / 2)), 'the state shares the mark\'s line').toBeLessThanOrEqual(4);
    expect(state.x).toBeGreaterThan(mark.x + mark.width);

    const check = async (mode: string) => {
      const widths = await plates(page).evaluateAll((els) => els.map((el) => ({ current: el.classList.contains('ui-plate--current'), width: parseFloat(getComputedStyle(el).borderTopWidth) })));
      expect(widths.filter((w) => w.current).map((w) => w.width), mode).toEqual([2]);
      expect(widths.filter((w) => !w.current).every((w) => w.width === 1), `${mode}: ${JSON.stringify(widths)}`).toBe(true);
      const pin = current.locator('.ui-plate__pin');
      await expect(pin).toHaveText('You are here');
      const plateBox = await boxOf(current, 'current plate');
      const pinBox = await boxOf(pin, 'pin');
      const stateBox = await boxOf(current.locator('.ui-plate__state'), 'state');
      expect(pinBox.y, `${mode}: the pin is the plate's last line`).toBeGreaterThanOrEqual(stateBox.y + stateBox.height - 1);
      expect(pinBox.x).toBeGreaterThanOrEqual(plateBox.x);
      expect(pinBox.y + pinBox.height).toBeLessThanOrEqual(plateBox.y + plateBox.height);
      expect((await shapesVisible(page, '[data-kit-section="item-plate"] .ui-mark')).invisible, mode).toEqual([]);
    };
    await check('normal colours');
    await withForcedColors(page, () => check('forced colours'));
    await expect(plates(page).locator('.ui-plate__pin')).toHaveCount(1);
  });

  test('the pin is in the action text colour, outside the mark; the mark keeps the mark colour, in both themes', async ({ page }) => {
    await openKit(page);
    await inEachTheme(page, async (theme) => {
      const colours = await section(page, 'item-plate').evaluate((sec) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-action-text)';
        const mark = document.createElement('span');
        mark.style.color = 'var(--color-mark)';
        sec.append(probe, mark);
        const want = { action: getComputedStyle(probe).color, mark: getComputedStyle(mark).color };
        probe.remove();
        mark.remove();
        const pin = sec.querySelector('.ui-plate__pin') as Element;
        const shapes = Array.from(sec.querySelectorAll('.ui-mark, .ui-mark__shape, .ui-mark__shape *')).map((el) => getComputedStyle(el).color);
        return { want, pin: getComputedStyle(pin).color, inMark: pin.closest('.ui-mark') !== null, shapes };
      });
      expect(colours.pin, theme).toBe(colours.want.action);
      expect(colours.inMark).toBe(false);
      expect(colours.shapes.length, theme).toBeGreaterThan(4);
      expect(new Set(colours.shapes), theme).toEqual(new Set([colours.want.mark]));
    });
  });

  test('a linked plate is its link\'s target as a whole: its state line hits the link, a point just outside does not', async ({ page }) => {
    await openKit(page);
    const plate = plates(page).first();
    await plate.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await scrollSettled(page);
    const hits = await plate.evaluate((el) => {
      const link = el.querySelector('.ui-plate__link');
      const state = (el.querySelector('.ui-plate__state') as Element).getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const at = (x: number, y: number) => document.elementFromPoint(x, y);
      const inside = at(state.left + state.width / 2, state.top + state.height / 2);
      const below = at(box.left + box.width / 2, box.bottom + 3);
      return { inside: inside === link, outside: below !== null && below.closest('.ui-plate__link') !== link };
    });
    expect(hits).toEqual({ inside: true, outside: true });
  });

  test('a long name wraps at 320 px inside its plate with no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const long = plates(page).nth(3);
    const box = await boxOf(long, 'the long plate');
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect((await boxOf(long.locator('.ui-plate__title'), 'its title')).height).toBeGreaterThan(48);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Stepper', () => {
  test('done steps say "(done)" with no tick; the current step says so; each disc keeps its state in forced colours', async ({ page }) => {
    await openKit(page);
    const stepper = page.getByRole('list', { name: 'Sample stage documents', exact: true });
    await expect(stepper.getByRole('link', { name: 'Data card (done)', exact: true })).toBeVisible();
    await expect(stepper.getByRole('link', { name: 'Model card (done)', exact: true })).toBeVisible();
    await expect(stepper.locator('[aria-current]')).toHaveCount(1);
    await expect(stepper.getByRole('link', { name: 'Mitigation plan', exact: true })).toHaveAttribute('aria-current', 'step');
    await expect(stepper.getByText('(done)').first()).toHaveCSS('position', 'absolute');
    await expect(section(page, 'stepper').locator('svg, progress, [role="progressbar"], .ui-mark')).toHaveCount(0);
    const discs = () => stepper.locator('.ui-stepper__disc').evaluateAll((els) => els.map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { width: s.borderTopWidth, style: s.borderTopStyle, colour: s.borderTopColor, size: [Math.round(r.width), Math.round(r.height)], ground: getComputedStyle(document.body).backgroundColor };
    }));
    const check = async (mode: string) => {
      const d = await discs();
      expect(d.map((x) => x.width), mode).toEqual(['8px', '8px', '4px', '2px', '2px']);
      for (const x of d) {
        expect(x.style, mode).toBe('solid');
        expect(x.colour, mode).not.toBe(x.ground);
        expect(x.size, mode).toEqual([16, 16]);
      }
    };
    await inEachTheme(page, (theme) => check(theme));
    await withForcedColors(page, () => check('forced colours'));
  });

  test('at 320 px the steps wrap with no sideways scroll, each disc beside its name', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await openKit(page);
    const steps = page.getByRole('list', { name: 'Sample stage documents', exact: true }).getByRole('listitem');
    const tops = new Set(await steps.evaluateAll((lis) => lis.map((li) => Math.round(li.getBoundingClientRect().top))));
    expect(tops.size).toBeGreaterThan(1);
    for (const step of await steps.all()) {
      const disc = await boxOf(step.locator('.ui-stepper__disc'), 'disc');
      const label = await boxOf(step.locator('.ui-stepper__label'), 'label');
      expect(label.x).toBeGreaterThan(disc.x + disc.width);
      expect(Math.abs(label.y + label.height / 2 - (disc.y + disc.height / 2))).toBeLessThanOrEqual(3);
    }
    await expectNoHorizontalScroll(page);
  });
});

test.describe('focus rings of the structure components', () => {
  test('a sort button, a tab, a breadcrumb link, a plate link and a step link each draw the 3 px ring by keyboard, unclipped', async ({ page }) => {
    await openKit(page);
    const targets: Array<[string, Locator]> = [
      ['sort button', section(page, 'table').getByRole('button', { name: 'Finding', exact: true })],
      ['tab', page.getByRole('navigation', { name: 'Sample findings', exact: true }).getByRole('link', { name: 'Open 13', exact: true })],
      ['breadcrumb link', section(page, 'breadcrumb').getByRole('link', { name: 'Projects', exact: true }).first()],
      ['plate link', plateLink(page)],
      ['step link', page.getByRole('link', { name: 'Data card (done)', exact: true })],
    ];
    for (const [what, target] of targets) {
      // Keyboard focus: from the target back one stop and forward again, so :focus-visible applies.
      await target.focus();
      await scrollSettled(page);
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await scrollSettled(page);
      await expect(target, what).toBeFocused();
      const ring = await target.evaluate((el) => {
        const s = getComputedStyle(el);
        const outset = Math.max(0, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
        const box = el.getBoundingClientRect();
        const outer = { left: box.left - outset, right: box.right + outset, top: box.top - outset, bottom: box.bottom + outset };
        // The visible area: the viewport, cut by every ancestor that clips its overflow.
        let area = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        for (let a = el.parentElement; a !== null; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const r = a.getBoundingClientRect();
          area = { left: Math.max(area.left, r.left), top: Math.max(area.top, r.top), right: Math.min(area.right, r.right), bottom: Math.min(area.bottom, r.bottom) };
        }
        return {
          focusVisible: el.matches(':focus-visible'), style: s.outlineStyle, width: s.outlineWidth,
          inside: outer.left >= area.left - 0.5 && outer.right <= area.right + 0.5 && outer.top >= area.top - 0.5 && outer.bottom <= area.bottom + 0.5,
        };
      });
      expect(ring, what).toEqual({ focusVisible: true, style: 'solid', width: '3px', inside: true });
    }
  });
});
