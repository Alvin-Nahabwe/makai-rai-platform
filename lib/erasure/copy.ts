/**
 * The words that stand in place of erased text, on a screen and in a document (SRS 7.5.6). Both forms of each line live here,
 * side by side, so a rewording reaches both. Imports only the date formatter: `components/decision/DecisionFields.tsx` (a client
 * component on the question page) shows the screen line, and importing it from `lib/documents/copy.ts` put that whole module in
 * the page's first load. `lib/documents/copy.ts` re-exports every name, so documents and tests name them there unchanged.
 */

import { formatDay } from '@/lib/format/dates';

// SRS 7.5.6, "Erased text field" and "Erased evidence file": the lines that stand in place of erased text.
export const FILE_NAME_ERASED = 'File name erased';
// Lane 6 rows A1, A2 (B 189, B 277, C 281, C 282): "at the organisation's request". Documents are read by outsiders, so "the", not "your".
/** Who asked for an erasure, as a document says it: the end of both erasure lines. */
export const AT_ORGANISATION_REQUEST = "at the organisation's request.";
/** The same, as a screen says it to a member: the vocabulary term `erased` ("erased at your organisation's request"). */
export const AT_YOUR_ORGANISATION_REQUEST = "at your organisation's request.";
/** The erased-text line on a SCREEN (components/decision/** shows it; coordinator's ruling, 15 Nov 2026). */
export const textErasedLine = (date: string): string => `Text erased on ${formatDay(date)} ${AT_YOUR_ORGANISATION_REQUEST}`;
/** The erased-text line in a DOCUMENT, read by outsiders: "the organisation's request". */
export const docTextErasedLine = (date: string): string => `Text erased on ${formatDay(date)} ${AT_ORGANISATION_REQUEST}`;
export const fileErasedLine = (name: string, date: string): string =>
  `${name}: file erased on ${formatDay(date)} ${AT_ORGANISATION_REQUEST} Its fingerprint is kept, so seals that include it still check.`;
