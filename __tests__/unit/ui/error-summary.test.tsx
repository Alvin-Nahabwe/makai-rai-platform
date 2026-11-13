import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorSummary } from '@/components/ui/ErrorSummary';

/** Plan 1A Task 4: ErrorSummary, which the caller focuses after a failed submit (modern-web-guidance accessible-error-announcement). */

describe('ErrorSummary', () => {
  it('renders nothing when there are no errors', () => {
    expect(renderToStaticMarkup(<ErrorSummary title="There is a problem" errors={[]} />)).toBe('');
  });

  it('its title is the element a script focuses (tabIndex -1), then one link per error to #fieldId', () => {
    const html = renderToStaticMarkup(
      <ErrorSummary title="There is a problem" errors={[{ fieldId: 'decision-reason', message: 'Write a reason.' }, { fieldId: 'decision-day', message: 'Enter a real date.' }]} />,
    );
    // The protected e2e/decision-save.spec.ts:294 finds the focused element by its text: the title must hold it alone.
    expect(html).toMatch(/^<div class="ui-error-summary"><h2 class="ui-error-summary__title" tabindex="-1">There is a problem<\/h2>/);
    expect(html).toContain('<ul class="ui-error-summary__list"><li><a href="#decision-reason">Write a reason.</a></li><li><a href="#decision-day">Enter a real date.</a></li></ul>');
  });

  it('a ref passed as a prop is attached to the title', () => {
    const ref = createRef<HTMLHeadingElement>();
    const tree = ErrorSummary({ title: 'T', errors: [{ fieldId: 'a', message: 'm' }], ref }) as { props: { children: Array<{ props: { ref?: unknown } }> } };
    expect(tree.props.children[0].props.ref).toBe(ref);
  });

  it('a field id is used as given, as text, never as markup', () => {
    const html = renderToStaticMarkup(<ErrorSummary title="T" errors={[{ fieldId: '"><script>', message: '<b>x</b>' }]} />);
    expect(html).toContain('href="#&quot;&gt;&lt;script&gt;"');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<script>');
  });
});
