import vocabulary from '@/data/vocabulary.json';
import { HELP_COPY } from '@/lib/help/copy';
import * as TERMS from '@/lib/vocabulary/terms';
import type { DefinedEntry } from '@/lib/vocabulary/types';

/**
 * The list "Words used on the platform" of Help, `/help` (plan 1A Task 12, ruling L2-69): every concept of
 * data/vocabulary.json with a definition and not marked historical, grouped by its group, groups and concepts in the
 * file's order. Server only: only the Help page imports it, so no definition reaches a browser bundle (ruling X-2). It is
 * not a copy module (a copy module reads no data). Each group carries the heading Help shows for it (HELP_COPY's
 * `groupHeadings`, ruling D5), and each concept the first-use rule checks carries its vocabulary entry, so the page shows
 * it with `Term` and `Definition` (B5).
 */

export type HelpEntry = {
  readonly id: string;
  readonly term: string;
  readonly definition: string;
  /** Set only for a concept whose `defineOnFirstUse` is true. */
  readonly defined?: DefinedEntry;
};
export type HelpGroup = { readonly name: string; readonly heading: string; readonly entries: readonly HelpEntry[] };

type Concept = { id: string; group: string; term: string; definition?: unknown; historical?: unknown };

/**
 * A term as the reader sees it: each `{…}` placeholder becomes the one character U+2026 (the coordinator's answer Q2), so
 * "Check again on {date}" reads "Check again on …". A two-label term ("Decided by; Entered by") is kept as it is.
 */
export function helpTerm(term: string): string {
  return term.replace(/\{[^{}]*\}/g, '…');
}

/** The concepts the first-use rule checks, by id: lib/vocabulary/terms.ts is generated from the same file. */
const DEFINED: ReadonlyMap<string, DefinedEntry> = new Map(
  Object.values(TERMS).filter((t): t is typeof t & DefinedEntry => t.defineOnFirstUse && t.definition !== null).map((t) => [t.id, t]),
);

function buildGroups(): readonly HelpGroup[] {
  const groups: { name: string; heading: string; entries: HelpEntry[] }[] = [];
  for (const c of (vocabulary as { concepts: Concept[] }).concepts) {
    if (typeof c.definition !== 'string' || c.historical !== undefined) continue;
    let group = groups.find((g) => g.name === c.group);
    if (group === undefined) {
      group = { name: c.group, heading: HELP_COPY.words.groupHeadings[c.group] ?? c.group, entries: [] };
      groups.push(group);
    }
    const defined = DEFINED.get(c.id);
    group.entries.push({ id: c.id, term: helpTerm(c.term), definition: c.definition, ...(defined === undefined ? {} : { defined }) });
  }
  return groups;
}

/** Built once, when the module loads: the file is part of the build, so the list cannot change while the server runs. */
const GROUPS = buildGroups();

export function helpVocabulary(): readonly HelpGroup[] {
  return GROUPS;
}
