import type { ReactNode } from 'react';
import { Term } from '@/components/ui/Definition';
import { TERM_MITIGATION_PLAN } from '@/lib/vocabulary/terms';
import type { VocabularyEntry } from '@/lib/vocabulary/types';

/**
 * Marking a term inside a fixed text, such as a heading or a line built from copy (spec 6; lane 6, B4): the words stay
 * as written and the first use of the term is wrapped in `Term`, reading a use as the first-use rule does
 * (lib/vocabulary/firstUse.ts). No styles, so a component that repeats on a page (SealMarker) can use it.
 */

/**
 * The checked terms that hold a shorter checked term: the first-use rule (lib/vocabulary/firstUse.ts) reads "mitigation
 * plan" as a use of `mitigation-plan`, not of `mitigation`, so `markTerms` does too. A unit test
 * (__tests__/unit/review-term-list.test.tsx) fails if the vocabulary gains another such pair.
 */
const LONGER_TERMS: readonly VocabularyEntry[] = [TERM_MITIGATION_PLAN];

/** The term as whole words, as the first-use rule reads it: case-insensitive, the last word may take a plural `s`. */
function termPattern(term: string, flags: string): RegExp {
  const words = term.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}s?(?![\\p{L}\\p{N}])`, flags);
}

/** Where `entry` is first used in `text`, outside any longer checked term that holds it, or null. */
function firstMatch(text: string, entry: VocabularyEntry): { start: number; end: number } | null {
  const longer = LONGER_TERMS.filter((l) => l.id !== entry.id && l.term.length > entry.term.length && termPattern(entry.term, 'iu').test(l.term));
  // Blank the longer terms with spaces of the same length, so the indexes still point into `text`.
  const blanked = longer.reduce((t, l) => t.replace(termPattern(l.term, 'giu'), (m) => ' '.repeat(m.length)), text);
  const m = termPattern(entry.term, 'iu').exec(blanked);
  return m === null ? null : { start: m.index, end: m.index + m[0].length };
}

/** Whether `text` uses `entry` (as the first-use rule reads a use). */
export const usesTerm = (text: string, entry: VocabularyEntry): boolean => firstMatch(text, entry) !== null;

/**
 * `text` with the first use of each of `entries` wrapped in `Term`, the words kept as written ("Seal" stays "Seal").
 * An entry the text does not use is skipped; a use that overlaps an earlier one is skipped too.
 */
export function markTerms(text: string, entries: readonly VocabularyEntry[]): ReactNode {
  const uses = entries
    .map((of) => ({ of, at: firstMatch(text, of) }))
    .filter((u): u is { of: VocabularyEntry; at: { start: number; end: number } } => u.at !== null)
    .sort((a, b) => a.at.start - b.at.start);
  const parts: ReactNode[] = [];
  let from = 0;
  for (const u of uses) {
    if (u.at.start < from) continue;
    if (u.at.start > from) parts.push(text.slice(from, u.at.start));
    parts.push(<Term key={u.of.id} of={u.of}>{text.slice(u.at.start, u.at.end)}</Term>);
    from = u.at.end;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
}
