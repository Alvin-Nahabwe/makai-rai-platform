import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Definition, Term } from '@/components/ui/Definition';
import { TERM_FINDING, TERM_PROJECT, TERM_TEAM, TERM_DASHBOARD } from '@/lib/vocabulary/terms';
import type { DefinedEntry, VocabularyEntry } from '@/lib/vocabulary/types';

/** Plan 1A, Task 7: Definition and Term (plan "Definition" and "Term" rows). */

afterEach(() => { vi.unstubAllEnvs(); });

/** An entry built at run time, which the compiler cannot vouch for. */
const runtime = (entry: VocabularyEntry) => entry as unknown as DefinedEntry;

describe('Definition', () => {
  it('outputs data-definition and the definition text, as a span by default, with no id attribute', () => {
    const html = renderToStaticMarkup(<Definition of={TERM_FINDING} />);
    expect(html).toBe(`<span class="ui-definition" data-definition="finding">${TERM_FINDING.definition}</span>`);
    expect(html).not.toContain(' id=');
  });

  it('renders a paragraph with as="p"', () => {
    const html = renderToStaticMarkup(<Definition of={TERM_FINDING} as="p" />);
    expect(html).toMatch(/^<p class="ui-definition" data-definition="finding">A gap your team has noted/);
  });

  it('sets the id on the element when given, so a control can name it with aria-describedby', () => {
    const html = renderToStaticMarkup(<Definition of={TERM_FINDING} id="finding-hint" />);
    expect(html).toContain('id="finding-hint"');
    expect(renderToStaticMarkup(<Definition of={TERM_FINDING} as="p" id="x" />)).toMatch(/^<p [^>]*id="x"/);
  });

  it('escapes the definition text', () => {
    const e = runtime({ ...TERM_FINDING, definition: '<b>x</b> & y' });
    expect(renderToStaticMarkup(<Definition of={e} />)).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y');
  });

  it('is rejected by the compiler for an entry with no definition (tsc proves this line)', () => {
    expect(() => renderToStaticMarkup(
      // @ts-expect-error TERM_TEAM has no definition and is not defined on first use
      <Definition of={TERM_TEAM} />,
    )).toThrow(/team/);
  });

  it('throws outside production for a plain word (defineOnFirstUse false), naming the id', () => {
    expect(TERM_PROJECT.defineOnFirstUse).toBe(false);
    expect(() => renderToStaticMarkup(<Definition of={runtime(TERM_PROJECT)} />)).toThrow(/project/);
  });

  it('throws outside production when the definition is null, naming the id', () => {
    expect(TERM_TEAM.definition).toBeNull();
    expect(() => renderToStaticMarkup(<Definition of={runtime(TERM_TEAM)} />)).toThrow(/team/);
    expect(() => renderToStaticMarkup(<Definition of={runtime({ ...TERM_FINDING, definition: null })} />)).toThrow(/finding/);
  });

  it('renders nothing in production, for each condition alone', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(renderToStaticMarkup(<Definition of={runtime(TERM_PROJECT)} />)).toBe('');
    expect(renderToStaticMarkup(<Definition of={runtime(TERM_TEAM)} />)).toBe('');
    // defineOnFirstUse true with a null definition: only the first condition holds
    expect(renderToStaticMarkup(<Definition of={runtime({ ...TERM_FINDING, definition: null })} />)).toBe('');
    // a definition with defineOnFirstUse false: only the second condition holds
    expect(renderToStaticMarkup(<Definition of={runtime({ ...TERM_FINDING, defineOnFirstUse: false })} />)).toBe('');
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
