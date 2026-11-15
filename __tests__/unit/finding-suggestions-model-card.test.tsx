import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FindingSuggestions } from '@/components/suggestions/FindingSuggestions';
import { TERM_MODEL_CARD } from '@/lib/vocabulary/terms';
import type { ContentControl } from '@/types/content';

/**
 * Lane 6, FX3 (S-15, ruling X-5): the finding page defines "model card" once, on the first listed control whose description
 * uses it, because the cards repeat on a page and ControlCard defines nothing unless asked. IP-05's fixture controls are
 * C-13, C-15 and C-18, in that order.
 */
vi.mock('@/lib/content/resources', async () => {
  const { RES } = await import('../helpers/suggestionsFixture');
  return { loadResources: () => RES };
});
vi.mock('@/lib/content/loader', async () => {
  const { handBuiltContent } = await import('../helpers/suggestionsFixture');
  const base = handBuiltContent('__tests__/fixtures/content/0.0.1-fixture');
  const controls = base.controls as Map<string, ContentControl>;
  const withCard = (id: string) => controls.set(id, { ...controls.get(id)!, description: 'Write a model card for the model and keep it with the release.' });
  return {
    loadContent: (semver: string) => {
      if (semver === 'two') { withCard('C-15'); withCard('C-18'); }
      if (semver === 'name') withCard('C-15');
      if (semver === 'name') controls.set('C-13', { ...controls.get('C-13')!, name: 'Model card review' });
      return base;
    },
  };
});

const TERM = `data-term="${TERM_MODEL_CARD.id}"`;
const DEF = `data-definition="${TERM_MODEL_CARD.id}"`;
const html = (contentSemver: string) => renderToStaticMarkup(FindingSuggestions({ contentSemver, riskArea: 'IP-05' }) ?? <></>);
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('S-15: "model card" is defined once, on the first card that uses it', () => {
  it('no control uses the term: nothing is marked or defined', () => {
    expect(html('none')).not.toMatch(/data-term|data-definition/);
  });

  it('two cards use it: only the first of them (C-15) holds the term mark and its definition, as the next element', () => {
    const out = html('two');
    expect(count(out, TERM)).toBe(1);
    expect(count(out, DEF)).toBe(1);
    const c15 = out.slice(out.indexOf('data-control="C-15"'), out.indexOf('data-control="C-18"'));
    expect(c15).toContain(TERM);
    expect(c15).toMatch(new RegExp(`<p class="term-line"><span ${TERM}>Model card</span>\\. <span class="ui-definition" ${DEF}>`));
    expect(out.slice(out.indexOf('data-control="C-18"'))).not.toMatch(/data-term|data-definition/);
  });

  it('a control name uses the term: a name is a framework name, not a use (X-1 (3)), so the names line marks nothing and the first card whose description uses it (C-15) defines it', () => {
    const out = html('name');
    expect(count(out, TERM)).toBe(1);
    expect(count(out, DEF)).toBe(1);
    expect(out.slice(0, out.indexOf('<details'))).not.toMatch(/data-term|data-definition/);
    const c15 = out.slice(out.indexOf('data-control="C-15"'), out.indexOf('data-control="C-18"'));
    expect(c15).toContain(TERM);
    expect(c15).toContain(DEF);
  });
});
