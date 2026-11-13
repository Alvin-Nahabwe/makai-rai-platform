import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageHeader } from '@/components/ui/PageHeader';
import { ButtonLink } from '@/components/ui/Button';
import { textOf } from '@/__tests__/helpers/markup';

/**
 * Plan 1A Task 5: PageHeader, the page's one <h1>. The breadcrumb comes first, then the title in words, then its small
 * code (voice rule 8: words before codes), then the lead, then the actions. Each optional part is absent when not given.
 */

describe('PageHeader', () => {
  const full = renderToStaticMarkup(
    <PageHeader breadcrumb={[{ label: 'Projects', href: '/p' }, { label: 'Consent' }]} title="Consent covers secondary use" code="PO-03.2"
      lead={<p>Say what the consent form covers.</p>} actions={<ButtonLink variant="secondary" href="/p/history">History</ButtonLink>} />,
  );

  it('one h1 holding the title alone; the code is a separate small element after it', () => {
    expect(full.match(/<h1[ >]/g)).toHaveLength(1);
    expect(full).toMatch(/<h1 class="ui-page-header__title">Consent covers secondary use<\/h1><p class="ui-page-header__code">PO-03.2<\/p>/);
  });

  it('the order is breadcrumb, title, code, lead, actions', () => {
    const at = (needle: string) => full.indexOf(needle);
    const order = ['ui-breadcrumb', 'ui-page-header__title', 'ui-page-header__code', 'ui-page-header__lead', 'ui-page-header__actions'].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(full).toMatch(/^<header class="ui-page-header">/);
    expect(full).toMatch(/<div class="ui-page-header__lead"><p>Say what the consent form covers.<\/p><\/div>/);
  });

  it('with the title alone: no breadcrumb, no code, no lead, no actions', () => {
    const bare = renderToStaticMarkup(<PageHeader title="Projects" />);
    expect(bare).toBe('<header class="ui-page-header"><div class="ui-page-header__heading"><h1 class="ui-page-header__title">Projects</h1></div></header>');
  });

  it('each optional part appears alone when given alone', () => {
    expect(renderToStaticMarkup(<PageHeader title="T" code="C-1" />)).toContain('<p class="ui-page-header__code">C-1</p>');
    expect(renderToStaticMarkup(<PageHeader title="T" breadcrumb={[{ label: 'Here' }]} />)).toContain('aria-label="Breadcrumb"');
    expect(textOf(renderToStaticMarkup(<PageHeader title="T" actions={<button type="button">Act</button>} />))).toBe('TAct');
    expect(renderToStaticMarkup(<PageHeader title="T" breadcrumb={[]} />)).not.toContain('ui-breadcrumb');
  });

  it('a lead or actions given as null or false render no wrapper, as when left out', () => {
    for (const none of [undefined, null, false]) {
      const out = renderToStaticMarkup(<PageHeader title="T" lead={none} actions={none} />);
      expect(out).not.toMatch(/ui-page-header__lead|ui-page-header__actions/);
    }
  });

  it('renders a caller\'s title as text, never as markup', () => {
    expect(renderToStaticMarkup(<PageHeader title={'<img src=x onerror=alert(1)>'} />)).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});
