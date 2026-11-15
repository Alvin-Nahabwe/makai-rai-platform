import { statusMarkWords } from '@/components/ui/StatusMark';
import type { ScopeAnswer, StatusMarkKind } from '@/components/ui/types';
import { firstUseTips } from '@/lib/question/route';
import type { StageRow } from '@/lib/question/stageList';
import * as TERMS from '@/lib/vocabulary/terms';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';

/** Every term the vocabulary defines at first use, with its definition: the ones a row's (i) may show. */
const DEFINED: readonly DefinedEntry[] = (Object.values(TERMS) as VocabularyEntry[])
  .filter((t): t is DefinedEntry => t.defineOnFirstUse && t.definition !== null);

/**
 * Fix round 4: the terms whose first use on the page is a row's question, by question id, for the route's rows to carry
 * their (i) (lib/question/route.ts firstUseTips, the crawl's own rules). `sequence` is the page's text in reading order:
 * a string is other text the page shows (before the rows or between them, as a topic's name); a row adds its question in
 * words, then its status in words, as the row shows them. Server only.
 */
export function routeTermTips(
  sequence: ReadonlyArray<string | Pick<StageRow, 'questionId' | 'text'>>,
  marks: Readonly<Record<string, StatusMarkKind>>, scopeAnswer: ScopeAnswer | null,
): Record<string, DefinedEntry[]> {
  const texts = sequence.flatMap((s) => (typeof s === 'string'
    ? [{ text: s }]
    : [{ text: s.text, questionId: s.questionId }, { text: statusMarkWords(marks[s.questionId], { scopeAnswer: scopeAnswer ?? undefined }) }]));
  return firstUseTips(texts, DEFINED);
}
