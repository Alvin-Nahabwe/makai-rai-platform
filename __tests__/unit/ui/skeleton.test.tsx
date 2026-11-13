import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Skeleton } from '@/components/ui/Skeleton';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 6, decision B12: a static placeholder that announces once, through a visually hidden status line. */

const CSS = readFileSync('components/ui/Skeleton.css', 'utf8');

describe('Skeleton', () => {
  it('nothing moves: no @keyframes, no animation and no transition in its CSS', () => {
    expect(CSS).not.toMatch(/@keyframes|animation|transition/);
  });

  it('the label is a visually hidden role="status" line; the drawn lines are hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<Skeleton label="Loading the findings" />);
    expect(html).toMatch(/^<div class="ui-skeleton"><p role="status" class="visually-hidden">Loading the findings<\/p><div aria-hidden="true">/);
    expect(textOf(html)).toBe('Loading the findings');
    expect(html.match(/class="ui-skeleton__line"/g)).toHaveLength(3);
  });

  it('takes a number of lines and a variant', () => {
    expect(renderToStaticMarkup(<Skeleton label="l" lines={5} />).match(/class="ui-skeleton__line"/g)).toHaveLength(5);
    expect(renderToStaticMarkup(<Skeleton label="l" variant="plate" />)).toMatch(/^<div class="ui-skeleton ui-skeleton--plate">/);
    expect(renderToStaticMarkup(<Skeleton label="l" variant="table" />)).toMatch(/^<div class="ui-skeleton ui-skeleton--table">/);
    expect(renderToStaticMarkup(<Skeleton label="l" variant="text" />)).toMatch(/^<div class="ui-skeleton">/);
  });
});
