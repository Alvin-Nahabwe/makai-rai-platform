# ADR-0022: Design system foundation: tokens, a legacy alias layer, and the builder's choices

**Status:** Accepted · **Date:** 2026-11-13 · **Deciders:** the plan 1A review (UX redesign, `records/plans/2026-11-11-ux-redesign/plans/stage-1a-foundation-plan.md`); B19 of that plan is the owner's to overrule and is not recorded here.

## Context

The redesign replaces the palette, type ramp and motion across every screen, in stages. The specification
left several choices to the builder (spec 14). The stylesheet today names its colours after the old brand
palette and four status tints, and about 25 files read those names. Restyling them all in one commit would
break every screen at once; leaving the old names would keep green, red and yellow status colour alive.
Constraints: no new runtime or styling dependency; WCAG 2.2 AA in light and dark; orange is never text on
navy (2.66:1) and never a status; red means overdue only.

## Decision

Colour roles, type, space, shape and motion are CSS custom properties in `app/globals.css`. Light values are
in `:root`; the dark values are written identically in `@media (prefers-color-scheme: dark)
{ :root:not([data-theme='light']) }` and in `:root[data-theme='dark']`. Old names stay readable through a
`LEGACY ALIASES` block in `:root` that Task 21 deletes. The choices below are recorded with their reasons.

| # | Choice | Reason |
|---|---|---|
| B1 | Components live flat in `components/ui/<Name>.tsx` with a sibling `.css`; shell pieces in `components/layout/`. BEM classes prefixed `ui-` and `shell-` | Matches the four existing flat components and the per-component CSS import already used by `DecisionForm`. The prefixes cannot collide with `.btn`, `.card`, `.status-label`, `.sidebar-*`, so old and new coexist |
| B2 | Old names are retired through the alias block (each old name is `var(<new role>)`); the dark blocks redefine only new roles; a ratchet test (`__tests__/lint/legacy-tokens.test.ts`) lists the files still reading a legacy name | Unrestyled screens take the new palette at once, every old status tint maps to a neutral role, and no screen breaks between tasks |
| B3 | Dark values per the token table; focus `#B85F14` light and `#F4B983` dark; a separate `--color-selected` | `#9A4D10` is 2.66:1 on navy, so the ring needs a lighter orange in light mode. All 35 pairs are tested in three themes |
| B4 | Links are navy (light) or `#C7CCE0` (dark) and underlined; orange stays for primary buttons, the current rail item and "You are here" | Spec 7.1 lists orange's uses; a link is not one |
| B5 | Errors are bold ink text with the `triangle-alert` icon and a 2 px ink border; never red | Red is reserved for overdue |
| B6 | Destructive button: surface fill, ink text, 1 px control border, a label naming the action; separated from primary by placement and by an inline confirmation | Orange and red are both reserved |
| B7 | Icons are Lucide (ISC), path data copied into `components/ui/icons.tsx`, licence text beside it; 28 icons | One 2 px stroke on a 24 grid; copying path data adds no dependency |
| B8 | Below 1024 px the rail becomes a top bar; tables become cards under 640 px of container (`@container`); the route row wraps; at 320 px the stages stack | Spec 7.5 names 640 and 320; the rest was the builder's to choose |
| B9 | Tabs are navigation (`TabNav`, links with `aria-current="page"`), not ARIA tab panels | Each tab is an address or a query; findings filter on the server |
| B10 | The narrow menu uses the declarative `popover` attribute, with a client fallback that toggles `hidden` when `HTMLElement.prototype.popover` is absent | Popover is only newly available (Baseline 2025), so the fallback is required; it also works before hydration |
| B11 | Select is a styled closed control (`appearance: none` plus a chevron); `appearance: base-select` only inside `@supports` | Limited availability (no Firefox): the native picker stays the fallback |
| B12 | Skeletons are static and announce once through a visually hidden status line | Nothing moves on page load (spec 7.5) |
| B13 | The last opened project is kept in `localStorage` under `makrai:last-project:<userId>:<orgSlug>`, checked by the server before redirecting | Projects can be deleted, so a stored id can go stale; the user id in the key keeps a shared laptop from handing one person's project to the next |
| B14 | The rail item is "Organisation details" | The vocabulary authority clause and its section 8 row 12 |
| B15 | The Footer's "Terms and privacy" goes to `/help#terms-and-privacy` | One page lists all the legal texts; Help is the home for reference material |
| B16 | `/help` is built in full in 1A from the vocabulary data | The rail needs it from stage 1 |
| B17 | Projects list and form are restructured by plan 1B; History by plan 1C | They are first-arrival screens, outside 1A |
| B18 | Generated PDFs and the eight templates keep their fonts in 1A; PDF wording changes in 1A; no byte of the templates or notebooks changes | Their bytes are hash-pinned to owner passes; PDF variable-font embedding is unconfirmed |

`color-scheme` stays `light` on `:root` and `dark` in the dark blocks. The `dark-mode-toggle` guidance of
`light dark` on the root was considered and not applied: with two token blocks and a forced-light choice
on a dark operating system, `light dark` would draw native controls dark while the tokens are light.

## Alternatives declined

- **CSS Modules.** Would need every existing global class renamed at once and a second way to share tokens;
  plain per-component CSS with a prefix already matches the repository (B1).
- **Tailwind.** A new styling dependency, barred by the constraints, and it would not let old and new screens coexist.
- **An icon package.** A runtime dependency for 28 paths; copying the Lucide path data costs none (B7).
- **ARIA tab panels.** The tabs are addresses; panels would hide content that links should reach (B9).
- **Status colour.** Status is shape plus a word in ink. Green and red would imply a score the platform does not give, and red is overdue's alone.

## Consequences

- Every screen takes the new palette on the commit that adds the tokens; screens are restyled one area at a
  time, each removing files from `legacy-tokens.allow.json` until Task 21 deletes the block.
- Where an old name could not take the plan's mapping without breaking a screen, the alias says why in a comment:
  `--color-white` stays `#FFFFFF` in every theme (the plan's surface role is dark in dark mode, and white is read as
  text on navy and on the action fill, as it is at the base), `--color-primary-light` is `#F0A35E` in every theme (its
  only reader, AboutPage.css, draws it as text on the navy hero; the plan's action-text role is 2.66:1 there in
  light; its readers go in Task 19), and `--font-family` reads the `--font-overpass` variable the layout defines
  (Overpass, self-hosted, replaced Source Sans 3 and DM Serif Display in Task 2), while `--font-display` is an alias of
  `--font-family`: there is one family, and the About page no longer reads the alias.
- `--color-risk-critical` is ink, not the overdue role as the plan maps it: its readers are field errors, a required
  mark and a hover state, none an overdue date, and red means overdue only (B5).
- A mistyped variable fails `legacy-tokens.test.ts` (a), which lists the five variables defined outside the stylesheet.

## Residual risks

- Aliased screens may show a pair the new roles never intended. The 35 pairs cover the
  roles, not the aliases; each restyle task checks its screen with axe.
