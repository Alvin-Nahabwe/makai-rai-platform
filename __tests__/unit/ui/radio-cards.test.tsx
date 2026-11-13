import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RadioCards, type RadioCardsProps } from '@/components/ui/RadioCards';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 4: RadioCards. The radio's accessible name must be exactly its label: protected browser tests find it
 * with getByRole('radio', { name: 'Done', exact: true }) (e2e/helpers/session.ts:147, e2e/decision-save.spec.ts:323).
 */

const OPTIONS: RadioCardsProps['options'] = [
  { value: 'done', label: 'Done', help: 'The expected practice is in place.', mark: 'done' },
  { value: 'partly', label: 'Partly', help: 'Some of the expected practice is in place.', mark: 'partly' },
  { value: 'not_yet', label: 'Not yet', id: 'decision-status-not_yet' },
];

const render = (props: Partial<RadioCardsProps> = {}) =>
  renderToStaticMarkup(<RadioCards name="status" legend="Status" options={OPTIONS} defaultValue="partly" {...props} />);

describe('RadioCards', () => {
  it('is a fieldset whose legend holds the legend text alone, then radios with type before value', () => {
    const html = render({ legendHint: 'Choose one.' });
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Status<\/legend>/);
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*value="done"/);
    expect(html.indexOf('Choose one.')).toBeGreaterThan(html.indexOf('</legend>'));
  });

  it('one card per option, each with one <label> that holds the named radio and exactly the option\'s label', () => {
    const html = render();
    const cards = html.split('<div class="ui-radio-card">').slice(1);
    expect(cards).toHaveLength(3);
    const labels = [...html.matchAll(/<label class="ui-radio-card__label"[^>]*>([\s\S]*?)<\/label>/g)];
    expect(labels).toHaveLength(3);
    expect(labels.map((m) => textOf(m[1]))).toEqual(['Done', 'Partly', 'Not yet']);
    for (const [, inner] of labels) expect(inner).toMatch(/<input [^>]*type="radio"[^>]*name="status"/);
    for (const card of cards) expect(card.match(/<label/g)).toHaveLength(1);
  });

  it('options[].id becomes the input\'s id, by default name-value; help sits outside the label and describes the input', () => {
    const html = render();
    expect(html).toMatch(/<input [^>]*id="status-done"[^>]*aria-describedby="status-done-help"/);
    expect(html).toMatch(/<p class="ui-radio-card__help" id="status-done-help">The expected practice is in place.<\/p>/);
    expect(html).toMatch(/<input [^>]*id="decision-status-not_yet"/);
    expect(html.match(/<input [^>]*id="decision-status-not_yet"[^>]*>/)?.[0]).not.toContain('aria-describedby');
  });

  it('disabled and aria-describedby sit on the fieldset; the error follows the caller\'s ids', () => {
    const html = render({ disabled: true, 'aria-describedby': 'decision-finding-note', error: 'Choose a status.' });
    const fieldset = html.match(/<fieldset[^>]*>/)?.[0] ?? '';
    expect(fieldset).toContain('disabled=""');
    expect(fieldset).toContain('aria-describedby="decision-finding-note status-error"');
    expect(html).toMatch(/<p class="ui-field__error"><svg [^>]*aria-hidden="true"/);
    expect(html).toMatch(/id="status-error"[^>]*>Choose a status\.</);
    expect(html.match(/<input [^>]*>/g)?.every((i) => !i.includes('disabled'))).toBe(true);
  });

  it('checks the chosen value, controlled or not, and draws the mark when one is given', () => {
    expect(render().match(/<input [^>]*checked=""[^>]*>/g)).toHaveLength(1);
    expect(render().match(/<input [^>]*checked=""[^>]*>/)?.[0]).toContain('value="partly"');
    const controlled = renderToStaticMarkup(<RadioCards name="s" legend="Status" options={OPTIONS} value="done" onChange={() => {}} />);
    expect(controlled.match(/<input [^>]*checked=""[^>]*>/)?.[0]).toContain('value="done"');
    expect(render().match(/class="ui-mark__shape"/g)).toHaveLength(2);
  });

  it('two columns when asked; required reaches each radio', () => {
    expect(render({ columns: 2 })).toContain('class="ui-radio-cards ui-radio-cards--columns-2"');
    expect(render({ required: true }).match(/<input [^>]*required=""/g)).toHaveLength(3);
  });

  it('the stylesheet draws the selection as a 2 px --color-selected border on the card that has the checked radio', () => {
    const css = readFileSync('components/ui/RadioCards.css', 'utf8');
    expect(css).toMatch(/\.ui-radio-card:has\(:checked\)\s*\{[^}]*border:\s*2px solid var\(--color-selected\)/);
    expect(css).toMatch(/\.ui-radio-card__input\s*\{[^}]*appearance:\s*none/);
  });
});
