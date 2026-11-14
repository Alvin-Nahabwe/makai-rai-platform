import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { RES, handBuiltContent } from '../helpers/suggestionsFixture';
import { ControlCard } from '@/components/suggestions/ControlCard';
import { parseResources } from '@/lib/content/resources';
import { SUGGESTIONS_COPY } from '@/lib/suggestions/copy';

const c = handBuiltContent('__tests__/fixtures/content/0.0.1-fixture');
const card = (id: string, extra = {}) =>
  renderToStaticMarkup(<ControlCard control={c.controls.get(id)!} resources={RES} headingLevel={3} {...extra} />);

describe('ControlCard', () => {
  it('FR-SUG-04: C-13 links its released notebook; C-21 has no notebook text and no "coming soon"', () => {
    expect(card('C-13')).toContain('href="/notebooks/C-13_subgroup-fairness.ipynb"');
    expect(card('C-13')).toContain('Download notebook (.ipynb, 48 KB)');
    expect(card('C-13')).toContain('Notebook: how to apply this with a free tool to your own data');
    expect(card('C-13')).toContain(SUGGESTIONS_COPY.card.runsOn);
    expect(card('C-13')).toContain('Reviewed by Reviewer A on 31 Oct 2026.');
    expect(card('C-13')).toMatch(/Download the list of software it needs \(requirements\.txt\) \(\.txt, \d+ KB\)/);
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
    expect(html).toContain(`>${SUGGESTIONS_COPY.card.freeResources}</p>`);
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
    expect(html).toContain(SUGGESTIONS_COPY.card.alsoHelps([c.areas.get('PO-07')!.name]).replace(/&/g, '&amp;').replace(/'/g, '&#x27;'));
    expect(html).not.toContain('PO-07');
    expect(html).toContain('Usually applied in Post-processing');
  });

  it('UX-13: the heading level and the data-control anchor follow the props', () => {
    const html = renderToStaticMarkup(<ControlCard control={c.controls.get('C-01')!} resources={RES} headingLevel={4} />);
    expect(html).toContain('<h4 class="ctl-card__title">Alternatives Analysis</h4>');
    expect(html).toContain('data-control="C-01"');
  });

  it('UX-13 (copy audit B#287, B#294, C3 rule 6): the type says what it is, and the notebook lines are the ruled ones', () => {
    expect(card('C-01')).toContain('<p class="ctl-card__type">Type: ');
    expect(card('C-13')).toContain('Download the list of software it needs (requirements.txt)');
    expect(card('C-13')).toContain('<p class="ctl-card__note">Run it on your own computer or in a notebook service.</p>');
    expect(card('C-13')).not.toMatch(/never runs it/);
  });

  it('FR-SUG-04 FR-CNT-05: CNT\'s parseResources accepts the card test resources unchanged', () => {
    expect(parseResources(RES)).toEqual(RES);
  });

  it('FR-SUG-01 UX-33 (D-11, moved from the ControlResourcesList case): a template and the free resources show together, with no control to open first', () => {
    const html = card('C-01');
    expect(html).toContain('Template: Alternatives Analysis');
    expect(html).toContain(`>${SUGGESTIONS_COPY.card.freeResources}</p>`);
    expect(html).not.toMatch(/Free resources \(/);
    expect(html).not.toMatch(/<button|aria-label=|aria-expanded/);
  });

  it('FR-SUG-04: a control type the card has no word for is an error, as on S-27, not a raw string on the page', () => {
    const odd = { ...c.controls.get('C-01')!, type: 'strategic' };
    expect(() => renderToStaticMarkup(<ControlCard control={odd} resources={RES} headingLevel={3} />)).toThrow(/C-01.*strategic/);
  });

  it('UX-13: a resource type the card has no word for is an error, not a bare "Resource"', () => {
    const odd = { ...c.controls.get('C-01')!, resources: [{ title: 'A post', url: 'https://example.org/p', type: 'blog' }] };
    expect(() => renderToStaticMarkup(<ControlCard control={odd} resources={RES} headingLevel={3} />)).toThrow(/A post.*blog/);
  });
});
