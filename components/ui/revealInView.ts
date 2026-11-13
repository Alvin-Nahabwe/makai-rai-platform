/**
 * InlineConfirm's reveal (D-386, SC 2.4.11 Focus Not Obscured). Its one job: bring a box wholly into view by the shortest
 * scroll, at once. It moves no focus and decides nothing about when to run; InlineConfirm does that.
 *
 * Nearest edge, both ways, so a box already in view does not move and a box cut by an edge moves only by what is cut; this is
 * also why a pointer press on a partly visible control still lands on it (the control moves up from the edge under the
 * pointer). Instant, not the page's smooth scroll (`html { scroll-behavior: smooth }`, app/globals.css): a smooth scroll is
 * still moving when a caller's focus() or the next key arrives, and a browser scroll issued after it can win, as
 * DecisionForm.tsx's onFocus records.
 */
export const NEAREST_INSTANT: ScrollIntoViewOptions = { block: 'nearest', inline: 'nearest', behavior: 'instant' };

type Scrolls = { scrollIntoView(options?: ScrollIntoViewOptions): void };

/**
 * On open: the whole confirmation first, then the element that has focus at that moment when it is inside the confirmation
 * (in a window shorter than the confirmation, that element is the one that must show). Focus outside it is left alone.
 */
export function revealOpened<T extends Scrolls>(confirmation: T & { contains(other: T | null): boolean }, focused: T | null): void {
  confirmation.scrollIntoView(NEAREST_INSTANT);
  if (focused !== null && confirmation.contains(focused)) focused.scrollIntoView(NEAREST_INSTANT);
}

/** On focus: the element that has just taken focus inside the confirmation, wholly. */
export function revealFocused(element: Scrolls): void {
  element.scrollIntoView(NEAREST_INSTANT);
}
