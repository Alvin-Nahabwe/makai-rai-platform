import type { ReactNode } from 'react';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';
import './Definition.css';

/**
 * The hint line beside a term's first use in the main content. Only a term whose `defineOnFirstUse` is true and whose
 * definition is not null gets one. Anything else is a mistake in the screen: it throws outside production so a test
 * or the dev server shows it, and renders nothing in production so a reader never sees a broken page. The type
 * `DefinedEntry` rejects such an entry at compile time; the run-time check covers an entry built at run time.
 * `id`, when given, lets a control name the hint with `aria-describedby`.
 */
export function Definition({ of, as: Tag = 'span', id }: { of: DefinedEntry; as?: 'span' | 'p'; id?: string }) {
  if (of.definition === null || !of.defineOnFirstUse) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error(`Definition: "${of.id}" has no definition to show (definition is null or defineOnFirstUse is false)`);
    }
    return null;
  }
  return (
    <Tag className="ui-definition" id={id} data-definition={of.id}>
      {of.definition}
    </Tag>
  );
}

/** Wrap only the first use in the main content of a term whose `defineOnFirstUse` is true. */
export function Term({ of, children }: { of: VocabularyEntry; children?: ReactNode }) {
  return <span data-term={of.id}>{children ?? of.term}</span>;
}
