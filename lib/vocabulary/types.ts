import type { VocabularyId } from './ids';

/** One term of the vocabulary, as a component receives it (generated into lib/vocabulary/terms.ts). */
export type VocabularyEntry = {
  readonly id: VocabularyId;
  readonly term: string;
  readonly definition: string | null;
  readonly defineOnFirstUse: boolean;
};

/** An entry whose definition may be shown: the one kind `Definition` accepts at compile time. */
export type DefinedEntry = VocabularyEntry & { readonly definition: string; readonly defineOnFirstUse: true };
