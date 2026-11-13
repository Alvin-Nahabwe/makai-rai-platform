import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Definition, Term } from '@/components/ui/Definition';
import { TERM_FINDING, TERM_PROJECT, TERM_TEAM, TERM_DASHBOARD } from '@/lib/vocabulary/terms';
import type { VocabularyEntry } from '@/lib/vocabulary/types';

/** Plan 1A, Task 7: Definition and Term (plan "Definition" and "Term" rows). */

afterEach(() => { vi.unstubAllEnvs(); });

describe('Definition', () => {
  it('outputs data-definition and the definition text, as a span by default', () => {
    const html = renderToStaticMarkup(<Definition of={TERM_FINDING} />);
    expect(html).toBe(`<span class="ui-definition" data-definition="finding">${TERM_FINDING.definition}</span>`);
  });

  it('renders a paragraph with as="p"', () => {
    const html = renderToStaticMarkup(<Definition of={TERM_FINDING} as="p" />);
    expect(html).toMatch(/^<p class="ui-definition" data-definition="finding">A gap your team has noted/);
  });

  it('escapes the definition text', () => {
    const e: VocabularyEntry = { ...TERM_FINDING, definition: '<b>x</b> & y' };
    expect(renderToStaticMarkup(<Definition of={e} />)).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });

  it('throws outside production for a plain word (defineOnFirstUse false), naming the id', () => {
    expect(TERM_PROJECT.defineOnFirstUse).toBe(false);
    expect(() => renderToStaticMarkup(<Definition of={TERM_PROJECT} />)).toThrow(/project/);
  });

  it('throws outside production when the definition is null, naming the id', () => {
    expect(TERM_TEAM.definition).toBeNull();
    expect(() => renderToStaticMarkup(<Definition of={TERM_TEAM} />)).toThrow(/team/);
    const nullDef: VocabularyEntry = { ...TERM_FINDING, definition: null };
    expect(() => renderToStaticMarkup(<Definition of={nullDef} />)).toThrow(/finding/);
  });

  it('renders nothing in production in either case', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(renderToStaticMarkup(<Definition of={TERM_PROJECT} />)).toBe('');
    expect(renderToStaticMarkup(<Definition of={TERM_TEAM} />)).toBe('');
    expect(renderToStaticMarkup(<Definition of={TERM_FINDING} />)).toContain('data-definition="finding"');
  });
});

describe('Term', () => {
  it('outputs data-term and the term text', () => {
    expect(renderToStaticMarkup(<Term of={TERM_FINDING} />)).toBe('<span data-term="finding">finding</span>');
  });

  it('shows children in place of the term when given', () => {
    expect(renderToStaticMarkup(<Term of={TERM_FINDING}>findings</Term>)).toBe('<span data-term="finding">findings</span>');
  });

  it('uses the ruled term, not the concept name (dashboard reads Home)', () => {
    expect(renderToStaticMarkup(<Term of={TERM_DASHBOARD} />)).toBe('<span data-term="dashboard">Home</span>');
  });
});
