import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TabNav, type TabNavProps } from '@/components/ui/TabNav';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5, decision B9: tabs are navigation (modern-web-guidance `tabs`, `navbar`): a labelled <nav> of links in
 * the tab order, never an ARIA tab list. The current one says aria-current="page" and carries a 3 px underline; a count
 * is in the link's own text, "Open 13", with the number in __count.
 */

const ITEMS: TabNavProps['items'] = [
  { href: '/findings?status=open', label: 'Open', count: 13, current: true },
  { href: '/findings?status=closed', label: 'Closed', count: 4, current: false },
  { href: '/findings?status=accepted', label: 'Accepted risk', current: false },
];

describe('TabNav', () => {
  const html = renderToStaticMarkup(<TabNav label="Findings" items={ITEMS} />);

  it('is a labelled nav of links in a list, with no tab roles', () => {
    expect(html).toMatch(/^<nav class="ui-tabnav" aria-label="Findings"><ul class="ui-tabnav__list" role="list">/);
    expect(html.match(/<li><a /g)).toHaveLength(3);
    expect(html).not.toMatch(/role="tab|aria-selected|focusgroup|tabindex/);
  });

  it('aria-current="page" on the current item only, with the --current class', () => {
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<a class="ui-tabnav__item ui-tabnav__item--current" aria-current="page" href="\/findings\?status=open">/);
    expect(html.match(/ui-tabnav__item--current/g)).toHaveLength(1);
  });

  it('the count is in the link text, "Open 13", with the number in __count; no count, no __count', () => {
    const links = [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
    expect(links.map(textOf)).toEqual(['Open 13', 'Closed 4', 'Accepted risk']);
    expect(links[0]).toBe('Open <span class="ui-tabnav__count">13</span>');
    expect(links[2]).not.toContain('ui-tabnav__count');
  });

  it('the href is passed as given', () => {
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(ITEMS.map((i) => i.href));
  });

  it('the current underline is a 3 px border on a pseudo-element, and tabs keep one row', () => {
    const css = readFileSync('components/ui/TabNav.css', 'utf8');
    expect(css).toMatch(/\.ui-tabnav__item--current::after\s*\{[^}]*border-block-end:\s*3px solid/);
    expect(css).toMatch(/\.ui-tabnav__list\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).not.toMatch(/flex-wrap:\s*wrap/);
    expect(css).not.toMatch(/box-shadow/);
  });

  it('is a client component, for the effect that brings the current tab into view inside its row', () => {
    const source = readFileSync('components/ui/TabNav.tsx', 'utf8');
    expect(source).toMatch(/^'use client';/);
    expect(source).not.toMatch(/scrollIntoView|window\.scroll|scrollTo\(|behavior/);
  });

  it('the count is kept apart from the label by a gap the link draws (a flex container drops the space)', () => {
    expect(readFileSync('components/ui/TabNav.css', 'utf8')).toMatch(/\.ui-tabnav__item\s*\{[^}]*column-gap:\s*var\(--space-1\)/);
  });

  it('the edge fade is an enhancement: inside @supports, and off in forced colours', () => {
    const css = readFileSync('components/ui/TabNav.css', 'utf8');
    expect(css).toMatch(/@supports \(animation-timeline: scroll\(\)\)\s*\{[\s\S]*mask:/);
    expect(css).toMatch(/@media \(forced-colors: active\)\s*\{[^}]*\.ui-tabnav__list\s*\{[^}]*mask:\s*none/);
    expect(css.slice(0, css.indexOf('@supports (animation-timeline: scroll())'))).not.toMatch(/mask/);
  });
});
