import { Fragment, type ReactElement } from 'react';
import { Definition, Term } from '@/components/ui/Definition';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';
import './TermList.css';

/**
 * Spec 6 on the findings and review screens (lane 6, B4; definitions-howto.md): the terms a page uses near its top,
 * each with its definition, in a short list under the page heading. The words are the vocabulary's
 * (lib/vocabulary/terms.ts): a label is the term with its first letter upper-cased, and the definition is the
 * `Definition` component's, never retyped.
 */

/** The id of an entry's definition in a `TermList`, for the `aria-describedby` of a heading that holds the term. */
export const termListId = (idPrefix: string, of: VocabularyEntry): string => `${idPrefix}-${of.id}`;

/** A term as a label: the vocabulary's words with the first letter upper-cased ("stage review" reads "Stage review"). */
const labelOf = (of: VocabularyEntry): string => `${of.term.charAt(0).toUpperCase()}${of.term.slice(1)}`;

/**
 * One term of the list. `marked` is true when this label is the page's first use of the term (it is then wrapped in
 * `Term`, and its definition is the next element); false when an earlier element, such as the page's heading, holds
 * the first use and names this definition with `aria-describedby`.
 */
export type TermListItem = { of: DefinedEntry; marked: boolean };

/**
 * The terms and their definitions as a description list: a `dt` with the term, then a `dd` holding its `Definition`.
 * Nothing when there is no item. Each definition carries the id `termListId(idPrefix, entry)`.
 */
export function TermList({ items, idPrefix }: { items: readonly TermListItem[]; idPrefix: string }): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <dl className="term-list">
      {items.map(({ of, marked }) => (
        <Fragment key={of.id}>
          <dt>{marked ? <Term of={of}>{labelOf(of)}</Term> : labelOf(of)}</dt>
          <dd><Definition of={of} id={termListId(idPrefix, of)} /></dd>
        </Fragment>
      ))}
    </dl>
  );
}

/**
 * One definition with its subject (FX4, DF I5): the term as a label, then its `Definition`, in a paragraph of its own. For a
 * definition placed after a block whose text holds the first use (a card's description), where a bare definition would
 * read as a line about the block. The label is plain text, so the `Definition` stays the paragraph's first element and
 * the pair passes the rule's "next element or its first child" (definitions-howto.md).
 */
export function TermLine({ of }: { of: DefinedEntry }): ReactElement {
  return <p className="term-line">{`${labelOf(of)}. `}<Definition of={of} /></p>;
}

/**
 * The same line, placed BEFORE the text that also uses the term (a control card's description): the label is the first
 * use, marked as the term, with its `Definition` in the same paragraph. The text after it stays one whole node, so a
 * content text the claims crawl allows as a whole node is not split (FR-PUB-01; the controls page, C-17).
 */
export function TermLeadLine({ of }: { of: DefinedEntry }): ReactElement {
  return <p className="term-line"><Term of={of}>{labelOf(of)}</Term>{'. '}<Definition of={of} /></p>;
}
