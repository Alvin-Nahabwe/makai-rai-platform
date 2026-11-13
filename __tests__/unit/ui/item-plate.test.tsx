import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemPlate } from '@/components/ui/ItemPlate';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5: ItemPlate. The name in words, then the small code, then one line of state (voice rule 8). `current`
 * shows the pin "You are here" and sets aria-current="step" on the link. A mark is StatusMark as it is, alone in __mark:
 * no mark class or data-mark-kind on any element of the plate's own.
 */

const plate = (p: Partial<Parameters<typeof ItemPlate>[0]> = {}) => renderToStaticMarkup(
  <ItemPlate title="Consent covers secondary use" code="PO-03.2" state="Decided 11 Feb 2026" mark="partly" href="/q/po-03-2" {...p} />,
);

describe('ItemPlate', () => {
  it('the order is words, code, state', () => {
    const html = plate();
    const [words, code, state] = ['Consent covers secondary use', 'PO-03.2', 'Decided 11 Feb 2026'].map((s) => html.indexOf(s));
    expect(words).toBeGreaterThanOrEqual(0);
    expect(words).toBeLessThan(code);
    expect(code).toBeLessThan(state);
    expect(html).toMatch(/<p class="ui-plate__code">PO-03.2<\/p>/);
    expect(html).toMatch(/<div class="ui-plate__state">Decided 11 Feb 2026<\/div>/);
  });

  it('current gives aria-current="step" on the link and the pin "You are here"', () => {
    const html = plate({ current: true });
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<a class="ui-plate__link" aria-current="step" href="\/q\/po-03-2">Consent covers secondary use<\/a>/);
    expect(html).toMatch(/<p class="ui-plate__pin">You are here<\/p>/);
    expect(html).toMatch(/^<div class="ui-plate ui-plate--current ui-plate--link">/);
  });

  it('not current: no pin, no aria-current, no --current', () => {
    const html = plate();
    expect(html).not.toMatch(/aria-current|ui-plate__pin|ui-plate--current/);
    expect(html).toMatch(/^<div class="ui-plate ui-plate--link">/);
  });

  it('current without an address puts aria-current on the title', () => {
    const html = plate({ current: true, href: undefined });
    expect(html).not.toContain('<a ');
    expect(html).toMatch(/<div class="ui-plate__title"><span aria-current="step">Consent covers secondary use<\/span><\/div>/);
    expect(html).toMatch(/^<div class="ui-plate ui-plate--current">/);
  });

  it('headingLevel makes the title a heading of that level; without it the title is not a heading', () => {
    expect(plate({ headingLevel: 3 })).toMatch(/<h3 class="ui-plate__title"><a class="ui-plate__link"/);
    expect(plate({ headingLevel: 2 })).toMatch(/<h2 class="ui-plate__title">/);
    expect(plate({ headingLevel: 4 })).toMatch(/<h4 class="ui-plate__title">/);
    expect(plate()).not.toMatch(/<h\d/);
    expect(plate()).toMatch(/<div class="ui-plate__title"><a /);
  });

  it('the mark is StatusMark as it is, alone in __mark; the plate\'s own elements carry no mark class', () => {
    const html = plate({ current: true });
    expect(html).toMatch(/<div class="ui-plate__mark"><span class="ui-mark ui-mark--partly" data-mark-kind="partly">[\s\S]*?<\/span><\/span><\/div>/);
    expect(html.match(/data-mark-kind=/g)).toHaveLength(1);
    expect(html.replace(/<div class="ui-plate__mark">[\s\S]*?<\/span><\/span><\/div>/, '')).not.toMatch(/ui-mark|data-mark-kind/);
    expect(textOf(html)).toBe('Consent covers secondary usePO-03.2PartlyDecided 11 Feb 2026You are here');
  });

  it('optional parts are absent when not given', () => {
    const html = renderToStaticMarkup(<ItemPlate title="Retention is set" />);
    expect(html).toBe('<div class="ui-plate"><div class="ui-plate__title">Retention is set</div></div>');
  });

  it('a state given as null or false renders no __state, as when left out', () => {
    for (const none of [undefined, null, false]) expect(plate({ state: none })).not.toContain('ui-plate__state');
  });

  it('the state and a title that is not a heading are <div>s, so a caller\'s block content is valid markup', () => {
    const html = renderToStaticMarkup(<ItemPlate title={<p>Block title</p>} state={<p>Block state</p>} />);
    expect(html).toBe('<div class="ui-plate"><div class="ui-plate__title"><p>Block title</p></div><div class="ui-plate__state"><p>Block state</p></div></div>');
  });

  it('noEvidence and scopeAnswer reach the mark unchanged (spec 7.2)', () => {
    expect(textOf(plate({ mark: 'done', noEvidence: true }))).toContain('Done, no evidence attached');
    expect(textOf(plate({ mark: 'scope_answered', scopeAnswer: 'yes' }))).toContain('Answer: Yes');
    expect(textOf(plate({ mark: 'scope_answered', scopeAnswer: 'not_sure' }))).toContain('Answer: Not sure');
    expect(textOf(plate({ mark: 'done' }))).not.toContain('no evidence');
  });

  it('the link never prefetches (a plate sits in long lists)', () => {
    expect(readFileSync('components/ui/ItemPlate.tsx', 'utf8')).toMatch(/import \{ ListLink \} from '@\/components\/ui\/ListLink'/);
    expect(readFileSync('components/ui/ItemPlate.tsx', 'utf8')).not.toMatch(/from 'next\/link'/);
  });

  it('the current plate is shown by a thicker border, not a fill, and the pin uses the action text colour', () => {
    const css = readFileSync('components/ui/ItemPlate.css', 'utf8');
    expect(css).toMatch(/\.ui-plate--current\s*\{[^}]*border:\s*2px solid var\(--color-action-text\)/);
    expect(css).toMatch(/\.ui-plate__pin\s*\{[^}]*color:\s*var\(--color-action-text\)/);
  });
});
