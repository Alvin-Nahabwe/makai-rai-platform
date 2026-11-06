import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { RES, handBuiltContent } from '../helpers/suggestionsFixture';
import { ControlCard } from '@/components/suggestions/ControlCard';
import { parseResources } from '@/lib/content/resources';

// public/notebooks/requirements.txt is C-NB's file and does not exist yet: only that one stat is answered here.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: ((p: string, ...rest: unknown[]) =>
      String(p).endsWith('/public/notebooks/requirements.txt') ? { size: 2048 } : (real.statSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.statSync,
  };
});

const c = handBuiltContent('__tests__/fixtures/content/0.0.1-fixture');
const card = (id: string, extra = {}) =>
  renderToStaticMarkup(<ControlCard control={c.controls.get(id)!} resources={RES} headingLevel={3} {...extra} />);

describe('ControlCard', () => {
  it('FR-SUG-04: C-13 links its released notebook; C-21 has no notebook text and no "coming soon"', () => {
    expect(card('C-13')).toContain('href="/notebooks/C-13_subgroup-fairness.ipynb"');
    expect(card('C-13')).toContain('Download notebook (.ipynb, 48 KB)');
    expect(card('C-13')).toContain('Notebook: how to apply this with a free tool to your own data');
    expect(card('C-13')).toContain('Runs on your own computer or notebook service. The platform never runs it.');
    expect(card('C-13')).toContain('Reviewed by Reviewer A on 31 Oct 2026.');
    expect(card('C-13')).toMatch(/Download requirements\.txt \(\.txt, \d+ KB\)/);
    expect(card('C-21')).not.toMatch(/otebook/);
    expect(card('C-21')).not.toMatch(/coming soon/i);
  });

  it('FR-SUG-06 UX-13: only a passed template is linked, with kind and size', () => {
    expect(card('C-01')).toContain('Template: Alternatives Analysis (web page, 10 KB)');
    expect(card('C-02')).not.toMatch(/Template|templates\//);
  });

  it('FR-SUG-05: a notebook entry that is not released is not linked even with a passed review', () => {
    const res = { ...RES, notebooks: [{ ...RES.notebooks[0], controlId: 'C-21', released: false }] };
    const html = renderToStaticMarkup(<ControlCard control={c.controls.get('C-21')!} resources={res} headingLevel={3} />);
    expect(html).not.toMatch(/otebook|\.ipynb/);
  });

  it('UX-13 NFR-PRIV-04: external resource links say so and send no referrer', () => {
    const html = card('C-01');
    const links = html.match(/<a [^>]*href="https:[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) { expect(a).toContain('rel="noopener noreferrer"'); expect(a).toContain('opens another site'); }
    expect(html).toMatch(/Free resources \(\d+\):/);
  });

  it('UX-13 NFR-SEC-11: a non-https resource is not a link and hostile titles are escaped', () => {
    const ctl = { ...c.controls.get('C-01')!, resources: [
      { title: HOSTILE_STRINGS[0], url: 'javascript:alert(1)', type: 'tool' },
      { title: HOSTILE_STRINGS[1], url: 'https://example.org/x', type: 'tool' },
      { title: 'Not a URL', url: 'not a url', type: 'tool' }] };
    const html = renderToStaticMarkup(<ControlCard control={ctl} resources={RES} headingLevel={3} />);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html.match(/<a [^>]*href="[^"]*not a url/)).toBeNull();
  });

  it('UX-13 FR-SUG-04: a resource of type guidance shows the word Guidance (C-RES\'s EQUATOR links)', () => {
    const ctl = { ...c.controls.get('C-01')!, resources: [
      { title: 'EQUATOR Network reporting guidelines', url: 'https://www.equator-network.org/', type: 'guidance' },
      { title: 'A framework', url: 'https://example.org/f', type: 'framework' },
      { title: 'A tool', url: 'https://example.org/t', type: 'tool' },
      { title: 'A paper', url: 'https://example.org/p', type: 'paper' }] };
    const html = renderToStaticMarkup(<ControlCard control={ctl} resources={RES} headingLevel={3} />);
    const link = html.match(/<a [^>]*href="https:\/\/www\.equator-network\.org\/"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(link).toContain('EQUATOR Network reporting guidelines');
    expect(link).toContain('Guidance');
    expect(link).toContain('opens another site');
    for (const w of ['Framework', 'Tool', 'Paper']) expect(html).toContain(w);
  });

  it('UX-13: Also addresses and Usually applied in', () => {
    const html = card('C-17', { alsoAddresses: [c.areas.get('PO-07')!], usuallyAppliedIn: 'post-processing' });
    expect(html).toContain('Also addresses: PO-07');
    expect(html).toContain('Usually applied in Post-processing');
  });

  it('UX-13: the heading level and the data-control anchor follow the props', () => {
    const html = renderToStaticMarkup(<ControlCard control={c.controls.get('C-01')!} resources={RES} headingLevel={4} />);
    expect(html).toContain('<h4 class="ctl-card__title">Alternatives Analysis</h4>');
    expect(html).toContain('data-control="C-01"');
  });

  it('FR-SUG-04 FR-CNT-05: CNT\'s parseResources accepts the card test resources unchanged', () => {
    expect(parseResources(RES)).toEqual(RES);
  });
});
