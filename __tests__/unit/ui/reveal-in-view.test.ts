import { describe, expect, it } from 'vitest';
import { NEAREST_INSTANT, revealFocused, revealOpened } from '@/components/ui/revealInView';

/**
 * D-386, SC 2.4.11: the order of InlineConfirm's reveal. vitest runs in `node` with no DOM (vitest.config.ts), so the elements
 * are stand-ins that record what is called on them; that the confirmation then sits wholly in view on each screen that uses it
 * is driven in a browser by e2e/inline-confirm-reveal.spec.ts.
 */

type Call = [string, ScrollIntoViewOptions | undefined];
function standIn(name: string, calls: Call[], holds: StandIn[] = []): StandIn {
  const self: StandIn = {
    scrollIntoView: (o) => { calls.push([name, o]); },
    contains: (other) => other === self || holds.includes(other as StandIn),
  };
  return self;
}
type StandIn = { scrollIntoView: (o?: ScrollIntoViewOptions) => void; contains: (other: StandIn | null) => boolean };

describe('revealOpened and revealFocused', () => {
  it('scrolls to the nearest edge, both ways, instantly rather than with the page\'s smooth scroll, with options no importer can change', () => {
    expect(NEAREST_INSTANT).toEqual({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    expect(Object.isFrozen(NEAREST_INSTANT)).toBe(true);
  });

  it('SC 2.4.11: an opened confirmation is brought into view whole first, then the element that has focus when it is inside', () => {
    const calls: Call[] = [];
    const field = standIn('field', calls);
    const confirmation = standIn('confirmation', calls, [field]);
    revealOpened(confirmation, field);
    expect(calls).toEqual([['confirmation', NEAREST_INSTANT], ['field', NEAREST_INSTANT]]);
  });

  it('SC 2.4.11: focus outside the confirmation (the button that opened it) is left where it is, and no focus at all is no error', () => {
    const calls: Call[] = [];
    const trigger = standIn('trigger', calls);
    const confirmation = standIn('confirmation', calls);
    revealOpened(confirmation, trigger);
    revealOpened(confirmation, null);
    expect(calls).toEqual([['confirmation', NEAREST_INSTANT], ['confirmation', NEAREST_INSTANT]]);
  });

  it('SC 2.4.11: an element that takes focus inside the confirmation is brought wholly into view, the same way', () => {
    const calls: Call[] = [];
    revealFocused(standIn('cancel', calls));
    expect(calls).toEqual([['cancel', NEAREST_INSTANT]]);
  });
});
