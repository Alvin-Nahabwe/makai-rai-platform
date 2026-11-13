import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/ui/EmptyState';
import { ButtonLink } from '@/components/ui/Button';

/** Plan 1A Task 6: EmptyState says why a place is empty and how it fills (voice rule 2). */

describe('EmptyState', () => {
  it('renders the title, the words and the action as given', () => {
    const html = renderToStaticMarkup(
      <EmptyState title="No findings yet" action={<ButtonLink variant="primary" href="/projects/p1/findings/new">Add a finding</ButtonLink>}>
        Findings appear here when the <strong>team</strong> records one.
      </EmptyState>,
    );
    expect(html).toBe('<div class="ui-empty"><p class="ui-empty__title">No findings yet</p><div class="ui-empty__body">Findings appear here when the <strong>team</strong> records one.</div>'
      + '<div class="ui-empty__action"><a class="ui-button ui-button--primary" href="/projects/p1/findings/new">Add a finding</a></div></div>');
  });

  it('has no action element without an action, and no role', () => {
    const html = renderToStaticMarkup(<EmptyState title="Nothing here">Words.</EmptyState>);
    expect(html).not.toContain('ui-empty__action');
    expect(html).not.toMatch(/role=|aria-live/);
  });

  it('an action that renders nothing (null, false) leaves no empty wrapper', () => {
    for (const action of [null, false]) {
      expect(renderToStaticMarkup(<EmptyState title="t" action={action}>w</EmptyState>), String(action)).not.toContain('ui-empty__action');
    }
  });
});
