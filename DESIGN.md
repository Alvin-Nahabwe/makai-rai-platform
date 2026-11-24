---
name: MAK-AI RAI Platform
description: A navy rail, white working surfaces, one orange action, and status told in shape and words, never in a score.
colors:
  shell: "#1A1F36"
  shell-ink: "#FFFFFF"
  shell-muted: "#B7BCD3"
  shell-hover: "#262C4A"
  on-shell-accent: "#F4B983"
  action: "#9A4D10"
  action-hover: "#7F3F0C"
  on-action: "#FFFFFF"
  action-text: "#9A4D10"
  selected: "#9A4D10"
  ground: "#F2F4F8"
  surface: "#FFFFFF"
  tint: "#E6E9F0"
  ink: "#1B1B1F"
  ink-muted: "#4A5060"
  heading: "#1A1F36"
  link: "#1A1F36"
  border-container: "#D5DAE3"
  border-control: "#6B7385"
  saved: "#1F7A4D"
  saved-tint: "#E8F3EC"
  overdue: "#B42318"
  mark: "#1A1F36"
  focus: "#B85F14"
typography:
  h1: { fontFamily: "Overpass", fontSize: "1.875rem", fontWeight: 700, lineHeight: 1.25 }
  h2: { fontFamily: "Overpass", fontSize: "1.375rem", fontWeight: 700, lineHeight: 1.25 }
  h3: { fontFamily: "Overpass", fontSize: "1.125rem", fontWeight: 700, lineHeight: 1.25 }
  body: { fontFamily: "Overpass", fontSize: "1rem", fontWeight: 400, lineHeight: 1.5 }
  small: { fontFamily: "Overpass", fontSize: "0.875rem", fontWeight: 400, lineHeight: 1.5 }
  legal: { fontFamily: "Overpass", fontSize: "0.8125rem", fontWeight: 400, lineHeight: 1.5 }
rounded:
  control: "6px"
  surface: "8px"
  pill: "999px"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "10": "2.5rem"
  "12": "3rem"
  "16": "4rem"
  "20": "5rem"
  "24": "6rem"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    rounded: "{rounded.control}"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.heading}"
    rounded: "{rounded.control}"
    height: "44px"
  rail:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.shell-ink}"
    width: "248px"
---

# Design system

This file describes the system as it is built at commit `c4e0367e` of branch `design/route-docs`. Every value comes from a file named beside it. Light values are in the frontmatter; the dark values are in the Colors section. Where a file does not settle a point, the point says "not established".

`scripts/design/inventory.mjs` prints every token, component, class and icon in the code. `__tests__/lint/design-md.test.ts` fails when this file names something the code does not have, or leaves one out. The test reads names inside backticks: a token with its two dashes, a component in angle brackets, a class with its dot, and an icon by its name in the Icons section.

Decisions behind the foundation are in `docs/adr/0022-design-system-foundation.md`. The design specification is `records/plans/2026-11-11-ux-redesign/DESIGN-SPEC.md` (sections 5 to 7). The owner's rulings of 15 November 2026 are in `.superpowers/sdd/stage-1b-route/route-target-decisions.md` (R1 to R11) and `progress.md` beside it. Neither folder is in this repository's tracked files; read them in the integration worktree.

## Overview

The platform records decisions a team makes about one AI system. The design has two rules: it never scores a team, and a person always knows where they are.

- **Operate mode.** Almost every screen is a task: record a decision, read a finding, open a review. Scanning, consistency and plain words come before expression.
- **The Route.** A project has three stages. A stage is a line of questions, each a mark. The person's position is "You are here". The words stay plain: the interface says "question" and "stage", not "stop" or "line" (spec principle 4; `route-target-decisions.md`, R1).
- **No score.** There is no score, percentage or total across stages. The one bar allowed is a per-stage bar of "N of M questions recorded" on S-10, marked `data-stage-bar`, with the count in words beside it (owner, 19 November 2026: "Allow progress display"). Status is a shape and a word, in ink. Tallies are written in words beside the marks.
- **One orange.** The action orange fills the one primary button of a view. Orange text appears on white and on the page ground as `--color-action-text`, and once on navy as the peach `--color-on-shell-accent` (ADR 0022).
- **Both themes.** Light is the default. Dark is applied by the operating system's preference or by the theme switch, and the two dark blocks in `app/globals.css` hold identical values (`__tests__/unit/design-tokens.test.ts` checks it).

Screens captured from the production build at `c4e0367e` are in `docs/design/screens/`. They are named in the sections that use them.

## Colors

Roles are CSS custom properties in `app/globals.css`. A screen reads roles, never a literal colour. The pairs below are the ones `__tests__/unit/design-tokens.test.ts` holds to a minimum (4.5:1 for text, 3:1 for a mark or a control border, WCAG 1.4.3 and 1.4.11) in light and in both dark blocks. The ratios are computed from the token values with the WCAG relative-luminance formula, the same one the test uses.

### Surfaces and ink

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-shell` | #1A1F36 | #0A0D18 | The rail, the narrow top bar and the gate frame's column. |
| `--color-shell-ink` | #FFFFFF | #ECEEF4 | Text on the shell. |
| `--color-shell-muted` | #B7BCD3 | #AEB4C4 | Secondary text on the shell: a stage's state line, the rail's rules. |
| `--color-shell-hover` | #262C4A | #1E2338 | Hover and the current stage's plate on the rail. |
| `--color-ground` | #F2F4F8 | #0F1220 | The page behind the work. |
| `--color-surface` | #FFFFFF | #181C2E | A card, a plate, a field, the decision card. |
| `--color-tint` | #E6E9F0 | #232842 | A quiet panel, a note, a hovered row, a disabled control. |
| `--color-ink` | #1B1B1F | #ECEEF4 | Body text. |
| `--color-ink-muted` | #4A5060 | #AEB4C4 | Secondary text, small codes, hints. |
| `--color-heading` | #1A1F36 | #ECEEF4 | Headings and the secondary button's label and border. |
| `--color-link` | #1A1F36 | #C7CCE0 | Links. Links in running text are underlined (`p a`, `li a`, `td a`). |
| `--color-border-container` | #D5DAE3 | #363C55 | The edge of a card or plate. A decoration, so it is not held to a ratio. |
| `--color-border-control` | #6B7385 | #8A93A8 | The edge of a field, a radio card, a disabled button. |
| `--color-mark` | #1A1F36 | #C7CCE0 | Every status shape and the route's line. |

### Action, selection, focus

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-action` | #9A4D10 | #9A4D10 | A fill: the primary button, the rail's current item. Never text. |
| `--color-action-hover` | #7F3F0C | #7F3F0C | The primary button's hover and active fill. |
| `--color-on-action` | #FFFFFF | #FFFFFF | Text on the action fill. |
| `--color-action-text` | #9A4D10 | #F0A35E | Orange as text or a ring: "You are here" on a plate, the current stop's ring. |
| `--color-selected` | #9A4D10 | #F0A35E | A chosen radio card's border and mark. |
| `--color-focus` | #B85F14 | #F4B983 | The focus ring: `--focus-width` 3 px, `--focus-offset` 2 px. |
| `--color-on-shell-accent` | #F4B983 | #F4B983 | The peach "You are here" on the navy rail. The one orange text on navy (ADR 0022). |

The action fill alone is 2.77:1 on the dark surface, which is why text and rings use `--color-action-text` there. A rule in `app/globals.css` may not paint text with `--color-action`; the token test fails if one does.

### Confirmation and lateness

| Token | Light | Dark | Role |
|---|---|---|---|
| `--color-saved` | #1F7A4D | #6FCF97 | The "Saved" confirmation and the Done mark's disc. Nothing else is green. |
| `--color-saved-tint` | #E8F3EC | #15301F | The saved mark's panel. |
| `--color-overdue` | #B42318 | #FF8A7A | An overdue date and the word "Overdue". Nothing else is red. |

Errors are not red. A field error is bold ink with the `triangle-alert` icon (decision B5, `components/ui/TextInput.tsx`).

### Contrast, computed

Each cell is light / dark. All meet their minimum.

| Foreground on background | Minimum | Ratio |
|---|---|---|
| ink on ground | 4.5 | 15.59 / 16.05 |
| ink on surface | 4.5 | 17.17 / 14.55 |
| ink on tint | 4.5 | 14.13 / 12.45 |
| ink-muted on ground | 4.5 | 7.31 / 8.98 |
| ink-muted on surface | 4.5 | 8.05 / 8.14 |
| ink-muted on tint | 4.5 | 6.63 / 6.97 |
| link on ground | 4.5 | 14.75 / 11.65 |
| link on surface | 4.5 | 16.24 / 10.56 |
| link on tint | 4.5 | 13.36 / 9.04 |
| heading on ground | 4.5 | 14.75 / 16.05 |
| heading on surface | 4.5 | 16.24 / 14.55 |
| on-action on action | 4.5 | 6.10 / 6.10 |
| on-action on action-hover | 4.5 | 8.02 / 8.02 |
| shell-ink on shell | 4.5 | 16.24 / 16.71 |
| shell-ink on shell-hover | 4.5 | 13.62 / 13.38 |
| shell-muted on shell | 4.5 | 8.62 / 9.34 |
| on-shell-accent on shell | 4.5 | 9.37 / 11.18 |
| on-shell-accent on shell-hover | 4.5 | 7.86 / 8.96 |
| action-text on surface | 4.5 | 6.10 / 8.12 |
| action-text on ground | 4.5 | 5.54 / 8.96 |
| saved on surface | 4.5 | 5.32 / 8.88 |
| saved on ground | 4.5 | 4.83 / 9.80 |
| saved on saved-tint | 4.5 | 4.67 / 7.49 |
| ink on saved-tint | 4.5 | 15.09 / 12.28 |
| overdue on surface | 4.5 | 6.57 / 7.37 |
| overdue on ground | 4.5 | 5.97 / 8.13 |
| border-control on surface | 3 | 4.76 / 5.48 |
| border-control on ground | 3 | 4.32 / 6.05 |
| border-control on tint | 3 | 3.91 / 4.69 |
| mark on surface | 3 | 16.24 / 10.56 |
| mark on ground | 3 | 14.75 / 11.65 |
| mark on tint | 3 | 13.36 / 9.04 |
| selected on surface | 3 | 6.10 / 8.12 |
| focus on surface | 3 | 4.48 / 9.73 |
| focus on ground | 3 | 4.07 / 10.74 |
| focus on shell | 3 | 3.62 / 11.18 |
| focus on tint | 3 | 3.69 / 8.33 |

The Done mark's check is the surface colour on the saved disc, so it holds the same figure as saved on surface: 5.32 in light and 8.88 in dark.

Dark mode drops the surface shadow (`--shadow-surface` is `none` there). `color-scheme` is `light` on the root and `dark` in the dark blocks, so native controls follow the tokens, including when light is forced on a dark system (ADR 0022).

## Typography

One family, Overpass, self-hosted in `app/fonts` and loaded in `app/layout.tsx` with weights 400 to 700 (`--font-family`, with system fallbacks). `__tests__/lint/no-google-fonts.test.ts` guards against a font fetch. Native controls inherit the family but not the size (`app/globals.css`).

| Step | Token | Size | Used by |
|---|---|---|---|
| Heading 1 | `--font-size-h1` | 30 px (1.875 rem) | The page's one h1. |
| Heading 2 | `--font-size-h2` | 22 px (1.375 rem) | Section headings; the route column's stage name; the question text on the question page (R7; `.question-frame__title` in `components/question/workspace.css`). |
| Heading 3 | `--font-size-h3` | 18 px (1.125 rem) | Subheadings; h4; the saved mark's title. |
| Body | `--font-size-body` | 16 px (1 rem) | Reading text, h5, buttons, plate titles. |
| Small | `--font-size-small` | 14 px (0.875 rem) | Codes, hints, tallies, the "You are here" pin. |
| Legal | `--font-size-legal` | 13 px (0.8125 rem) | Small print on Home (`components/home/home.css`). |

Line height is `--line-height-body` (1.5) for text and `--line-height-heading` (1.25) for headings. Weights: `--font-weight-regular` 400, `--font-weight-semibold` 600, `--font-weight-bold` 700. The root is 16 px (`html` in `app/globals.css`; a test pins it). Headings are bold and sentence case. Codes and counts use tabular figures (`font-variant-numeric` in `ItemPlate.css`).

## Layout

Spacing is a 4 px base. The tokens, in order: `--space-1` 4 px, `--space-2` 8 px, `--space-3` 12 px, `--space-4` 16 px, `--space-5` 20 px, `--space-6` 24 px, `--space-8` 32 px, `--space-10` 40 px, `--space-12` 48 px, `--space-16` 64 px, `--space-20` 80 px, `--space-24` 96 px.

- **Frame.** From 1024 px the shell is a navy rail, `--rail-width` 248 px, beside the content; the rail is sticky and the footer sits in the content column (`components/layout/shell.css`). Below 1024 px the rail becomes a top bar with a labelled Menu button and a panel (decision B10).
- **Widths.** `--max-width` 1200 px and `--max-width-narrow` 900 px bound public pages. `--measure-reading` is 68ch for reading text. `--grid-gap` is 24 px.
- **Targets.** `--target-primary` is 44 px for a primary control; `--target-min` is 24 px for everything else (WCAG 2.5.8).
- **Breakpoints that are written down.** 1024 px for the rail and the gate frame; 640 px of container width, under which a `<Table>` becomes cards (`components/ui/Table.css`); 359.98 px, under which the top bar takes a second row (`shell.css`); 320 px, where stages stack (ADR 0022, B8). The question page's column follows the main content below 72.5 rem (`components/question/route-column.css`).
- **Gutters.** The shell's main gives 16 px of gutter, 32 px from 1024 px (`shell.css`).

## Elevation and depth

The system is nearly flat. `--shadow-surface` is `0 2px 8px rgb(26 31 54 / 0.08)` in light and `none` in dark. Depth in dark comes from the surface and tint colours and a 1 px `--color-border-container` edge. A hovered card in the legacy `.card` rule lifts by 4 px; kit components do not move on hover (`components/ui/Button.css` says "nothing moves").

## Shapes

`--radius-control` 6 px for buttons, fields and lists inside a card; `--radius-surface` 8 px for cards, plates, the saved mark and callouts; `--radius-pill` 999 px for the route row's stop rings and the legacy `.badge`. Borders are 1 px in `--color-border-container` for containers and in `--color-border-control` for controls. Marks and rings are drawn from borders or SVG strokes, so forced-colours mode keeps them (several sheets carry a `forced-colors` block).

## Status marks

Status is a shape and its words, in ink, never a colour code (spec 7.2). The kinds are defined in `components/ui/types.ts` (`StatusMarkKind`), drawn in `components/ui/StatusMark.tsx`, and worded in `lib/ui/copy.ts`.

| Kind | Shape | Words |
|---|---|---|
| `done` | A filled green disc with a check in the surface colour (white in light, dark in dark) | Done (adds ", no evidence attached" when that is so) |
| `partly` | A ring with its right half filled | Partly |
| `not_yet` | A thick ring | Not yet |
| `not_applicable` | A ring with a slash | Not applicable |
| `does_not_apply` | A dashed ring with a slash | Does not apply (from your answer to the personal data question) |
| `scope_answered` | A filled square | Answer: Yes, No or Not sure ("Answered" where no answer is at hand, `lib/ui/copy.ts`) |
| `no_decision` | A small dot | No decision |

Done is the only mark with colour (owner ruling R8, 15 November 2026, over spec decision D4). The disc is `--color-saved` and the check is `--color-surface`, each painted by its own class (`.ui-mark__done-disc`, `.ui-mark__done-check`) so the green holds wherever `<MarkShape>` is drawn. In forced colours the disc is the system text colour and the check the canvas. Every other kind is drawn in `currentColor`, set to `--color-mark`; no rule may colour a `.ui-mark` except with that token (`__tests__/unit/ui/status-mark.test.tsx`).

A mark is at least 16 px. The count never parts from its word (`RouteRow.css`). `<StatusMark>` draws the shape and its words; `<MarkShape>` draws the shape alone, hidden from assistive technology, for a caller that writes the words itself.

## The route

The route is the stage drawn as one line, a mark per question.

**On the question page** (`components/question/RouteColumn.tsx`, `RouteLine.tsx`, `route-column.css`, `route-line.css`; ruling R1). The column holds the stage's name and plain meaning, a small "Show" filter above the line, the line, and "All questions in this stage". The line is a 4 px rule (`route-line.css`) with a mark on it for each question, the question in words clamped to two lines (R7), and a meta line of code, status and state. The current question is a white plate with a 40 px ring, 4 px thick in `--color-action-text`, and the pin "You are here" above its words in the same colour. The next question that applies leads its meta line with "Next question". A run of questions folds into a native disclosure ("Questions 5 to 24") that shows one 16 px mark per question and its tally in words. From 1160 px a top strip (`QuestionTopStrip.tsx`; R4) holds the breadcrumb with "Question n of N", the open findings and overdue mitigations, and the stage's tally, one mark with a count and its word per kind above zero. Below 1160 px a position strip (`PositionStrip.tsx`) shows the previous and next question and "Question n of N", and the same line follows the main content. See `docs/design/screens/question-1280-light.webp`, `docs/design/screens/question-1280-dark.webp`, `docs/design/screens/question-375-light.webp` and `docs/design/screens/question-375-dark.webp`, and `docs/design/screens/stage-1280-light.webp` and `docs/design/screens/stage-1280-dark.webp` for the stage page.

**The row of marks** (`<RouteRow>`). One mark per question in a wrapping row, joined by a 2 px line in `--color-mark`, then a tally list: a 16 px shape, a bold count and the words. Each stop's accessible text is "title: status words". The current stop is ringed 2 px in `--color-action-text` and carries `aria-current="step"`. There is no fill, percentage or total. A defined status word can carry an (i) `<TermTip>` on its first use.

**The rail** (`components/layout/Rail.tsx`, `ShellProject.tsx`, `shell.css`; ruling R4). On a project the rail shows the project's name and its three stages, each with a line mark and one line of state, such as "Not started" or "You are here · 24 questions". Under the stages is one link, "Working report" (`.shell-project__report`, 44 px high, shell ink, underlined on hover, not prefetched), to the project's working report. The current stage sits on a `--color-shell-hover` plate, and its state line is in the peach `--color-on-shell-accent` (#F4B983), 9.37:1 on the shell and 7.86:1 on the plate in light, 11.18:1 and 8.96:1 in dark. This is the one orange text on navy; every other rail text is `--color-shell-ink` or `--color-shell-muted` (ADR 0022). The mark on the current stage's line is an orange disc, `--color-action`, ringed in shell ink. The current rail item (Home, Projects and so on) is an action-orange fill with white text.

## The saved mark

`<SavedMark>` (`components/ui/SavedMark.tsx`, `SavedMark.css`) confirms a save: by default the outline `circle-check` icon in `--color-saved` (a `shape` prop replaces it), the title "Saved as version n", the decided and saved dates labelled apart, and the line saying the decision is on the platform with the earlier version kept in the history. The panel is `--color-saved-tint` with a 1 px `--color-saved` border; the words stay in ink and `--color-heading`. It is always mounted. Empty, it draws nothing but keeps its place as a polite, atomic status region, so the words are announced when they arrive. A caller that server-renders it filled passes `live` as false.

On the question page the decision card passes its own shape (`<SavedShape>`, exported from `SavedMark.tsx`, painted in `SavedMark.css`; critique P1 4): a page with a folded corner and two lines, in strokes of `--color-saved` on `--color-saved-tint`, 16 px in the card's corner and 24 px in the phone's saved block. It has no disc and no check, so "Saved" is never mistaken for the Done mark; in forced colours it is the system text colour. The save-status line beside Save ("Saved…", M-03 and M-04) draws the same shape as a mask in `--color-saved`, so no "Saved" indicator is a check. The outline `circle-check` icon is the kit default; outside the decision card, its only callers are the `/dev/ui-kit` demos.

## Components

Kit components live in `components/ui/`, grouped by file (for example `Button.tsx` holds `<Button>` and `<ButtonLink>`, `TextInput.tsx` holds `<FieldLabel>`, `<FieldHint>` and `<FieldError>`, `Definition.tsx` holds `<Term>`). Most have a sibling stylesheet; `<Banner>`, `<ListLink>`, `<ShowMoreLink>`, `<DownloadLink>` and `<LocalTime>` have none. Shared style bundles sit beside them: `buttonStyles.ts`, `formStyles.ts`, `selectStyles.ts`, `textAreaStyles.ts`, `dateFieldStyles.ts` and `pageHeaderStyles.ts`. Classes are prefixed `ui-` (decision B1). The shell's classes are prefixed `shell-`. The inventory lists each component's props type; where the name is "inline", the props are written in the signature.

States the kit draws (from the sheets named): hover and active change colours only, over `--duration-state`; focus is the global 3 px ring; disabled uses a dashed `--color-border-control` border on `--color-tint`; busy keeps the label and shows a spinner; an error adds the `triangle-alert` icon, the word "Error:" for assistive technology and `aria-invalid`.

### Actions

| Component | Props type | Use it for |
|---|---|---|
| `<Button>` | `ButtonProps` | An action. Variants: `primary` (the one action of a view, orange fill, white text), `secondary` (surface with a heading-colour border), `quiet` (underlined link look), `destructive` (surface, ink, control border; never orange or red). Sizes `default` (44 px) and `compact` (32 px). States: busy, disabled. |
| `<ButtonLink>` | `ButtonLinkProps` | A link that looks like a button, for navigation. |
| `<ListLink>` | inline | A link that never prefetches, for long lists of links. |
| `<ShowMoreLink>` | inline | "Show more" or "Show older" at the end of a list that has more. |
| `<DownloadLink>` | inline | A file link whose text names its kind and size. |
| `<InlineConfirm>` | `InlineConfirmProps` | Confirming an action that cannot be undone, in place. Cancel comes first; the button repeats the action; not a modal. |
| `<Dialog>` | `DialogProps` | A modal on the native dialog element. The safe action goes first so it takes focus. |

### Fields

| Component | Props type | Use it for |
|---|---|---|
| `<TextInput>` | `TextInputProps` | One line of text. Label, hint above, error below. |
| `<TextArea>` | `TextAreaProps` | Longer text with a count, measured in code points; past the limit the count takes its `.ui-count--over` state. |
| `<Select>` | `SelectProps` | One choice from a list; a styled closed control with a chevron. |
| `<RadioCards>` | `RadioCardsProps` | One choice as cards. The whole card selects; the choice is a 2 px border in `--color-selected` plus the mark. Each card draws one control: an empty ring until chosen, then its option's mark (Done's green check only on a chosen Done card). The native radio is a transparent hit area over it. |
| `<Checkbox>` | `CheckboxProps` | One yes or no, in a 44 px row. |
| `<CheckboxGroup>` | `CheckboxGroupProps` | Several checkboxes under one legend. |
| `<DateField>` | `DateFieldProps` | A date as Day, Month and Year boxes with "Today". |
| `<FieldLabel>` | inline | A field's label; a required field says so in words. |
| `<FieldHint>` | inline | A field's hint, above its control. |
| `<FieldError>` | inline | A field's error message. |
| `<ErrorSummary>` | `ErrorSummaryProps` | The errors of a form, each linking to its field; focus moves to its title after a failed submit. |

### Structure and navigation

| Component | Props type | Use it for |
|---|---|---|
| `<PageHeader>` | `PageHeaderProps` | The top of a page: breadcrumb, the one h1, a small code, a lead, actions. |
| `<Breadcrumb>` | `BreadcrumbProps` | Where this page sits. The last item is the current page. |
| `<TabNav>` | `TabNavProps` | Tabs that are links, with `aria-current="page"` and a 3 px underline on the current one. |
| `<Stepper>` | `StepperProps` | The steps of a task in order: filled when done, ringed when current, thin when upcoming. Never a progress bar. |
| `<Table>` | `TableProps` | Data. Sortable headers are buttons; under 640 px of container width the rows become cards. |
| `<ItemPlate>` | `ItemPlateProps` | One item of a list: name, small code, status mark and one line of state. With an address the whole plate is the link. `current` adds a 2 px border and the pin "You are here". |
| `<RouteRow>` | `RouteRowProps` | A stage as one row of marks with its tally. |
| `<RouteTally>` | inline | The tally alone, without the row of marks: a list of a 16 px shape, a bold count and the words, with an (i) `<TermTip>` where `define` gives one. |
| `<StatusMark>` | `StatusMarkProps` | A status as a shape and its words. |
| `<MarkShape>` | inline | A status shape alone, for a caller that writes the words. |
| `<SavedMark>` | `SavedMarkProps` | The confirmation of a save. |

### Messages and loading

| Component | Props type | Use it for |
|---|---|---|
| `<Callout>` | `CalloutProps` | A note or a caution inside content. A caution adds the `triangle-alert` icon and a 4 px border in `--color-heading`. |
| `<Banner>` | `BannerProps` | A notice about the page or the session: `offline`, `archived`, `session` or `info`, each with its icon. Ordinary flow content, not fixed. |
| `<StatusRegion>` | `StatusRegionProps` | The line that announces an action's result. Always mounted and empty until there is a message; `polite` or `assertive`; `neutral` or `error` tone. |
| `<EmptyState>` | `EmptyStateProps` | An empty place: what is missing, why, and at most one action. |
| `<Skeleton>` | `SkeletonProps` | A static placeholder while content loads. Nothing moves. |

### Words, time and icons

| Component | Props type | Use it for |
|---|---|---|
| `<Definition>` | inline | The hint line beside a term's first use. Only a term the vocabulary marks `defineOnFirstUse` gets one. |
| `<Term>` | inline | Wraps the first use of a defined term. |
| `<TermTip>` | `TermTipProps` | A small (i) button, a 24 px target, that opens the vocabulary's sentence in a popover (a toggletip). Focus alone does not open it. |
| `<LocalTime>` | `LocalTimeProps` | An instant in the reader's time zone, without the zone's name. Server and first render say UTC. |
| `<Icon>` | `IconProps` | One icon at 16, 18, 20 or 24 px, always beside a word, hidden from assistive technology. |

Helpers exported beside the components (`statusMarkWords`, `closeOnBlur`, `given`, `describedBy`, `termTipIds` and the scroll helpers in `revealInView.ts`) are in the inventory under helpers; they are not components.

## The shell

`components/layout/AppShell.tsx` and `Rail.tsx`, styled by `components/layout/shell.css` (classes `.shell`, `.shell-rail`, `.shell-topbar`, `.shell-project`, `.shell-org`).

- **Wide (from 1024 px).** A navy rail: the MAK-AI logo and the platform's name, the organisation's name (with a switcher for a person in more than one), then Home, Projects, Findings, Guidance and Help, then the project block when a project is open, then Members and Organisation in a lower group, the signed-in person and their role, My account, and a Sign out button beside the theme switch. Items are at least 44 px high. See `docs/design/screens/home-1280-light.webp`, `docs/design/screens/home-1280-dark.webp`, `docs/design/screens/project-1280-light.webp`, `docs/design/screens/findings-1280-light.webp` and `docs/design/screens/findings-1280-dark.webp`.
- **Narrow.** A top bar with the logo and a labelled Menu button, which opens the rail in a panel built on the declarative `popover` attribute. With a project open the bar shows the project's name instead of the logo; on a page with a stage in the address it also shows the stage and an "All questions" link (`components/layout/ShellProject.tsx`).
- **Public pages.** A light header and the footer (`components/layout/PublicHeader.tsx`, `Footer.tsx`); see `docs/design/screens/help-1280-light.webp` and `docs/design/screens/help-1280-dark.webp`.
- **Rail text.** Never orange except the peach "You are here" (see The route).
- **Theme.** A switch in the rail's foot (`components/layout/ThemeToggle.tsx`); its words change with the theme and are its accessible name.

## The gate frame

Screens that have no rail because the person has not arrived, or cannot yet go on, share the gate frame (`components/layout/GateFrame.tsx`, `GatePublicFrame.tsx`, `gate.css`; ruling R6): sign-in, reset, invitations, the legal texts, the organisation chooser, session warnings and the forced password change.

- From 1024 px a navy column at the rail's width holds the logo, the platform's name, the route of this door (the step the person is on) and, when signed in, the person's name, Help and Sign out. Beside it is a white card on the ground, up to 30 rem wide. Below 1024 px the column is a navy band above the card; below 320 px the card meets the screen's edges.
- Nothing in the frame is orange. It links nowhere a gated account cannot go.
- A page that is signed out uses the lean public variant, which does not load the signed-in sheet (`gate-signed-in.css`) or the sign-out code. See `docs/design/screens/sign-in-1280-light.webp` and `docs/design/screens/sign-in-1280-dark.webp`.

**The root not-found page** cannot import the frame's component or its stylesheet without putting them on every page's first load. `lib/errors/frame.ts` therefore copies the frame's public variant as inline styles, rendered on the server into the 404 page only, using role tokens and no literal colour. Widths are stepped with `clamp()` in place of media queries. See `docs/design/screens/not-found-1280-light.webp` and `docs/design/screens/not-found-1280-dark.webp`.

**The error pages keep the 0.7.0 look** (the owner's ruling of 15 November 2026, 14:05, as probe D). `app/error.tsx` still draws a centred `auth-card`, and `app/global-error.tsx` imports it, so it keeps the same look; its words come from `lib/errors/copy.ts`. This is a recorded departure from the gate frame's look; a later release frames them.

## The project page

S-10, `components/project/ProjectPage.tsx`, `StageLine.tsx`, `ProjectPage.css` (ruling R5; spec 9.2). Three stages side by side, each a vertical line with exactly five stops: the stage (name, plain meaning, question count, and on the stage the person last saved in, the next question and the one primary button); what is still open; what is recorded so far; its reviews; and the last stop, with the link to the stage's questions. The lines go side by side from 52 rem (832 px) of container width (`ProjectPage.css`); below that they stack and the next step is shown once above them. Under the lines are the share line and a quiet "This project" row with Archive last. See `docs/design/screens/project-1280-light.webp` and `docs/design/screens/project-1280-dark.webp`.

**Owner ruling of 15 November 2026, 20:50** (`progress.md`, line "20:50 OWNER RULED"): S-10 has no row of marks. Its tally is in words with marks, as sketched. Its mitigations are the overdue ones as plates, plus one line "{n} other open mitigations" linking to Findings. This departs from SRS FR-FUP-01 and FR-FUP-05.

**Owner ruling of 19 November 2026** ("Allow progress display", design section 5 of `Claude outputs/2026-11-19-path-to-outputs-design.md`; it reverses the no-progress rule of this section): S-10 may show one bar per stage, "N of M questions recorded", with the count in words beside it. The bar is a `<progress>` or a proportional fill inside an element carrying `data-stage-bar`, on the project page only. There is still no score, no percentage, and no total or bar across stages; the claims lint now allows the word "progress", and `e2e/helpers/noScore.ts` allows the bar only there, and still fails a `%` inside it. "Outputs without sealing" (same section): the working report is a draft from current answers, not a sealed record.

**Built** (owner rulings of 19:25, 20:50 and 21:32). "Still open in this stage" shows a count. Overdue mitigations are `<ItemPlate>`s, followed by one line "{n} other open mitigations" linking to Findings. "Recorded so far" is `<RouteTally>`: the tally in words with a mark beside each count and no row of marks. First-use definitions are (i) `<TermTip>`s. Each review is one line, "Review n · sealed <date> · k changed since". A busy project still runs about 1,098 px tall at 1440 by 900 (known, deferred).

Home has one "New project" for an Owner, an Admin and an Assessor.

What is built and stays: counts are words and numerals for one stage, with no percentage and no total or bar across stages, and at most one `data-stage-bar` bar per stage on S-10; an overdue plate is an `<ItemPlate>` whose "was due <date>" alone is in `--color-overdue`.

## The working report

`components/report/WorkingReportView.tsx` and `report.css`, the page `…/projects/<id>/report` (path to outputs, G1). It refines the project page's world and adds no new one: one column at `--max-width-narrow`, the h1 and h2 steps of the type scale, hairlines in `--color-border-container` between items, no card around a section and no colour for a status. It holds links only: one primary `.ui-button--primary` link downloads the whole report as a PDF and a row of text links downloads each part. It has no button and no field, so there is nothing a role can see and not use. The answers are page 1 ("Where this project stands") and then each draft document, with each field as a code and label beside its text and a small provenance line.

- **The draft line** is the one box that carries the page's draft state: a 2 px `--color-heading` border on `--color-tint`, semibold, always the first block. On screen it is `position: sticky` at the top of the scroll area, so it stays in view wherever the report is scrolled to. In print it is `position: fixed`, which the browser repeats on every printed page; the content sits in a real table whose empty header group is as tall as the line and is repeated too, so no text of any page starts under it (a header group on a `div` is not repeated). Its words are `draftLine` of `lib/documents/copy.ts`, the same as the PDF's.
- **Print** is black on white whatever the theme and omits the downloads.
- **No score.** Nothing on the page counts or rates the project; the one number is a field's own answer.

## Voice and vocabulary

- **The words are the vocabulary's.** `data/vocabulary.json` is generated from `records/plans/2026-11-11-ux-redesign/copy-audit/CONSOLIDATED.md` section 2 by `scripts/vocabulary/generate.mjs`; it holds 116 concepts, each with a term, a definition of at most 20 words and the terms to retire, and its lint rules are in `scripts/vocabulary/lint-rules.json`. The typed form is `lib/vocabulary/terms.ts`. `__tests__/lint/vocabulary.test.ts` fails when a retired term appears in copy.
- **A term is defined where it is first met**, in the same sentence every time: `<Term>` marks the use and `<Definition>` or `<TermTip>` gives the sentence.
- **Copy lives in modules.** Each area keeps its strings in `lib/<area>/copy.ts` (for example `lib/ui/copy.ts`, `lib/shell/copy.ts`, `lib/project/copy.ts`, `lib/errors/copy.ts`); components and tests read the same constants. `__tests__/lint/copy-modules.test.ts` and `no-inline-copy.test.ts` hold this.
- **Voice rules** are the twelve rules of `CONSOLIDATED.md` section 3. Not restated here.
- **Claims.** The claim-word bans (compliance, certified, approved, audit-ready, aligned with) stay, and "The team decides; the platform records" is the no-score principle in words (spec section 6).
- **Dates and times** are written in the reader's time zone without a zone name ("11 Nov 2026, 11:23"); `<LocalTime>` does it.

## Motion

- **State changes only.** `--duration-state` is 160 ms with `--easing-state` `cubic-bezier(0.2, 0, 0, 1)`. Kit components change colour, border or rotation over it. Nothing animates on page load, and no component animates on a timer (`shell.css`, `Skeleton.css`).
- **Reduced motion.** `app/globals.css` sets animation and transition durations to 0.01 ms, one iteration and `scroll-behavior: auto` under `prefers-reduced-motion: reduce`. The button spinner turns (0.9 s, linear) only under `prefers-reduced-motion: no-preference`, and a folded run's chevron turns only under the same query.
- **Left over.** `app/globals.css` still holds a `.reveal` class (0.6 s fade and rise, keyframes `fadeInUp`) from before the redesign. No `.tsx` file under `app` or `components` uses it.
- **Scroll cue.** The rail's scrolling part shows an edge cue that follows the scroll position, by scroll-state queries or, failing those, `animation-timeline: scroll()` (`components/layout/shell.css`). It never runs on a timer.

## Icons

Inline SVG from the Lucide set (ISC licence, the licence text sits beside the registry), copied as path data into the registry file in the kit folder: a 24 px grid, a 2 px round stroke in the current text colour, always beside a word, never focusable. The registry holds these 29: `archive`, `arrow-up`, `book-open`, `building-2`, `chevron-down`, `chevron-left`, `chevron-right`, `chevrons-up-down`, `circle-check`, `circle-help`, `clock`, `download`, `external-link`, `flag`, `folder`, `home`, `info`, `log-out`, `menu`, `moon`, `paperclip`, `pencil`, `plus`, `sun`, `triangle-alert`, `user`, `users`, `wifi-off`, `x`. A new icon goes into the same registry, from the same set.

## Do's and don'ts

- Do use one primary button per view, in `--color-action`; do not use the action orange as text.
- Do say a status in a shape and a word; do not colour-code a status, and do not add a score, a percentage or a total. The only bar is the per-stage `data-stage-bar` on S-10, with its count in words.
- Do keep green for the Done mark and the "Saved" confirmation, and red for an overdue date and the word "Overdue".
- Do put a term's definition beside its first use; do not use a retired term.
- Do read colours, sizes and spaces from the tokens; do not write a literal value in a component's sheet.
- Do keep marks and rings in borders or strokes so forced colours keep them.
- Do keep a destructive action out of the primary colour and out of the primary button's company; confirm it in place with `<InlineConfirm>`.
- Do not put a status mark's colour on anything but `--color-mark`, except Done's disc.
- Do not add orange text to the navy shell beyond the one peach "You are here".
