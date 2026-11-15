import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { markTerms } from '@/components/review/markTerms';
import { TermLine, TermList, termListId } from '@/components/review/TermList';
import { Term } from '@/components/ui/Definition';
import * as terms from '@/lib/vocabulary/terms';
import { TERM_FINDING, TERM_MITIGATION, TERM_MITIGATION_PLAN, TERM_MODEL_CARD, TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';
import { firstUseProblems } from '../helpers/firstUseMarkup';
import { SealMarker } from '@/components/review/SealMarker';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { SealRef } from '@/types/seal';

/** Lane 6, B4: the glossary under a page heading and the marking of a term inside a fixed text (spec 6; definitions-howto). */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
/** A text as React writes it in markup. */
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll("'", '&#x27;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

describe('markTerms', () => {
  it('wraps the first whole-word use of each term, case-insensitive, keeping the text as written', () => {
    expect(html(markTerms('Seal "Pre-processing review 1"', [TERM_SEAL, TERM_STAGE_1])))
      .toBe('<span data-term="seal">Seal</span> &quot;<span data-term="stage-1">Pre-processing</span> review 1&quot;');
  });

  it('takes a plural s, and only the first use', () => {
    expect(html(markTerms('Open findings and closed findings', [TERM_FINDING])))
      .toBe('Open <span data-term="finding">findings</span> and closed findings');
  });

  it('does not match inside a longer word, nor a term a longer term holds', () => {
    expect(html(markTerms('Sealed and sealing', [TERM_SEAL]))).toBe('Sealed and sealing');
    expect(html(markTerms('Mitigation plan', [TERM_MITIGATION]))).toBe('Mitigation plan');
    expect(html(markTerms('Open a stage review', [TERM_STAGE_REVIEW]))).toBe('Open a <span data-term="stage-review">stage review</span>');
  });

  it('knows every checked term that holds a shorter checked term (the rule in lib/vocabulary/firstUse.ts consumes it)', () => {
    const checked = Object.values(terms).filter((t) => t.defineOnFirstUse);
    for (const short of checked) {
      for (const long of checked) {
        if (long === short || !new RegExp(`(?<![\\p{L}\\p{N}])${short.term}s?(?![\\p{L}\\p{N}])`, 'iu').test(long.term)) continue;
        expect(html(markTerms(long.term, [short])), `${long.id} holds ${short.id}`).toBe(long.term);
      }
    }
  });

  it('leaves a text with no use as it is', () => {
    expect(html(markTerms('Status', [TERM_SEAL, TERM_MITIGATION_PLAN]))).toBe('Status');
  });
});

describe('TermList', () => {
  it('pairs each term with its definition: dt, then dd holding the Definition with an id a heading can name', () => {
    const out = html(<TermList idPrefix="p" items={[{ of: TERM_FINDING, marked: false }, { of: TERM_MITIGATION, marked: true }]} />);
    expect(out).toBe(
      '<dl class="term-list">'
      + `<dt>Finding</dt><dd><span class="ui-definition" id="${termListId('p', TERM_FINDING)}" data-definition="finding">${TERM_FINDING.definition}</span></dd>`
      + `<dt><span data-term="mitigation">Mitigation</span></dt><dd><span class="ui-definition" id="p-mitigation" data-definition="mitigation">${TERM_MITIGATION.definition}</span></dd>`
      + '</dl>',
    );
  });

  it('renders nothing with no items', () => {
    expect(html(<TermList idPrefix="p" items={[]} />)).toBe('');
  });
});

describe('TermLine (FX4, DF I5)', () => {
  it('gives a definition its subject: the term as a label, then the Definition as the first element, so it stays beside the use before it', () => {
    expect(html(<TermLine of={TERM_MODEL_CARD} />)).toBe(
      `<p class="term-line">Model card. <span class="ui-definition" data-definition="${TERM_MODEL_CARD.id}">${esc(TERM_MODEL_CARD.definition)}</span></p>`,
    );
  });

  it('passes the crawl rule when it follows the block that holds the first use', () => {
    const out = html(<><p>Write a <Term of={TERM_MODEL_CARD}>model card</Term>.</p><TermLine of={TERM_MODEL_CARD} /></>);
    expect(firstUseProblems(out)).toEqual([]);
  });
});

const ref = (sealNumber: number, reviewName: string): SealRef => ({ sealId: `s-${sealNumber}`, sealNumber, reviewId: 'r1', reviewName });

describe('SealMarker defineTerms (ruling X-5)', () => {
  it('is off by default: no term and no definition', () => {
    const out = html(<SealMarker seals={[ref(1, 'Pre-processing review 1')]} />);
    expect(out).toBe(`<ul class="seal-markers"><li>${REVIEW_COPY.mounted.sealMarker(1, 'Pre-processing review 1')}</li></ul>`);
  });

  it('marks the first marker\'s "seal" and stage name, with both definitions in the same item; later markers stay plain', () => {
    const [first, second] = html(<SealMarker defineTerms seals={[ref(1, 'In-processing review 1'), ref(2, 'In-processing review 1')]} />).split('</li>');
    expect(first).toBe(
      '<ul class="seal-markers"><li>In <span data-term="seal">seal</span> 1 of <span data-term="stage-2">In-processing</span> review 1'
      + `<p class="ui-definition" data-definition="seal">${esc(TERM_SEAL.definition)}</p>`
      + `<p class="ui-definition" data-definition="stage-2">${TERM_STAGE_2.definition}</p>`,
    );
    expect(second).toBe(`<li>${REVIEW_COPY.mounted.sealMarker(2, 'In-processing review 1')}`);
  });
});

describe('SealMarker defineTerms: a name with no stage', () => {
  it('marks "seal" alone', () => {
    const out = html(<SealMarker defineTerms seals={[ref(1, 'Review 1')]} />);
    expect(out).toContain('<span data-term="seal">seal</span>'); expect(out).not.toContain('data-term="stage-');
    expect(out).not.toContain('data-definition="stage-');
  });
});
