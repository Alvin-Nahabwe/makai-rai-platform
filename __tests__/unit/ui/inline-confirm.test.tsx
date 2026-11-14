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
      // The actions hold buttons only, as siblings, so the last child is the last button. A busy button holds the kit's empty
      // spinner span before its label (Button.tsx), inside the button.
      const children = [...actions.matchAll(/<(\w+)[^>]*>(?:<span class="ui-button__spinner" aria-hidden="true"><\/span>)?[^<]*<\/\1>/g)];
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

  it('a busy confirm button is the kit\'s busy state (aria-busy, not disabled), so it keeps focus; canConfirm false disables it, busy or not; Cancel never is either', () => {
    const confirmOf = (html: string) => /<button [^>]*>(?:<span[^>]*><\/span>)?Withdraw document<\/button>/.exec(html)![0];
    const cancelOf = (html: string) => /<button [^>]*>Cancel<\/button>/.exec(html)![0];
    for (const [props, want] of [
      [{}, { busy: false, disabled: false }],
      [{ busy: true }, { busy: true, disabled: false }],
      [{ canConfirm: false }, { busy: false, disabled: true }],
      [{ busy: true, canConfirm: false }, { busy: true, disabled: true }],
      [{ busy: true, canConfirm: true }, { busy: true, disabled: false }],
    ] as const) {
      const html = renderToStaticMarkup(<InlineConfirm {...base} {...props} />);
      const confirm = confirmOf(html);
      expect({ busy: confirm.includes('aria-busy="true"'), disabled: confirm.includes('disabled=""') }, JSON.stringify(props)).toEqual(want);
      expect(cancelOf(html), JSON.stringify(props)).not.toMatch(/disabled|aria-busy/);
    }
  });
});
