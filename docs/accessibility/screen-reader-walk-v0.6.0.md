# Screen-reader walk, v0.6.0 release candidate

NFR-A11Y-07 (SRS line 3300): the system passes a manual screen-reader pass of the two journeys
most used by people without help. UX-32 (SRS 7.6.1) and call R-58 name them: J-05 (the team
assesses a stage, including on a bad connection; SRS lines 368-378) and J-09 (the team generates a
document for an event; SRS lines 401-405). The walk is done by the person named with OD-03 (default:
the owner) on the release-candidate build (12.2 step 7). This sheet is filled in during that sitting.

Fill in the four lines below before starting. `Tool:` names the screen reader and its version, then
the browser and its version, for example `Tool: NVDA 2026.3 with Firefox 140` or
`Tool: VoiceOver macOS 16.1 with Safari 19`. `Build:` is the candidate commit (`git rev-parse HEAD`
on the tag), 7 to 40 hex characters and nothing else on the line.

Tool: (not yet walked)
Build: (not yet walked)
Started: (not yet walked)
Ended: (not yet walked)

## How to fill in a row

- **Result**: what the screen reader actually announced, in its own words where they matter.
- **Severity**: `critical` (the step cannot be completed with the screen reader), `serious` (it can
  be completed only by guessing or with sighted help), `moderate` (completed, but an announcement is
  missing, late, doubled or misleading), `minor` (wording or order that slows the person down). Leave
  `-` when the step passed.
- **Status**: `open` (not fixed on this build), `fixed` (fixed and re-walked; name the commit in
  Result), `accepted` (the owner accepts it for v1; say why in Result), or `pass`.
- A step that the build cannot reach (for example a screen not yet on the candidate) is `open` with
  severity `critical`, so the release check below fails until it is walked.

The release check (`RELEASE_CANDIDATE=1 npx vitest run __tests__/lint/screen-reader-walk.test.ts`)
fails while `Tool:` or `Build:` is unfilled or any row ends `| serious | open |` or
`| critical | open |`.

## Setting up

Use an organisation with an assessor seat and an admin seat (the admin generates the document in
J-09), one project, and the screen reader in browse mode unless a step says otherwise. Use the
keyboard alone; do not use the mouse at any point (UX-32). For J-05 step 5, turn the network off
with the browser's developer tools or the operating system after the page has loaded.

## Walk

| Journey step | What to do | What should be announced | Result | Severity | Status |
|---|---|---|---|---|---|
| J-05 step 1 | From the project's stage view (S-10), open the pre-processing stage (S-11), then move through its question list and open a question. | "Skip to content" is the first focusable element and moves focus to main (UX-04, WCAG 2.4.1); S-10 and S-11 each have one `h1` and headings in order, and the page title names the screen, the project and the product (7.6.2, 2.4.1 to 2.4.2); each stage and question status is announced as a word, never only as an icon or colour (7.6.2, 1.1.1, 1.4.1; UX-06); the counts read to-do first, per stage, never summed (UX-06, UX-07). | | | |
| J-05 step 2 | On S-12, read the page from the top before touching the form. | The question text, the principle label, "What good looks like", "Why this is asked" and the suggested controls (or a link to them) come before the answer form (UX-08); each resource link's accessible name contains its visible text (7.6.2, 2.5.3); icons are silent (UX-41). | | | |
| J-05 step 3 | Choose a status (try Not yet: a reason code select appears), write the reason, choose who decided, enter the date with **Today**, and attach evidence with "Choose file" and with a pasted link. | Status is a radio group announced with the legend "Status" and the options Done, Partly, Not yet, Not applicable with their helper text (UX-09, 7.6.2 1.3.1); the reason field announces its label with "(required)", the helper and the live count "n / 4,000 characters" (UX-12, 3.3.2); "Decided by" is one select, "You (<name>)" first (UX-11); the date is a fieldset of day, month and year with its legend (UX-10); choosing a status does not submit or move focus (7.6.2, 3.2.2); the file control is a button, not a drop zone only (2.5.7), and the upload announces M-13 then M-14. | | | |
| J-05 step 4 | Press **Save decision**. | "Saving..." (M-01) then "Saved as version 1 at <time>. Decided by: <decider>. Entered by: you." (M-03) announced politely from the save status line, once each, without moving focus (UX-25, 7.6.2 4.1.3); on a narrow window the save bar does not cover the focused element (UX-34, 2.4.11). | | | |
| J-05 step 5 | Change the reason, turn the network off, and press **Save decision**. Then close the tab and reopen the question once back online. | "Not saved: connection lost. Your answer is kept on this device. Retry." (M-05) announced assertively and once (UX-25); the offline banner (M-40) is announced politely, not repeated on every change; after reopening, the typed answer is restored and the page says so (UX-26). | | | |
| J-05 step 6 | Turn the network back on and press **Retry**. | "Already saved as version <n> at <time>." (M-04) if the first save had arrived, otherwise M-03; either announced politely, once (UX-25, UX-27). | | | |
| J-05 step 7 | With a second browser signed in as another member, save a newer version of the same question, then press Save in the first browser. | "Version <n> was saved by <name> at <time> after you started. Review it, then save yours as version <n+1> or discard it." (M-10) announced assertively; the conflict view (W-4) reads both versions with headings, and the actions "Save mine as version N+1", "Edit mine first" and "Discard mine" are buttons with those names (UX-28). | | | |
| J-05 step 8 | Save a question as Partly. Follow the finding link on S-12 to S-15. | The line "Saving 'Partly' or 'Not yet' keeps a finding open for this question, or opens one." is read under the status group (UX-09); after the save, the new finding and its link to S-15 are announced or reachable next in reading order, and the link's name says which finding it opens (FR-FND-01; WCAG 2.4.4 link purpose). | | | |
| J-05 step 9 | Open the gate question. Answer "Yes", then "No". | The scope answer is a group with a legend and the options yes, no and not sure (7.6.2, 1.3.1); choosing "Yes" or "not sure" makes the two personal-data questions available and that change is perceivable without sight (a status message or the question list updating with its count announced, 4.1.3); choosing does not submit or move focus (3.2.2). | | | |
| J-05 step 10 | Open a checklist question. Tick some options. Read the suggestions. Then press **Next**, then **Previous**. | The options are a group with a legend, each a native checkbox with its label (7.6.2, 1.3.1, 4.1.2); the suggestions name the controls for the options not ticked (FR-SUG-02); after Next and after Previous, focus lands on the new question's heading and it is announced (UX-42, 2.4.3). | | | |
| J-05 step 11 | Return to S-11. | The stage's counts reflect the saves just made, read as words and numbers for that stage only (UX-06, UX-07); filter counts, if a filter is used, are announced politely (7.6.2, 4.1.3); questions with a draft on this device are marked in text (UX-26). | | | |
| J-09 step 1 | As the admin, open S-18 from seal 1 of the pre-processing review. Choose the data card and the mitigation plan. | One `h1`; the three documents are read in the order data card, model card, mitigation plan, each with its one-line use (FR-DOC-01); each choice is a native checkbox or button whose name names the document (4.1.2, 2.5.3); choosing does not submit (3.2.2). | | | |
| J-09 step 2 | Fill the document-only fields of the data card (dataset name, instance count, licence, maintainer). | Each field has a visible label read with it, and "(required)" where it is required (3.3.2); the note that these values are "typed for this document, not part of the sealed record" is read with the fields, not only shown visually (FR-DOC-03, 1.3.1); an error names the field and how to fix it, in a summary and beside the field (M-11, 3.3.1, 3.3.3). | | | |
| J-09 step 3 | Review the full text, then issue the document. | The document's full text is readable before issuing (FR-DOC-08, 3.3.4); "Issued. SHA-256 <first eight and last four characters>. [Download PDF (<size>)]" (M-35) is announced politely once; the full SHA-256 is reachable by a button, not a hover tooltip (7.6.2, 1.4.13). | | | |
| J-09 step 4 | Open the plain-text copy and read a few fields and the footer. | The plain-text copy is offered as the accessible alternative and marked "Copy of the <document type> issued on <date>; the PDF is the issued version" (FR-DOC-07, 7.6.1); each field reads its source in text ("From Q-PP-12, version 3, ...") and an empty one reads "Not recorded"; the footer says the document comes from the team's own records and is not an approval, audit, certification or compliance statement (FR-DOC-02). | | | |
| J-09 step 5 | Download the PDF. | The download control's name contains "Download PDF" and the size (M-35, 2.5.3); the browser's download is announced; focus stays on or returns to the control (2.4.3). The PDF itself is outside WCAG's web-page scope (7.6.1); note in Result whether the screen reader could read it at all. | | | |

## Findings not tied to one step

Record here anything heard across steps (for example a live region that repeats, or a skip link
that does not move focus), with the same Severity and Status words.

| Where | What was announced | Severity | Status |
|---|---|---|---|
