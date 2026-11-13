import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, ButtonLink } from '@/components/ui/Button';

/** Plan 1A Task 4: Button and ButtonLink (spec 7.1 and 7.5, decision B6). */

const CSS = readFileSync('components/ui/Button.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe('Button', () => {
  it('with no icon and not busy, the label is the button\'s direct text, with no wrapper element', () => {
    const html = renderToStaticMarkup(<Button variant="secondary">Save my version</Button>);
    expect(html).toMatch(/<button[^>]*>Save my version<\/button>/);
  });

  it('carries its variant class and is type="button" unless told otherwise', () => {
    const html = renderToStaticMarkup(<Button variant="primary">Save decision</Button>);
    expect(html).toMatch(/^<button [^>]*class="ui-button ui-button--primary"/);
    expect(html).toContain('type="button"');
    expect(renderToStaticMarkup(<Button variant="primary" type="submit">Save</Button>)).toContain('type="submit"');
    expect(renderToStaticMarkup(<Button variant="quiet" size="compact">Hide</Button>)).toContain('class="ui-button ui-button--quiet ui-button--compact"');
  });

  it('busy sets aria-busy, keeps the label and a spinner, and is not disabled (focus stays)', () => {
    const html = renderToStaticMarkup(<Button variant="primary" busy>Save decision</Button>);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html).toContain('Save decision');
    expect(html).toMatch(/<span class="ui-button__spinner" aria-hidden="true"><\/span>/);
  });

  it('disabled reaches the native button; an icon sits in __icon, hidden, before or after the label', () => {
    expect(renderToStaticMarkup(<Button variant="secondary" disabled>Save</Button>)).toMatch(/<button[^>]* disabled=""/);
    const start = renderToStaticMarkup(<Button variant="secondary" icon="paperclip">Add evidence</Button>);
    expect(start).toMatch(/<span class="ui-button__icon"><svg [^>]*aria-hidden="true"[\s\S]*<\/span>Add evidence<\/button>$/);
    const end = renderToStaticMarkup(<Button variant="secondary" icon="chevron-right" iconPosition="end">Next</Button>);
    expect(end).toMatch(/>Next<span class="ui-button__icon">/);
  });

  it('passes form, name, value and aria-describedby to the native button', () => {
    const html = renderToStaticMarkup(<Button variant="primary" type="submit" form="f" name="intent" value="save" aria-describedby="note">Save</Button>);
    expect(html).toContain('form="f"');
    expect(html).toContain('name="intent"');
    expect(html).toContain('value="save"');
    expect(html).toContain('aria-describedby="note"');
  });

  it('the destructive variant uses neither the action orange nor the overdue red (B6)', () => {
    const destructive = rules.filter((r) => r.selector.includes('--destructive'));
    expect(destructive.length).toBeGreaterThan(0);
    for (const r of destructive) {
      expect(r.body, r.selector).not.toMatch(/--color-action|--color-overdue/);
    }
  });

  it('the base button is 44 px high at least, the compact one 32 px; pressed and busy rules exist', () => {
    const base = rules.find((r) => r.selector === '.ui-button');
    expect(base?.body).toMatch(/min-height:\s*var\(--target-primary\)/);
    expect(rules.some((r) => /--primary/.test(r.selector) && /min-height/.test(r.body))).toBe(false);
    expect(rules.find((r) => r.selector === '.ui-button--compact')?.body).toMatch(/min-height:\s*32px/);
    expect(rules.some((r) => /\.ui-button[^,]*:active/.test(r.selector))).toBe(true);
    expect(rules.some((r) => /\.ui-button\[aria-busy=['"]?true['"]?\]/.test(r.selector))).toBe(true);
  });

  it('the spinner turns only when motion is allowed', () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^}]*\.ui-button__spinner\s*\{[^}]*animation:/);
    expect(rules.find((r) => r.selector === '.ui-button__spinner')?.body ?? '').not.toMatch(/animation/);
  });
});

describe('ButtonLink', () => {
  it('is a link with the button\'s classes, its href unchanged', () => {
    const html = renderToStaticMarkup(<ButtonLink variant="secondary" href="/orgs/a/projects">Projects</ButtonLink>);
    expect(html).toMatch(/^<a [^>]*class="ui-button ui-button--secondary"[^>]*>Projects<\/a>$/);
    expect(html).toContain('href="/orgs/a/projects"');
  });
});
