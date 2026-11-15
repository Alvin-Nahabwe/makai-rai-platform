import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusRegion } from '@/components/ui/StatusRegion';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 6: StatusRegion, the always-mounted line that announces a result (WCAG 4.1.3; decision B5 for errors). */

const CSS = readFileSync('components/ui/StatusRegion.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('StatusRegion', () => {
  it('is present and empty while there is no message, so the message is announced when it arrives', () => {
    expect(renderToStaticMarkup(<StatusRegion message={null} />)).toBe('<div role="status" class="ui-status"></div>');
  });

  it('holds the message as given, politely by default', () => {
    const html = renderToStaticMarkup(<StatusRegion message="Saved. <b>3</b> members were invited." id="invite-status" />);
    expect(html).toMatch(/^<div role="status" id="invite-status" class="ui-status">/);
    expect(textOf(html)).toBe('Saved. <b>3</b> members were invited.');
    expect(html).not.toContain('<b>');
  });

  it('is role="alert" when assertive', () => {
    expect(renderToStaticMarkup(<StatusRegion message={null} politeness="assertive" />)).toBe('<div role="alert" class="ui-status"></div>');
    expect(renderToStaticMarkup(<StatusRegion message="The connection was lost." politeness="assertive" />)).toMatch(/^<div role="alert"/);
  });

  it('an error is ink, bold, with the triangle-alert icon (B5), and stays empty with no message', () => {
    const html = renderToStaticMarkup(<StatusRegion message="The invitation was not sent." tone="error" />);
    expect(html).toMatch(/^<div role="status" class="ui-status ui-status--error"><span class="ui-status__icon"><svg [^>]*aria-hidden="true"/);
    expect(html).toMatch(/<span class="ui-status__text">The invitation was not sent\.<\/span><\/div>$/);
    expect(textOf(html)).toBe('The invitation was not sent.');
    expect(renderToStaticMarkup(<StatusRegion message={null} tone="error" />)).toBe('<div role="status" class="ui-status ui-status--error"></div>');
    expect(renderToStaticMarkup(<StatusRegion message="" tone="error" />)).toBe('<div role="status" class="ui-status ui-status--error"></div>');
    expect(CSS).toMatch(/\.ui-status--error\s*\{[^}]*font-weight:\s*var\(--font-weight-bold\)/);
    expect(CSS).not.toMatch(/--color-overdue|--color-action/);
  });

  it('P2-I1 (SC 1.4.10): the error text beside its icon may shrink and break inside a long address, so the page needs no sideways scroll', () => {
    expect(CSS).toMatch(/\.ui-status__text\s*\{[^}]*min-inline-size:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  });

  it('A-L3: it has no focus prop; a page that moves focus after an answer targets its heading, not the live region', () => {
    expect(readFileSync('components/ui/StatusRegion.tsx', 'utf8')).not.toContain('focusRef');
  });
});
