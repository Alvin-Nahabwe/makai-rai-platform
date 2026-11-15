/**
 * The box that scrolls the decision card, found once for the save row (T10, 15 Nov 2026). The row is sticky against it
 * on wide screens, its scroll padding keeps a focused field above the row (SC 2.4.11), and its visible edges are the
 * "screen" the row's geometry is read against. Which box that is depends on the layout: lane 3's `div.page-frame` from
 * 1024 px (components/layout/shell.css), the document below. It is read from computed style, the nearest ancestor whose
 * block overflow lets it scroll (as a sticky box finds its scroll container), not from a class, so a layout that moves
 * the page's scroll to another box is still found. The document element itself is never taken from style: `html` has
 * `overflow-x: hidden` (app/globals.css), which makes its computed block overflow `auto` whether or not it scrolls.
 */

/** The attribute DecisionForm puts on the scroller, which DecisionForm.css gives the row's height as scroll padding. */
export const SCROLLER_ATTRIBUTE = 'data-decision-scroller';

/** The nearest ancestor of `from` that scrolls its content, else the document's scrolling element. */
export function cardScroller(from: Element): HTMLElement {
  const root = document.documentElement;
  for (let el = from.parentElement; el !== null && el !== document.body && el !== root; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if (overflow !== 'visible' && overflow !== 'clip') return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? root;
}

/** The scroller's visible band on the screen, in viewport pixels: its scrollport, cut to the window. */
export function scrollerView(scroller: HTMLElement): { top: number; bottom: number } {
  const root = document.documentElement;
  const screen = root.clientHeight;
  if (scroller === root || scroller === document.scrollingElement) return { top: 0, bottom: screen };
  const top = scroller.getBoundingClientRect().top + scroller.clientTop;
  return { top: Math.max(0, top), bottom: Math.min(screen, top + scroller.clientHeight) };
}
