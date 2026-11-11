import { expect, test, type Page } from '@playwright/test';
import { actAsSeat, fixtureOrgSlug } from './helpers/session';

/**
 * v0.6.1 U12 rows (a), (b), (d) and (e): four defects that were broken for people on v0.6.0, each checked at the
 * width and theme where it failed. Row (c) (the members and accounts tables) has its own diagnosis.
 */

/** WCAG 2 contrast of one element's `color` or background colour against another element's background (alpha is composited). */
async function contrastOf(page: Page, fgSelector: string, bgSelector: string, fgProperty: 'color' | 'backgroundColor'): Promise<number> {
  return page.evaluate(([fgSel, bgSel, prop]) => {
    const parse = (s: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(s);
      if (!m) throw new Error(`not a colour: ${s}`);
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = ([r, g, b]: number[]) => {
      const c = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const bgEl = document.querySelector(bgSel) as HTMLElement;
    const fgEl = document.querySelector(fgSel) as HTMLElement;
    const bg = parse(getComputedStyle(bgEl).backgroundColor);
    const fg = parse(getComputedStyle(fgEl)[prop as 'color' | 'backgroundColor']);
    const mixed = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  }, [fgSelector, bgSelector, fgProperty] as const);
}

test('U12 (a): at 390 wide in the dark theme, the menu button bars stand out from the button by at least 3:1', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await actAsSeat(page, 'owner');
  await page.goto(`/orgs/${fixtureOrgSlug()}/dashboard`);
  const toggle = page.locator('.sidebar-toggle');
  await expect(toggle).toBeVisible();
  expect(await page.locator('.sidebar-toggle__bar').count()).toBeGreaterThan(0);
  expect(await contrastOf(page, '.sidebar-toggle__bar', '.sidebar-toggle', 'backgroundColor')).toBeGreaterThanOrEqual(3);
});

