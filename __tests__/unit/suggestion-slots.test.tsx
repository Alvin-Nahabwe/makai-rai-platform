import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FindingSuggestions, findingSuggestionCount } from '@/components/suggestions/FindingSuggestions';
import { SuggestedControls, controlCountLine, suggestionCount } from '@/components/suggestions/SuggestedControls';

vi.mock('@/lib/content/resources', async () => {
  const { RES } = await import('../helpers/suggestionsFixture');
  return { loadResources: () => RES };
});
// The requirements file is C-NB's and does not exist yet (see the helper): only its stat is answered.
vi.mock('node:fs', async (importOriginal) => (await import('../helpers/requirementsStat')).withRequirementsStat(await importOriginal<typeof import('node:fs')>()));

const V = '0.0.1-fixture';
const s12 = async (questionId: string, tickedOptions: string[] = []) =>
  renderToStaticMarkup(await SuggestedControls({ contentSemver: V, questionId, tickedOptions }) ?? <></>);

describe('suggestion slots', () => {
  it('FR-SUG-01 UX-08: S-12 shows the controls of Q-PP-01 with no answer, names before any collapsed group', async () => {
    const html = await s12('Q-PP-01');
    for (const n of ['Alternatives Analysis', 'Cost-Benefit', 'Multi-stakeholder']) expect(html).toContain(n);
    expect(html.match(/data-control=/g)).toHaveLength(3);
    expect(html).not.toContain('Ways teams address this');   // the S-12 shell's h2 carries the words
    expect(html).toContain('<p class="suggested-controls__count">3 controls for this question&#x27;s risk area</p>');   // SRS line 1837
    expect(html).not.toContain('<details');
    expect(html).toContain('Shown before you answer. Use any, none, or your own approach.');
    expect(html).toMatch(/<h3[^>]*>Risk area PP-01 /);
  });

  it('FR-SUG-02 UX-13: a checklist puts the rest under a closed Other controls group', async () => {
    const html = await s12('Q-PP-17', ['Labeling bias']);
    const details = html.slice(html.indexOf('<details'));
    expect(html).toContain('<summary>Other controls for this question (1)</summary>');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(details).toContain('Labeling Quality Assurance');
    expect(html.slice(0, html.indexOf('<details'))).toContain('Data Quality &amp; Representativeness Audit');
    expect(html.slice(0, html.indexOf('<details'))).not.toContain('Labeling Quality Assurance');
  });

  it('FR-SUG-02: the gate shows none', async () => {
    expect(await SuggestedControls({ contentSemver: V, questionId: 'Q-PP-GATE-SENSITIVE', tickedOptions: [] })).toBeNull();
  });

  it('FR-SUG-04: S-12 links the C-13 notebook and shows no notebook text on the C-21 card', async () => {
    const html = await s12('Q-IP-24');
    expect(html).toContain('/notebooks/C-13_subgroup-fairness.ipynb');
    expect(html).toContain('data-control="C-21"');
    expect(html).not.toContain('C-21_monitoring-drift');
    expect(html).not.toMatch(/coming soon/i);
  });

  it('UX-13: a control on two areas of Q-IP-12 is one card, with Also addresses and the later stage named', async () => {
    const html = await s12('Q-IP-12');
    expect(html.match(/data-control="C-17"/g)).toHaveLength(1);
    expect(html).toContain('Also addresses: PO-07');
    expect(html).toContain('Usually applied in Post-processing');
  });

  it('FR-SUG-03: S-15 collapses the controls of the finding area IP-05 to their names, with the cards under a closed Show details; none without an area', () => {
    const html = renderToStaticMarkup(FindingSuggestions({ contentSemver: V, riskArea: 'IP-05' }) ?? <></>);
    expect(html).not.toContain('Ways teams address this');   // FND-b's section h2 carries the words: no second heading
    expect(html).not.toMatch(/controls? for this question/);   // W-5 has no count line: the section heading names the risk area
    const names = html.slice(0, html.indexOf('<details'));
    expect(names).toMatch(/<p class="suggested-controls__names">/);
    for (const n of ['C-13 ', 'C-15 ', 'C-18 ']) expect(names).toContain(n);
    expect(names).not.toContain('<article');
    expect(names).not.toMatch(/<h[1-6]/);   // no heading before the details: the cards' h3 sit directly under FND-b's h2
    expect(names.match(/<span aria-hidden="true"> \u00b7 <\/span>/g)).toHaveLength(2);   // the separator is drawn, not read
    expect(html).toContain('<summary>Show details</summary>');
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    const inside = html.slice(html.indexOf('<details'));
    expect(inside.match(/<article/g)).toHaveLength(3);
    expect(inside.match(/<h3/g)).toHaveLength(3);
    expect(inside).not.toMatch(/<h4/);   // h2 > h3, no skipped level
    expect(FindingSuggestions({ contentSemver: V, riskArea: null })).toBeNull();
    expect(FindingSuggestions({ contentSemver: V, riskArea: 'XX-99' })).toBeNull();
  });

  it('FR-SUG-03 UX-08: findingSuggestionCount is the number of cards, and 0 for no area or an unknown one (the page then shows no section)', () => {
    expect(findingSuggestionCount({ contentSemver: V, riskArea: 'IP-05' })).toBe(3);
    expect(findingSuggestionCount({ contentSemver: V, riskArea: null })).toBe(0);
    expect(findingSuggestionCount({ contentSemver: V, riskArea: 'XX-99' })).toBe(0);
  });

  it('UX-08: the count line says "1 control" for one and "n controls" otherwise', () => {
    expect(controlCountLine(1)).toBe("1 control for this question's risk area");
    expect(controlCountLine(3)).toBe("3 controls for this question's risk area");
  });

  it('UX-08 FR-SUG-01: the count is the number of distinct cards shown, a control reached through two areas once', () => {
    const p = (questionId: string, tickedOptions: string[] = []) => ({ contentSemver: V, questionId, tickedOptions });
    expect(suggestionCount(p('Q-PP-01'))).toBe(3);
    expect(suggestionCount(p('Q-PP-GATE-SENSITIVE'))).toBe(0);
    // Q-IP-12: C-17 is listed by IP-06 and by PO-07; C-17, C-18, C-19, C-26, C-28 are five cards, not six.
    expect(suggestionCount(p('Q-IP-12'))).toBe(5);
    expect(suggestionCount(p('Q-PP-17', ['Labeling bias']))).toBe(7);   // 6 first + 1 in the closed group
  });

  it('UX-08 FR-SUG-01: the count equals the cards the slot renders, for every question of the fixture', async () => {
    const { loadContent } = await import('@/lib/content/loader');
    for (const id of loadContent(V).questions.keys()) {
      const cards = (await s12(id)).match(/data-control=/g)?.length ?? 0;
      expect(suggestionCount({ contentSemver: V, questionId: id, tickedOptions: [] }), id).toBe(cards);
    }
  });

  it('NFR-A11Y-02 UX-13: the closed group is a details element named by its visible words, with no aria-label', async () => {
    const html = await s12('Q-PP-17', ['Labeling bias']);
    expect(html).toMatch(/<summary>Other controls for this question \(1\)<\/summary>/);
    expect(html).not.toMatch(/<(summary|details)[^>]*aria-label/);
  });
});
