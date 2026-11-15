import type { CSSProperties } from 'react';

/**
 * The gate frame's look for the root not-found page (plan 1B Task 14; ruling L5-18 and the owner's ruling of 15 November,
 * after lane 7's measurement): `app/not-found.tsx` and the card `components/layout/NotFoundCard.tsx` draws, the card the
 * signed-in group's not-found page shows too. Every page's first load lists the root not-found's entry, so it cannot
 * import GateFrame, whose sign-out would put the kit's Button and the drafts code on every page, or gate.css, which would
 * put the frame's stylesheet on every page. These inline styles are rendered on the server into the 404 page's HTML only
 * (measured: no route's first-load JavaScript or CSS changed). Role tokens only, no literal colour, no stylesheet.
 * `app/error.tsx` keeps its own look for now: in a client boundary these strings would be JavaScript on every page
 * (measured +1.4 KB), so the error page is framed in a later release.
 *
 * It copies GateFrame's public variant with no route (components/layout/GateFrame.tsx, components/layout/gate.css): a
 * navy column at the rail's width beside a white card on the ground from 1024 px, a navy band above the card below it,
 * and below 320 px the card meeting the screen's edges. Each comment names the gate.css rule it copies. An inline style
 * has no media query, so each value gate.css changes at a width is a clamp() step: `(100vw - 1023.98px) * 99999` is
 * hugely negative below 1024 px and hugely positive from it, so the clamp gives its first value below 1024 px and its
 * last from it, as `@media (min-width: 1024px)` does; the 320 px step is gate.css's `max-width: 19.98rem`. The heading's
 * size steps with the card's own width, as gate.css's container queries do, in `cqi`. The column is not sticky (gate.css
 * makes it sticky from 1024 px for the long acceptances card): these cards are short.
 */

/** `narrow` below `at`, `wide` from it (`narrow` <= `wide`). */
const up = (narrow: string, wide: string, at = '1023.98px') => `clamp(${narrow},(100vw - ${at})*99999,${wide})`;
/** `narrow` below 1024 px, `wide` from it (`narrow` >= `wide`). */
const down = (narrow: string, wide: string) => `clamp(${wide},(1023.98px - 100vw)*99999,${narrow})`;
const SMALL = '19.98rem';
const EDGE = 'solid var(--color-border-container)';

export const GATE_LOOK = Object.freeze({
  /** .gate, .gate--public. The column's line wraps below 1024 px, so the card's area gets a line of its own under the band. */
  frame: { display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', minBlockSize: '100vh', backgroundColor: 'var(--color-ground)' },
  /** .gate__header, .gate__column, .gate__brand: the band's padding var(--space-3) var(--space-4) and lower edge; from
      1024 px the column's var(--space-6) var(--space-3) plus the brand's var(--space-3), the full height, the inline edge. */
  column: {
    flex: `0 0 ${down('100%', 'var(--rail-width)')}`,
    minBlockSize: up('0px', '100vh'),
    padding: `${up('var(--space-3)', 'var(--space-6)')} ${up('var(--space-4)', 'var(--space-6)')}`,
    backgroundColor: 'var(--color-shell)',
    color: 'var(--color-shell-ink)',
    borderBlockEnd: `${down('1px', '0px')} ${EDGE}`,
    borderInlineEnd: `${up('0px', '1px')} ${EDGE}`,
  },
  /** .gate__product */
  product: { color: 'var(--color-shell-ink)', fontSize: 'var(--font-size-body)', fontWeight: 'var(--font-weight-semibold)', overflowWrap: 'anywhere' },
  /** .gate__main: var(--space-4); var(--space-12) from 1024 px; no side gutter below 320 px. */
  area: {
    flex: `1 1 ${down('100%', '0px')}`,
    minWidth: 0,
    paddingBlock: up('var(--space-4)', 'var(--space-12)'),
    paddingInline: up(up('0px', 'var(--space-4)', SMALL), 'var(--space-12)'),
  },
  /** .gate__card: no width limit below 1024 px, 30rem from it; var(--space-6) var(--space-4) padding, var(--space-8) from
      1024 px; below 320 px var(--space-3) at the sides, no side borders and square corners. */
  card: {
    containerType: 'inline-size',
    maxInlineSize: 'max(30rem,(1023.98px - 100vw)*99999)',
    paddingBlock: up('var(--space-6)', 'var(--space-8)'),
    paddingInline: up(up('var(--space-3)', 'var(--space-4)', SMALL), 'var(--space-8)'),
    backgroundColor: 'var(--color-surface)',
    borderBlock: `1px ${EDGE}`,
    borderInline: `${up('0px', '1px', SMALL)} ${EDGE}`,
    borderRadius: up('0px', 'var(--radius-surface)', SMALL),
    overflowWrap: 'break-word',
  },
  /** .gate__card h1 and its container steps: the h1 size from a 30rem card, the h2 size below it, the h3 size below 12rem. */
  heading: {
    marginBlockEnd: 'var(--space-4)',
    fontSize: 'clamp(clamp(var(--font-size-h3),(100cqi - 11.99rem)*99999,var(--font-size-h2)),(100cqi - 29.99rem)*99999,var(--font-size-h1))',
    lineHeight: 'var(--line-height-heading)',
    color: 'var(--color-heading)',
    overflowWrap: 'normal',
  },
  /** The space under each paragraph of the card (the reset in app/globals.css sets every margin to 0). */
  paragraph: { marginBlockEnd: 'var(--space-4)' },
} satisfies Record<string, CSSProperties>);
