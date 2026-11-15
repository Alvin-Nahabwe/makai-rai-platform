import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Breadcrumb } from '@/components/ui/Breadcrumb';
import type { BreadcrumbItem } from '@/components/ui/types';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5: Breadcrumb. A <nav> named UI_COPY.breadcrumbLabel holding an ordered list; the last item is the
 * current page and the only one with aria-current="page"; the separator is drawn by CSS and has no text.
 */

const ITEMS: readonly BreadcrumbItem[] = [
  { label: 'Projects', href: '/orgs/acme/projects' },
  { label: 'Maternal health triage', href: '/orgs/acme/projects/p1' },
  { label: 'Pre-processing' },
];

describe('Breadcrumb', () => {
  const html = renderToStaticMarkup(<Breadcrumb items={ITEMS} />);

  it('is a nav named "Breadcrumb" holding an ordered list', () => {
    expect(html).toMatch(/^<nav class="ui-breadcrumb" aria-label="Breadcrumb"><ol class="ui-breadcrumb__list" role="list">/);
    expect(html.match(/<li class="ui-breadcrumb__item">/g)).toHaveLength(3);
  });

  it('aria-current="page" on the last item, and only there', () => {
    expect(html.match(/aria-current=/g)).toHaveLength(1);
    expect(html).toMatch(/<li class="ui-breadcrumb__item"><span class="ui-breadcrumb__current" aria-current="page">Pre-processing<\/span><\/li><\/ol><\/nav>$/);
  });

  it('the earlier items are links with their hrefs as given, and nothing else is spoken', () => {
    expect([...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]])).toEqual([
      ['/orgs/acme/projects', 'Projects'], ['/orgs/acme/projects/p1', 'Maternal health triage'],
    ]);
    expect(textOf(html)).toBe('ProjectsMaternal health triagePre-processing');
  });

  it('a last item with an address is a link to the current page, still the only aria-current', () => {
    const out = renderToStaticMarkup(<Breadcrumb items={[{ label: 'Projects', href: '/p' }, { label: 'Here', href: '/p/here' }]} />);
    expect(out.match(/aria-current=/g)).toHaveLength(1);
    expect(out).toMatch(/<a class="ui-breadcrumb__current" aria-current="page" href="\/p\/here">Here<\/a>/);
  });

  it('the separator is CSS with no text: an empty generated box drawn with borders, not a character', () => {
    const css = readFileSync('components/ui/Breadcrumb.css', 'utf8');
    expect(css).toMatch(/\.ui-breadcrumb__item \+ \.ui-breadcrumb__item::before\s*\{[^}]*content:\s*''/);
    expect(css).not.toMatch(/content:\s*'[^']+'/);
    expect(css).not.toMatch(/content:\s*"[^"]+"/);
  });
});
