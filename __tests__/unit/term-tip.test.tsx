import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { closeOnBlur, TermTip, termTipIds, type TipPopover } from '@/components/ui/TermTip';
import { TERM_FINDING, TERM_NOT_YET } from '@/lib/vocabulary/terms';

/**
 * TermTip (components/ui/TermTip.tsx; the owner's ruling of 15 November 2026, 11:00): a 24px (i) button, named by the
 * caller, that opens a term's definition, the vocabulary's sentence verbatim, as a toggletip: on a press (click, tap, Enter
 * or Space), never on focus alone; a second press, Escape, a press elsewhere or focus leaving closes it.
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

  it('the button is named by the caller\'s label, described by the definition, a press toggles the popover; the icon is hidden', () => {
    const html = renderToStaticMarkup(<TermTip of={TERM_FINDING} label="What is a finding?" id="strip-finding" />);
    const button = html.match(/<button[^>]*>/)![0];
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-label="What is a finding?"');
    expect(button).toContain('aria-describedby="strip-finding-def"');
    expect(button).toMatch(/popoverTarget="strip-finding"/i);
    // Toggle: a press (click, tap, Enter or Space on the button) opens it and a second press closes it.
    expect(button).toMatch(/popoverTargetAction="toggle"/i);
    expect(html).toMatch(/<span id="strip-finding" popover="auto" class="ui-term-tip__body">/);
    expect(html).toMatch(/<svg class="ui-icon"[^>]*aria-hidden="true"/);
    // The ids a caller describes another element by come from termTipIds, the same function the tip uses.
    expect(termTipIds(TERM_FINDING, 'strip-finding')).toEqual({ tip: 'strip-finding', definition: 'strip-finding-def' });
    expect(termTipIds(TERM_FINDING)).toEqual({ tip: 'term-tip-finding', definition: 'term-tip-finding-def' });
  });

  it('toggletip: focus alone opens nothing; focus leaving closes an open tip, unless the press that took focus away was inside the tip; the cleanup removes both listeners', () => {
    const button = new EventTarget();
    let open = false;
    const target = new EventTarget();
    const tip: TipPopover & EventTarget = Object.assign(target, { hidePopover: () => { open = false; }, matches: () => open });
    const cleanup = closeOnBlur(button, tip);
    button.dispatchEvent(new Event('focus'));
    expect(open, 'a Tab passing through opens nothing').toBe(false);
    open = true;   // opened by a press (popovertarget)
    tip.dispatchEvent(new Event('pointerdown'));
    button.dispatchEvent(new Event('blur'));
    expect(open, 'a press inside the tip keeps it open, so its sentence can be selected').toBe(true);
    button.dispatchEvent(new Event('blur'));
    expect(open, 'focus leaving closes it').toBe(false);
    cleanup();
    open = true;
    button.dispatchEvent(new Event('blur'));
    expect(open, 'after cleanup nothing listens').toBe(true);
    expect(readFileSync('components/ui/TermTip.tsx', 'utf8')).not.toMatch(/addEventListener\('focus'/);
  });

  it('a 24px target, colour roles only, the focus ring left to the global rule', () => {
    const css = readFileSync('components/ui/TermTip.css', 'utf8');
    expect(css).toMatch(/\.ui-term-tip__button \{[^}]*inline-size: var\(--target-min\);[^}]*block-size: var\(--target-min\);/);
    expect(css).not.toMatch(/outline: none|outline: 0/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(readFileSync('components/ui/TermTip.tsx', 'utf8')).toMatch(/^'use client';/);
    // Placed only where anchor-scope keeps each anchor its own; flips rather than squeezes; never printed.
    expect(css).toMatch(/@supports \(anchor-name: --a\) and \(anchor-scope: all\)/);
    expect(css).toMatch(/position-try-order: most-inline-size;/);
    expect(css).toMatch(/@media print \{\s*\.ui-term-tip \{\s*display: none;/);
  });
});
