import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Callout } from '@/components/ui/Callout';
import { Icon } from '@/components/ui/Icon';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 6: Callout, a note or a caution inside the content. Not a live region. */

const CSS = readFileSync('components/ui/Callout.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe('Callout', () => {
  it('a note has its modifier, its title and its words, and no icon', () => {
    const html = renderToStaticMarkup(<Callout kind="note" title="Before you start">Read the <em>guidance</em> first.</Callout>);
    expect(html).toBe('<div class="ui-callout ui-callout--note"><div class="ui-callout__body"><p class="ui-callout__title">Before you start</p>Read the <em>guidance</em> first.</div></div>');
  });

  it('a caution carries the triangle-alert icon, hidden, before its words', () => {
    const html = renderToStaticMarkup(<Callout kind="caution">This cannot be undone.</Callout>);
    expect(html).toBe(`<div class="ui-callout ui-callout--caution"><span class="ui-callout__icon">${renderToStaticMarkup(<Icon name="triangle-alert" />)}</span><div class="ui-callout__body">This cannot be undone.</div></div>`);
    expect(textOf(html)).toBe('This cannot be undone.');
  });

  it('is not a live region', () => {
    expect(renderToStaticMarkup(<Callout kind="caution" title="t">w</Callout>)).not.toMatch(/role=|aria-live/);
  });

  it('a tint background; the caution adds a 4 px heading-coloured border on the start side, which forced colours keep', () => {
    expect(rules.find((r) => r.selector === '.ui-callout')?.body).toMatch(/background-color:\s*var\(--color-tint\)/);
    expect(rules.find((r) => r.selector === '.ui-callout--caution')?.body).toMatch(/border-inline-start:\s*4px solid var\(--color-heading\)/);
    expect(CSS).not.toMatch(/--color-overdue|--color-action/);
  });
});
