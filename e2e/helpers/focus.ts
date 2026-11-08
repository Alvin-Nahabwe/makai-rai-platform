import type { Page } from '@playwright/test';

/**
 * NFR-A11Y-02, WCAG 2.2 SC 2.4.7 (Focus Visible) and SC 2.4.11 (Focus Not Obscured): the element that
 * has focus now
 *   - shows a focus indicator: a computed outline whose style is not `none`, whose width is at least 2 px and whose
 *     colour is not transparent, or a box shadow that is visible (a colour with alpha above 0 and a size), and the
 *     indicator differs from the element's own look without focus, so an outline it always has does not count;
 *   - lies inside the viewport; and
 *   - is not covered: `document.elementFromPoint` at the centre of its box returns the element or
 *     something inside it, so a sticky header or a save bar over it is caught.
 * The caller moves focus first (a `Tab` press, or `locator.focus()`); this only inspects. To compare with the
 * unfocused look it blurs the element, reads its style and focuses it again, so the element's blur and focus handlers
 * run once more. The failure says which of the three failed and describes the element by tag, id and name, never by
 * its text.
 */
export async function expectFocusVisibleAndUncovered(page: Page): Promise<void> {
  const problem = await page.evaluate((): string | null => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return 'nothing is focused';
    const name = el.getAttribute('name');
    const what = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${name ? `[name=${name}]` : ''}`;

    /** The alpha of a computed colour; 1 for a form it does not know, so an unknown colour is not called invisible. */
    const alphaOf = (color: string): number => {
      if (color === 'transparent') return 0;
      const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
      if (rgb) {
        const parts = rgb[1].split(/[,/\s]+/).filter(Boolean);
        return parts.length >= 4 ? Number(parts[3]) : 1;
      }
      const slash = /\/\s*([\d.]+%?)\s*\)$/.exec(color);
      if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : Number(slash[1]);
      return 1;
    };
    const look = (e: Element) => {
      const cs = getComputedStyle(e);
      return { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, boxShadow: cs.boxShadow };
    };
    const outlineShows = (l: ReturnType<typeof look>) => l.outlineStyle !== 'none' && parseFloat(l.outlineWidth) >= 2 && alphaOf(l.outlineColor) > 0;
    const shadowShows = (l: ReturnType<typeof look>) =>
      l.boxShadow !== 'none' &&
      l.boxShadow.split(/,(?![^(]*\))/).some((one) => {
        const color = /(rgba?\([^)]*\)|color\([^)]*\)|transparent)/.exec(one)?.[1] ?? '';
        const lengths = (one.replace(color, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
        return alphaOf(color) > 0 && lengths.some((n) => n !== 0);
      });

    const focused = look(el);
    const describe = (l: ReturnType<typeof look>) => `outline ${l.outlineStyle} ${l.outlineWidth} ${l.outlineColor}, box-shadow ${l.boxShadow}`;
    if (!outlineShows(focused) && !shadowShows(focused)) return `${what} has no focus indicator (${describe(focused)})`;
    el.blur();
    const unfocused = look(el);
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) return `${what} did not take focus back after the check`;
    if (JSON.stringify(focused) === JSON.stringify(unfocused)) {
      return `${what} has no focus indicator: its outline and shadow are the same without focus (${describe(focused)})`;
    }

    const r = el.getBoundingClientRect();
    const slack = 0.5;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    if (r.left < -slack || r.top < -slack || r.right > width + slack || r.bottom > height + slack) {
      return `${what} is not inside the viewport (box ${Math.round(r.left)},${Math.round(r.top)} to ${Math.round(r.right)},${Math.round(r.bottom)} in ${width}x${height})`;
    }

    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(hit === el || el.contains(hit))) {
      const over = hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ''}` : 'nothing';
      return `${what} is covered by ${over} at the centre of its box`;
    }
    return null;
  });
  if (problem) throw new Error(`focus check on ${page.url()}: ${problem}`);
}
