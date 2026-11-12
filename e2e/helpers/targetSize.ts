import type { Page } from '@playwright/test';

/**
 * NFR-A11Y-04, WCAG 2.2 SC 2.5.8 (Target Size, Minimum), as a script over the page's current state.
 *
 * A pointer target is a visible `a[href]`, `button`, `input` (not hidden), `select`, `textarea`,
 * `summary`, `[role=button]` or `label` that has a control. It passes when it is at least 24 by 24 CSS
 * pixels. A smaller one passes when
 *   - spacing: a circle of 24 pixels diameter centred on its box meets no other target's box and no
 *     other undersized target's circle (the SC's own wording; a target inside or around this one does
 *     not count as another), or
 *   - inline: it is a link inside running text, that is an inline `a` in a `p` or `li` that holds
 *     other text besides its links.
 * Not modelled: the "user agent control" and "essential" exceptions. A page that relies on one fails
 * here and its owner decides, with the reason written next to the markup.
 *
 * Pairs: a box that a clipping ancestor (an ancestor whose `overflow` is not `visible`) hides wholly is not
 * drawn, so it cannot crowd a target that ancestor does not contain. A pair is therefore skipped only when
 * one of the two is wholly hidden by a clipping ancestor that does not also contain the other; every other
 * pair is compared. A `position: fixed` target, or a walk up that reaches a `position: fixed` ancestor, is
 * treated as on the page. Approximations: the ancestor's border box stands in for the padding box that
 * `overflow` clips at; a clipper that clips only one axis is treated as clipping both; `display:
 * contents` clippers and absolutely positioned boxes that escape a non-positioned clipper are not modelled.
 *
 * Not targets: elements that are not rendered (`display: none`, `visibility: hidden`, no box), those
 * wholly off the left or top of the page, and the screen-reader-only idiom (a clipped box of 1 pixel).
 */
interface Offender {
  what: string;
  size: string;
  near: string | null;
}

export async function expectTargetsAtLeast24px(page: Page): Promise<void> {
  const offenders = await page.evaluate((): Offender[] => {
    const MIN = 24;
    const RADIUS = MIN / 2;
    interface Target {
      el: Element;
      hiders: Element[];
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const describe = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const type = el instanceof HTMLInputElement ? `[type=${el.type}]` : '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
      return `${el.tagName.toLowerCase()}${id}${type}${text ? ` "${text}"` : ''}`;
    };
    const isRendered = (el: Element): boolean => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility !== 'visible') return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false;
      const clipped = cs.overflow === 'hidden' || (cs.clip !== 'auto' && cs.clip !== '') || cs.clipPath !== 'none';
      return !(r.width <= 1 && r.height <= 1 && clipped);
    };
    const isTarget = (el: Element): boolean => {
      if (el instanceof HTMLInputElement && el.type === 'hidden') return false;
      if (el instanceof HTMLAnchorElement && !el.hasAttribute('href')) return false;
      if (el instanceof HTMLLabelElement && !el.control) return false;
      return isRendered(el);
    };
    const inRunningText = (el: Element): boolean => {
      if (!(el instanceof HTMLAnchorElement) || getComputedStyle(el).display !== 'inline') return false;
      const container = el.closest('p, li');
      if (!container) return false;
      const copy = container.cloneNode(true) as Element;
      copy.querySelectorAll('a').forEach((a) => a.remove());
      return (copy.textContent ?? '').trim() !== '';
    };

    // The clipping ancestors that hide the box wholly (none for a position: fixed box).
    const hidersOf = (el: Element, r: DOMRect): Element[] => {
      const hiders: Element[] = [];
      if (getComputedStyle(el).position === 'fixed') return hiders;
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.position === 'fixed') break;
        if (acs.overflowX === 'visible' && acs.overflowY === 'visible') continue;
        const ar = a.getBoundingClientRect();
        if (r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right) hiders.push(a);
      }
      return hiders;
    };

    const targets: Target[] = Array.from(document.querySelectorAll('a, button, input, select, textarea, summary, [role=button], label'))
      .filter(isTarget)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, hiders: hidersOf(el, r), x: r.left, y: r.top, w: r.width, h: r.height };
      });
    const small = (t: Target) => Math.round(t.w * 10) / 10 < MIN || Math.round(t.h * 10) / 10 < MIN;
    const undersized = targets.filter(small);
    const centre = (t: Target) => ({ x: t.x + t.w / 2, y: t.y + t.h / 2 });
    // Distance from a point to the nearest point of a box.
    const toBox = (p: { x: number; y: number }, t: Target) =>
      Math.hypot(Math.max(t.x - p.x, 0, p.x - (t.x + t.w)), Math.max(t.y - p.y, 0, p.y - (t.y + t.h)));

    const found: Offender[] = [];
    for (const t of undersized) {
      if (inRunningText(t.el)) continue;
      const c = centre(t);
      const crowded = targets.find((o) => {
        if (o === t || o.el.contains(t.el) || t.el.contains(o.el)) return false;
        if (t.hiders.some((a) => !a.contains(o.el)) || o.hiders.some((a) => !a.contains(t.el))) return false;
        if (small(o)) {
          const oc = centre(o);
          return Math.hypot(oc.x - c.x, oc.y - c.y) < 2 * RADIUS;
        }
        return toBox(c, o) < RADIUS;
      });
      if (crowded) {
        found.push({ what: describe(t.el), size: `${Math.round(t.w * 10) / 10}x${Math.round(t.h * 10) / 10}`, near: describe(crowded.el) });
      }
    }
    return found;
  });
  if (offenders.length === 0) return;
  const shown = offenders.slice(0, 20).map((o) => `- ${o.what} is ${o.size} px and its 24 px circle meets ${o.near}`);
  throw new Error(`${offenders.length} target(s) under 24 by 24 CSS pixels without the spacing or inline exception on ${page.url()}\n${shown.join('\n')}`);
}
