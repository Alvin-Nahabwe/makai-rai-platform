import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoSeriousA11yViolations, settleHover } from './helpers/a11y';
import { expectNoHorizontalScroll } from './helpers/reflow';
import { expectTargetsAtLeast24px } from './helpers/targetSize';

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

/** Runs `check` in each theme, by the operating system's preference the tokens follow (app/globals.css). */
async function inEachTheme(page: Page, check: (theme: (typeof THEMES)[number]) => Promise<void>): Promise<void> {
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await check(theme);
  }
}

/** Runs `check` with forced colours on (Windows high contrast), then turns them off again. */
async function withForcedColors(page: Page, check: () => Promise<void>): Promise<void> {
  await page.emulateMedia({ forcedColors: 'active' });
  try {
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

/** A kit section by its id (`data-kit-section`). */
const section = (page: Page, id: string) => page.locator(`[data-kit-section="${id}"]`);

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
});

test.describe('Icon', () => {
  test('all 28 icons draw, hidden from assistive technology, beside their names', async ({ page }) => {
    await openKit(page);
    const icons = section(page, 'icons').locator('[data-icon] svg.ui-icon');
    await expect(icons).toHaveCount(28);
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
    await expect(section(page, 'route-row').locator('.ui-route-row__tally').first()).toHaveText(/^\d+ done \(2 with no evidence attached\), /);
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
    await expect(invalid).toHaveAccessibleDescription("As it appears on your letterhead. Error: Enter the organisation's name.");
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
    await expect(done).toHaveAccessibleDescription('The expected practice is in place.');
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
    await page.getByText('Some of the expected practice is in place.').click({ force: true });
    await expect(section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true }).getByRole('radio', { name: 'Partly', exact: true })).toBeChecked();
  });

  test('the chosen card is the only one with a border, and its radio stays drawn, in normal and in forced colours', async ({ page }) => {
    await openKit(page);
    const group = section(page, 'radio-cards').getByRole('group', { name: 'Status', exact: true });
    await group.getByRole('radio', { name: 'Not yet', exact: true }).check();
    const expectSelection = async (mode: string) => {
      const cards = await drawnBorders(group.locator('.ui-radio-card'), ':has(:checked)');
      expect(cards.filter((c) => c.marked), mode).toHaveLength(1);
      expect(cards.filter((c) => c.drawn).map((c) => c.marked), `${mode}, borders drawn: ${JSON.stringify(cards.filter((c) => c.drawn))}`).toEqual([true]);
      const dot = await group.locator('.ui-radio-card__input:checked').evaluate((input) => {
        const s = getComputedStyle(input, '::before');
        return { width: parseFloat(s.borderTopWidth), colour: s.borderTopColor, ground: getComputedStyle(document.body).backgroundColor };
      });
      expect(dot.width, `${mode}, the checked radio's dot`).toBeGreaterThan(0);
      expect(dot.colour, `${mode}, the checked radio's dot`).not.toBe(dot.ground);
    };
    await expectSelection('normal colours');
    await withForcedColors(page, () => expectSelection('forced colours'));
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
    await expect(field.getByLabel('Day', { exact: true })).toHaveAccessibleDescription('Error: Enter a date that exists. February 2026 has 28 days.');
    await expect(page.locator('#kit-date-error-message')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('ErrorSummary', () => {
  test('each link goes to a field on the page, and the summary takes focus when a script gives it', async ({ page }) => {
    await openKit(page);
    const summary = section(page, 'error-summary').locator('.ui-error-summary');
    for (const link of await summary.getByRole('link').all()) {
      const href = await link.getAttribute('href');
      expect(href).toMatch(/^#/);
      await expect(page.locator(href as string)).toHaveCount(1);
    }
    await summary.focus();
    await expect(summary).toBeFocused();
    expect(await summary.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  });
});
