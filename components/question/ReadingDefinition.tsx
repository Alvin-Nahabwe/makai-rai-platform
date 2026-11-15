import type { ReactElement } from 'react';
import { Definition } from '@/components/ui/Definition';
import { QUESTION_COPY } from '@/lib/question/copy';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import './reading.css';

/**
 * A vocabulary definition printed in the reading view WITH its term (design review S4-1): "Finding: <the vocabulary's
 * sentence>", so a reader can tell which sentence defines which word. The term is the vocabulary entry's own word; the
 * sentence is the kit's Definition, unchanged. One paragraph each, so each definition is the block of its term.
 */
export function ReadingDefinition({ of }: { of: DefinedEntry }): ReactElement {
  return (
    <p className="reading-def"><b className="reading-def__term">{QUESTION_COPY.reading.defTerm(of.term)}</b> <Definition of={of} /></p>
  );
}
