import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { Dialog, type DialogProps } from '@/components/ui/Dialog';

/**
 * Plan 1A Task 6: Dialog, the native <dialog> opened with showModal() (modern-web-guidance `dialog`): no role, no
 * aria-modal, no focus trap; Escape is the browser's, and onClose comes from the native cancel and close events.
 *
 * The behaviour cases call the component as a function with React's hooks replaced by a minimal harness (refs kept by
 * call order, effects run at once), and a stubbed HTMLDialogElement as the element the ref points to: this repository's
 * unit tests run in node, with no DOM.
 */

type Harness = { refs: Array<{ current: unknown }>; index: number; element: StubDialog; cleanups: Array<() => void> };
let harness: Harness | null = null;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  /** Effects run at once; a cleanup an effect returns is kept, and `unmount()` runs them (a layout effect's on unmount). */
  const runEffect = (effect: () => void | (() => void)) => {
    const cleanup = effect();
    if (typeof cleanup === 'function') harness!.cleanups.push(cleanup);
  };
  return {
    ...actual,
    useId: (() => (harness ? 'dlg' : actual.useId())) as typeof actual.useId,
    useRef: ((init: unknown) => {
      if (!harness) return actual.useRef(init);
      const h = harness;
      const ref = h.refs[h.index] ?? (h.refs[h.index] = { current: init === null ? h.element : init });
      h.index += 1;
      return ref;
    }) as typeof actual.useRef,
    useEffect: ((effect: () => void | (() => void), deps?: readonly unknown[]) => (harness ? runEffect(effect) : actual.useEffect(effect, deps))) as typeof actual.useEffect,
    useLayoutEffect: ((effect: () => void | (() => void), deps?: readonly unknown[]) => (harness ? runEffect(effect) : actual.useLayoutEffect(effect, deps))) as typeof actual.useLayoutEffect,
  };
});

class StubDialog {
  open = false;
  showModal = vi.fn(() => { this.open = true; });
  close = vi.fn(() => { this.open = false; });
}

/** A native event as React hands it over: on the dialog itself unless `from` names a descendant (a file input). */
type DialogEvent = { target: unknown; currentTarget: unknown };
type Host = ReactElement<{ onCancel: (e: DialogEvent) => void; onClose: (e: DialogEvent) => void }>;

/** Renders like React would on each update: refs persist, effects run; `unmount` runs the kept cleanups. */
function mount(): { element: StubDialog; on: (from?: unknown) => DialogEvent; render: (p: Omit<DialogProps, 'children' | 'actions' | 'title'>) => Host; unmount: () => void } {
  const element = new StubDialog();
  harness = { refs: [], index: 0, element, cleanups: [] };
  return {
    element,
    on: (from) => ({ target: from ?? element, currentTarget: element }),
    render: (p) => {
      harness!.index = 0;
      harness!.cleanups = [];
      return Dialog({ title: 'Archive this project?', actions: null, children: 'Nothing in it can be changed.', ...p }) as Host;
    },
    unmount: () => { for (const c of harness!.cleanups) c(); },
  };
}

afterEach(() => { harness = null; });

const CSS = readFileSync('components/ui/Dialog.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe('Dialog', () => {
  it('renders a native <dialog aria-labelledby> pointing at its title, with no role, no aria-modal and closed on the server', () => {
    const html = renderToStaticMarkup(<Dialog open title="Archive this project?" onClose={() => {}} actions={<button type="button">Cancel</button>}>Nothing in it can be changed.</Dialog>);
    const labelledBy = /^<dialog class="ui-dialog" aria-labelledby="([^"]+)">/.exec(html)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(html).toContain(`<h2 id="${labelledBy}" class="ui-dialog__title">Archive this project?</h2>`);
    expect(html).toContain('<div class="ui-dialog__body">Nothing in it can be changed.</div><div class="ui-dialog__actions"><button type="button">Cancel</button></div></dialog>');
    expect(html).not.toMatch(/role=|aria-modal|\sopen(=|\s|>)|inert/);
  });

  it('opens with showModal() when open is true, and closes when it turns false', () => {
    const onClose = vi.fn();
    const { element, render } = mount();
    render({ open: false, onClose });
    expect(element.showModal).not.toHaveBeenCalled();
    render({ open: true, onClose });
    expect(element.showModal).toHaveBeenCalledTimes(1);
    render({ open: true, onClose });
    expect(element.showModal).toHaveBeenCalledTimes(1);
    render({ open: false, onClose });
    expect(element.close).toHaveBeenCalledTimes(1);
  });

  it('a native cancel event calls onClose once, and the close that follows it (Escape) does not call it again', () => {
    const onClose = vi.fn();
    const { element, on, render } = mount();
    const host = render({ open: true, onClose });
    host.props.onCancel(on());
    expect(onClose).toHaveBeenCalledTimes(1);
    element.open = false;
    host.props.onClose(on());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a close the browser makes while open (a form method="dialog" button) calls onClose once; the caller\'s own close does not', () => {
    const onClose = vi.fn();
    const { element, on, render } = mount();
    const host = render({ open: true, onClose });
    element.open = false;
    host.props.onClose(on());
    expect(onClose).toHaveBeenCalledTimes(1);
    render({ open: false, onClose }).props.onClose(on());
    expect(onClose).toHaveBeenCalledTimes(1);
    // Opened again: a new cancel is reported again.
    render({ open: true, onClose }).props.onCancel(on());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a cancel that bubbles from inside (a file picker dismissed) is not the dialog\'s and calls nothing', () => {
    const onClose = vi.fn();
    const { on, render } = mount();
    render({ open: true, onClose }).props.onCancel(on({ tagName: 'INPUT' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a stale close event that arrives after the dialog was opened again does not report it closed', () => {
    const onClose = vi.fn();
    const { element, on, render } = mount();
    render({ open: true, onClose });
    render({ open: false, onClose });
    const reopened = render({ open: true, onClose });
    expect(element.open).toBe(true);
    reopened.props.onClose(on());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('unmounted while open, it closes the native dialog, so the browser returns focus to the invoker', () => {
    const { element, render, unmount } = mount();
    render({ open: true, onClose: vi.fn() });
    expect(element.open).toBe(true);
    unmount();
    expect(element.close).toHaveBeenCalledTimes(1);
  });

  it('onClose is required: a dialog the browser closes on Escape must be told to its caller', () => {
    const missing = (
      // @ts-expect-error -- DialogProps.onClose is required
      <Dialog open title="t" actions={null}>w</Dialog>
    );
    expect(missing).toBeTruthy();
  });

  it('page scroll is held with the guide\'s CSS, never overflow:hidden on body, and display is never set on a closed dialog', () => {
    expect(rules.find((r) => r.selector === '.ui-dialog:modal')?.body).toMatch(/overscroll-behavior:\s*contain/);
    const backdrop = rules.find((r) => r.selector === '.ui-dialog::backdrop')?.body ?? '';
    expect(backdrop).toMatch(/overflow:\s*hidden/);
    expect(backdrop).toMatch(/overscroll-behavior:\s*contain/);
    expect(CSS).not.toMatch(/(^|[\s,}])(html|body)\b/);
    for (const r of rules.filter((x) => /display:/.test(x.body))) expect(r.selector, r.selector).toMatch(/\[open\]|__/);
  });

  it('the component has no focus trap, no inert handling and no key handler of its own', () => {
    const src = readFileSync('components/ui/Dialog.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/inert|onKeyDown|keydown|addEventListener|\.focus\(|role=|aria-modal|overflow/);
  });
});
