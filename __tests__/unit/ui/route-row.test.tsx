import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RouteRow, type RouteRowProps } from '@/components/ui/RouteRow';
import { decode, textOf } from '@/__tests__/helpers/markup';
import { tallyWords, UI_COPY } from '@/lib/ui/copy';
import type { Tally } from '@/lib/ui/marks';
import type { StatusMarkKind } from '@/components/ui/types';
import { TERM_DOES_NOT_APPLY, TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '@/lib/vocabulary/terms';

/** Plan 1A Task 3, spec 7.2: a stage is a row of marks, one per question in question order; no fill, no percentage, no total. */

const STOPS: RouteRowProps['stops'] = [
  { id: 'q1', kind: 'done', title: 'Data sources are recorded', href: '/q/1' },
  { id: 'q2', kind: 'partly', title: 'Consent covers this use', href: '/q/2' },
  { id: 'q3', kind: 'not_yet', title: 'A data protection impact assessment exists', href: '/q/3', current: true },
  { id: 'q4', kind: 'no_decision', title: 'Retention is set' },
];
const TALLY = { done: 1, partly: 1, not_yet: 1, no_decision: 1 };


describe('RouteRow', () => {
  it('RouteRow: one stop per item in order, no progress element, no percentage', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    // The brief's pattern was /class="ui-route-row__stop/; it also matched the list's own class "ui-route-row__stops".
    expect(html.match(/class="ui-route-row__stop[ "]/g)).toHaveLength(STOPS.length);
    expect(html).not.toMatch(/<progress|role="progressbar"|role="meter"|%|style="[^"]*width/);
    expect(html).toContain('aria-current="step"');
  });

  it('the list is labelled, and each stop says its title and its status in words, in question order', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html).toMatch(/<ol class="ui-route-row__stops" role="list" aria-label="Pre-processing">/);
    // The words as they are read: the title's own element (the case below) adds no text.
    const spoken = [...html.matchAll(/<span class="visually-hidden"><span>([^<]*)<\/span>([^<]*)<\/span>/g)].map((m) => decode(m[1] + m[2]));
    expect(spoken).toEqual([
      'Data sources are recorded: Done', 'Consent covers this use: Partly',
      'A data protection impact assessment exists: Not yet', 'Retention is set: No decision',
    ]);
  });

  it('a stop\'s title is the whole text of an element of its own, apart from its status words', () => {
    // FR-PUB-01: the claims crawl (e2e/claims-crawl.spec.ts) exempts an allow-listed question text only as a WHOLE text
    // node. A stage's stops are titled by its questions, so the title must not share its node with the status words.
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    for (const [title, words] of [['Data sources are recorded', 'Done'], ['Retention is set', 'No decision']]) {
      expect(html).toContain(`<span class="visually-hidden"><span>${title}</span>: ${words}</span>`);
    }
  });

  it('only the current stop carries aria-current and the current class, and a stop with an address is a link', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="ui-route-row__stop ui-route-row__stop--current"[^>]*><a [^>]*aria-current="step"[^>]*href="\/q\/3"/);
    expect(html.match(/<a /g)).toHaveLength(3);
  });

  it('the tally follows the row as a list, one item per kind above zero, in the tally\'s order', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={STOPS} tally={TALLY} />);
    expect(html).toMatch(/<\/ol><ul class="ui-route-row__tally" role="list">/);
    expect(items(html).map((i) => i.kind)).toEqual(['done', 'partly', 'not_yet', 'no_decision']);
    expect(html).not.toContain('<p class="ui-route-row__tally">');
  });

  it('each tally item is the kind\'s 16 px mark, hidden from assistive technology, the count in bold, then the kind\'s words', () => {
    const html = renderToStaticMarkup(<RouteRow label="Pre-processing" stops={[]} tally={WIDE} />);
    expect(items(html).map(({ kind, body }) => [kind, body.match(/<b>(\d+)<\/b>/)?.[1], words(body)])).toEqual([
      ['done', '9', 'done (2 with no evidence attached)'], ['partly', '1', 'partly'], ['not_yet', '2', 'not yet'],
      ['does_not_apply', '3', 'do not apply'], ['scope_answered', '1', 'answered'], ['no_decision', '4', 'no decision'],
    ]);
    for (const { kind, body } of items(html)) {
      // The mark is the kit's shape for that kind (the stops draw the same one at 20 px), at 16 px and aria-hidden.
      const shape = body.match(/^<svg class="ui-mark__shape" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">(.*?)<\/svg>/);
      expect(shape, kind).not.toBeNull();
      const stopShape = renderToStaticMarkup(<RouteRow label="x" stops={[{ id: 'a', kind, title: 't' }]} tally={{}} />).match(/<svg[^>]*>(.*?)<\/svg>/)![1];
      expect(shape![1], kind).toBe(stopShape);
    }
    expect(items(renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={{ does_not_apply: 1 }} />)).map((i) => words(i.body))).toEqual(['does not apply']);
  });

  it('M2: every kind of a full tally, each above zero, has its item, in the tally\'s order', () => {
    const full: Tally = { done: 1, partly: 2, not_yet: 3, not_applicable: 4, does_not_apply: 5, scope_answered: 1, no_decision: 7 };
    const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={full} />);
    expect(items(html).map((i) => i.kind)).toEqual(['done', 'partly', 'not_yet', 'not_applicable', 'does_not_apply', 'scope_answered', 'no_decision']);
    expect(items(html).map((i) => textOf(i.body)).join(', ')).toBe(tallyWords(full));
  });

  it('a screen reader hears the tally\'s words, in its order: the items read together are tallyWords', () => {
    for (const t of [TALLY, WIDE, { done: 1 }, { done: 3, doneNoEvidence: 1 }, { does_not_apply: 1, scope_answered: 1 }, { not_applicable: 12 }] as Tally[]) {
      const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={t} define={ALL_DEFINED} />);
      // The (i) is a button of its own beside the word; what the item says is the rest of it.
      expect(items(html).map((i) => textOf(i.body.replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, ''))).join(', '), JSON.stringify(t)).toBe(tallyWords(t));
    }
  });

  it('K2: a count never parts from its word (nowrap), the caveat is whole too, the items wrap between each other with a gap, at the small size', () => {
    const css = readFileSync('components/ui/RouteRow.css', 'utf8');
    expect(css).toMatch(/\.ui-route-row__tally \{[^}]*display: flex;[^}]*flex-wrap: wrap;[^}]*gap: 0 var\(--space-3\);[^}]*\}/);
    expect(css).toMatch(/\.ui-route-row__tally \{[^}]*font-size: var\(--font-size-small\);[^}]*\}/);
    expect(css).toMatch(/\.ui-route-row__tally-count,\s*\.ui-route-row__tally-caveat \{[^}]*white-space: nowrap;[^}]*\}/);
    // M1: the count, its word and the (i) are one nowrap flex unit, so the (i) never drops below its word; the caveat is
    // another, the only place an item may break.
    expect(css).toMatch(/\.ui-route-row__tally-count \{[^}]*display: inline-flex;[^}]*\}/);
    const one = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={{ done: 9, doneNoEvidence: 2, partly: 1 }} define={ALL_DEFINED} />);
    expect(one).toContain('<span class="ui-route-row__tally-count"><span class="ui-route-row__tally-word"><b>9</b> <span data-term="done">done</span></span><span class="ui-term-tip">');
    expect(one).toContain('<span class="ui-route-row__tally-count"><span class="ui-route-row__tally-word"><b>1</b> <span data-term="partly">partly</span></span><span class="ui-term-tip">');
    // M4: the 24 px rhythm is a minimum block size, the line height unitless, so enlarged text grows its lines.
    expect(css).toMatch(/\.ui-route-row__tally-item \{[^}]*line-height: var\(--line-height-body\);[^}]*\}/);
    expect(css).toMatch(/\.ui-route-row__tally-count \{[^}]*min-block-size: var\(--target-min\);[^}]*\}/);
    expect(css).not.toMatch(/line-height: var\(--target-min\)/);
    expect(one).toMatch(/<\/span><\/span> <span class="ui-route-row__tally-caveat">\(2 with no evidence attached\)<\/span><\/span>$|<\/span><\/span><\/span> <span class="ui-route-row__tally-caveat">\(2 with no evidence attached\)<\/span>/);
    // The shape is in the mark colour, as the stops' are; the item itself carries no mark class, so the (i) and its
    // popover are not read as part of a mark (e2e/helpers/noScore.ts expectStatusMarksInk).
    expect(css).toMatch(/\.ui-route-row__tally-item > \.ui-mark__shape \{[^}]*color: var\(--color-mark\);[^}]*\}/);
    const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={WIDE} define={ALL_DEFINED} />);
    for (const { body } of items(html)) expect(body).not.toMatch(/class="ui-mark[ "]|data-mark-kind/);
  });

  it('with nothing to count, the tally says so in words', () => {
    const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={{}} />);
    expect(html).toContain(`</ol><p class="ui-route-row__tally">${UI_COPY.tally.none}</p>`);
    expect(html).not.toContain('ui-route-row__tally-item');
  });

  it('define: the (i) sits in exactly the named kinds\' items, after the words marked as the term, with the vocabulary\'s sentence', () => {
    const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={WIDE} define={{ done: 'What does "Done" mean?', not_yet: 'What does "Not yet" mean?' }} />);
    expect(html.match(/class="ui-term-tip"/g)).toHaveLength(2);
    const byKind = Object.fromEntries(items(html).map((i) => [i.kind, i.body]));
    for (const [kind, term, label] of [['done', TERM_DONE, 'What does &quot;Done&quot; mean?'], ['not_yet', TERM_NOT_YET, 'What does &quot;Not yet&quot; mean?']] as const) {
      const body = byKind[kind];
      expect(body, kind).toMatch(new RegExp(`<b>\\d+</b> <span data-term="${term.id}">${term.term.toLowerCase()}</span>`));
      expect(body, kind).toContain(`aria-label="${label}"`);
      expect(body, kind).toContain(`<span class="ui-definition" id="term-tip-${term.id}-def" data-definition="${term.id}">${term.definition}</span>`);
      // The tip sits right after the word (the owner's "beside the word"), before the evidence caveat on done.
      expect(body, kind).toMatch(new RegExp(`<span class="ui-route-row__tally-count"><span class="ui-route-row__tally-word"><b>\\d+</b> <span data-term="${term.id}">[^<]*</span></span><span class="ui-term-tip">`));
      if (kind === 'done') expect(body.indexOf('ui-route-row__tally-caveat')).toBeGreaterThan(body.indexOf('ui-term-tip'));
    }
    for (const kind of ['partly', 'does_not_apply', 'scope_answered', 'no_decision']) {
      expect(byKind[kind], kind).not.toMatch(/data-term|ui-term-tip/);
    }
    // A named kind with no count draws nothing.
    expect(renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={{ done: 1 }} define={{ partly: 'What does "Partly" mean?' }} />)).not.toContain('ui-term-tip');
  });

  it('define: every defined status kind has its vocabulary entry; no decision and the answered personal data question have none', () => {
    const html = renderToStaticMarkup(<RouteRow label="x" stops={[]} tally={{ ...WIDE, not_applicable: 1 }} define={ALL_DEFINED} />);
    const byKind = Object.fromEntries(items(html).map((i) => [i.kind, i.body]));
    for (const [kind, term] of [['done', TERM_DONE], ['partly', TERM_PARTLY], ['not_yet', TERM_NOT_YET], ['not_applicable', TERM_NOT_APPLICABLE], ['does_not_apply', TERM_DOES_NOT_APPLY]] as const) {
      expect(byKind[kind], kind).toContain(`data-definition="${term.id}">${term.definition}</span>`);
    }
    expect(byKind.no_decision).not.toContain('ui-term-tip');
    expect(byKind.scope_answered).not.toContain('ui-term-tip');
    // @ts-expect-error "no decision" is not defined on first use (vocabulary: defineOnFirstUse false), so it cannot be named.
    void (<RouteRow label="x" stops={[]} tally={{}} define={{ no_decision: 'x' }} />);
    // @ts-expect-error the answered personal data question's words in a tally ("answered") are not that term.
    void (<RouteRow label="x" stops={[]} tally={{}} define={{ scope_answered: 'x' }} />);
  });
});

/** Every status kind the vocabulary defines on first use, named. */
const ALL_DEFINED: NonNullable<RouteRowProps['define']> = {
  done: 'What does "Done" mean?', partly: 'What does "Partly" mean?', not_yet: 'What does "Not yet" mean?',
  not_applicable: 'What does "Not applicable" mean?', does_not_apply: 'What does "Does not apply" mean?',
};
const WIDE: Tally = { done: 9, doneNoEvidence: 2, partly: 1, not_yet: 2, not_applicable: 0, does_not_apply: 3, scope_answered: 1, no_decision: 4 };

/** The tally's items, in order: the kind each is for and its inner markup. */
function items(html: string): Array<{ kind: StatusMarkKind; body: string }> {
  return [...html.matchAll(/<li class="ui-route-row__tally-item" data-tally-kind="([a-z_]+)">(.*?)<\/li>/g)].map((m) => ({ kind: m[1] as StatusMarkKind, body: m[2] }));
}
/** An item's words after its bold count, without the (i). */
const words = (body: string) => textOf(body.replace(/<span class="ui-term-tip">.*?<\/span><\/span><\/span>/, '').replace(/^.*?<\/b>/, '')).trim();
