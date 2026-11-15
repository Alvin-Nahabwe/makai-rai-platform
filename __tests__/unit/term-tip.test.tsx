import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { openOnFocus, TermTip, type TipPopover } from '@/components/ui/TermTip';
import { TERM_FINDING, TERM_NOT_YET } from '@/lib/vocabulary/terms';

/**
 * TermTip (components/ui/TermTip.tsx; the owner's ruling of 15 November 2026, 11:00): a 24px (i) button, named by the
 * caller, that opens a term's definition, the vocabulary's sentence verbatim, on keyboard focus and on a press.
 */
const vocabulary = (JSON.parse(readFileSync('data/vocabulary.json', 'utf8')) as { concepts?: unknown }) as unknown;
/** The definition data/vocabulary.json holds for `id`, wherever the file nests its entries. */
function definitionOf(id: string): string {
  let found: string | undefined;
  const walk = (o: unknown): void => {
    if (found !== undefined || o === null || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const r = o as Record<string, unknown>;
    if (r.id === id && typeof r.definition === 'string') { found = r.definition; return; }
    Object.values(r).forEach(walk);
  };
  walk(vocabulary);
  if (found === undefined) throw new Error(`no definition for ${id} in data/vocabulary.json`);
  return found;
}
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('TermTip', () => {
  it('shows the data/vocabulary.json sentence verbatim, through Definition', () => {
    for (const entry of [TERM_FINDING, TERM_NOT_YET]) {
      const html = renderToStaticMarkup(<TermTip of={entry} label="What is it?" />);
      expect(html).toContain(`<span class="ui-definition" id="term-tip-${entry.id}-def" data-definition="${entry.id}">${escape(definitionOf(entry.id))}</span>`);
    }
  });

  it('the button is named by the caller\'s label, described by the definition, a press shows the popover; the icon is hidden', () => {
    const html = renderToStaticMarkup(<TermTip of={TERM_FINDING} label="What is a finding?" id="strip-finding" />);
    const button = html.match(/<button[^>]*>/)![0];
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="What is a finding?"');
    expect(button).toContain('aria-describedby="strip-finding-def"');
    expect(button).toMatch(/popoverTarget="strip-finding"/i);
    expect(button).toMatch(/popoverTargetAction="show"/i);
    expect(html).toMatch(/<span id="strip-finding" popover="auto" class="ui-term-tip__body">/);
    expect(html).toMatch(/<svg class="ui-icon"[^>]*aria-hidden="true"/);
  });

  it('opens on keyboard focus and closes when focus leaves; the cleanup removes both listeners', () => {
    const button = new EventTarget();
    let open = false;
    const tip: TipPopover = { showPopover: () => { open = true; }, hidePopover: () => { open = false; }, matches: () => open };
    const cleanup = openOnFocus(button, tip);
    button.dispatchEvent(new Event('focus'));
    expect(open).toBe(true);
    button.dispatchEvent(new Event('focus'));   // already open: shown once, no error
    expect(open).toBe(true);
    button.dispatchEvent(new Event('blur'));
    expect(open).toBe(false);
    cleanup();
    button.dispatchEvent(new Event('focus'));
    expect(open).toBe(false);
  });

  it('a 24px target, colour roles only, the focus ring left to the global rule', () => {
    const css = readFileSync('components/ui/TermTip.css', 'utf8');
    expect(css).toMatch(/\.ui-term-tip__button \{[^}]*inline-size: var\(--target-min\);[^}]*block-size: var\(--target-min\);/);
    expect(css).not.toMatch(/outline: none|outline: 0/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(readFileSync('components/ui/TermTip.tsx', 'utf8')).toMatch(/^'use client';/);
  });
});
