import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { UI_COPY } from '@/lib/ui/copy';

/** Plan 1A Task 6: InlineConfirm on the kit (classes, destructive, cancelLabel); its behaviour cases stay in shared-components.test.tsx. */

const noop = () => {};
const base = { objectName: 'Data card v1', consequence: 'It stays listed as withdrawn.', actionLabel: 'Withdraw document', onConfirm: noop, onCancel: noop };

describe('InlineConfirm on the kit', () => {
  it('Cancel comes before the confirm button in the markup, inside __actions', () => {
    const html = renderToStaticMarkup(<InlineConfirm {...base} />);
    expect(html).toMatch(/<div class="ui-confirm__actions"><button [^>]*>Cancel<\/button><button [^>]*>Withdraw document<\/button><\/div>/);
    expect(html).toMatch(/^<div role="group" aria-labelledby="[^"]+" class="ui-confirm"><p id="[^"]+" class="ui-confirm__object"><strong>Data card v1<\/strong><\/p><p class="ui-confirm__consequence">/);
  });

  it('`.ui-confirm__actions button:last-child` selects the confirm button and nothing else (FindingActions.tsx focuses it, UX-42)', () => {
    for (const props of [{}, { destructive: true }, { busy: true }, { cancelLabel: 'Keep it' }]) {
      const html = renderToStaticMarkup(<InlineConfirm {...base} {...props} />);
      const actions = /<div class="ui-confirm__actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
      // The actions hold buttons only, as siblings, so the last child is the last button.
      const children = [...actions.matchAll(/<(\w+)[^>]*>[^<]*<\/\1>/g)];
      expect(children.map((c) => c[1]), JSON.stringify(props)).toEqual(['button', 'button']);
      expect(children.map((c) => c[0]).join(''), JSON.stringify(props)).toBe(actions);
      expect(children[1][0], JSON.stringify(props)).toMatch(/>Withdraw document<\/button>$/);
    }
  });

  it('the confirm button is primary by default and ui-button--destructive when destructive; Cancel is secondary', () => {
    expect(renderToStaticMarkup(<InlineConfirm {...base} />)).toMatch(/<button class="ui-button ui-button--primary"[^>]*>Withdraw document</);
    const html = renderToStaticMarkup(<InlineConfirm {...base} destructive />);
    expect(html).toMatch(/<button class="ui-button ui-button--destructive"[^>]*>Withdraw document</);
    expect(html).toMatch(/<button class="ui-button ui-button--secondary"[^>]*>Cancel</);
  });

  it('cancelLabel names the cancel button; the default comes from UI_COPY', () => {
    expect(UI_COPY.confirm.cancel).toBe('Cancel');
    expect(renderToStaticMarkup(<InlineConfirm {...base} cancelLabel="Keep the document" />)).toMatch(/<button [^>]*>Keep the document<\/button><button/);
  });

  it('a busy confirm button is disabled, not the kit\'s busy state, so it cannot be pressed twice', () => {
    const html = renderToStaticMarkup(<InlineConfirm {...base} busy />);
    expect(html).toMatch(/<button [^>]*disabled=""[^>]*>Withdraw document<\/button>/);
    expect(html).not.toContain('aria-busy');
  });
});
