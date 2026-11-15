import vocabulary from '@/data/vocabulary.json';
import { HELP_COPY } from '@/lib/help/copy';

/**
 * The list "Words used on the platform" of Help, `/help` (plan 1A Task 12, ruling L2-69): every concept of
 * data/vocabulary.json with a definition and not marked historical, grouped by its group, groups and concepts in the
 * file's order. Server only: only the Help page imports it, so no definition reaches a browser bundle (ruling X-2). It is
 * not a copy module (a copy module reads no data). Each group carries the heading Help shows for it (HELP_COPY's
 * `groupHeadings`, ruling D5).
 */

export type HelpEntry = { readonly id: string; readonly term: string; readonly definition: string };
export type HelpGroup = { readonly name: string; readonly heading: string; readonly entries: readonly HelpEntry[] };

type Concept = { id: string; group: string; term: string; definition?: unknown; historical?: unknown };

/**
 * A term as the reader sees it: each `{…}` placeholder becomes the one character U+2026 (the coordinator's answer Q2), so
 * "Check again on {date}" reads "Check again on …". A two-label term ("Decided by; Entered by") is kept as it is.
 */
export function helpTerm(term: string): string {
  return term.replace(/\{[^{}]*\}/g, '…');
}

function buildGroups(): readonly HelpGroup[] {
  const groups: { name: string; heading: string; entries: HelpEntry[] }[] = [];
  for (const c of (vocabulary as { concepts: Concept[] }).concepts) {
    if (typeof c.definition !== 'string' || c.historical !== undefined) continue;
    let group = groups.find((g) => g.name === c.group);
    if (group === undefined) {
      group = { name: c.group, heading: HELP_COPY.words.groupHeadings[c.group] ?? c.group, entries: [] };
      groups.push(group);
    }
    group.entries.push({ id: c.id, term: helpTerm(c.term), definition: c.definition });
  }
  return groups;
}

/** Built once, when the module loads: the file is part of the build, so the list cannot change while the server runs. */
const GROUPS = buildGroups();

export function helpVocabulary(): readonly HelpGroup[] {
  return GROUPS;
}
