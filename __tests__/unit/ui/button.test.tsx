import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MouseEvent, ReactElement } from 'react';
import { Button, ButtonLink } from '@/components/ui/Button';

/** Plan 1A Task 4: Button and ButtonLink (spec 7.1 and 7.5, decision B6). */

const CSS = readFileSync('components/ui/Button.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe('Button', () => {
  it('S4-6: the secondary button draws its label and border in the heading role, which is the link colour in light and the bright ink in dark', () => {
    const secondary = rules.find((r) => r.selector === '.ui-button--secondary')!.body;
    expect(secondary).toMatch(/border-color:\s*var\(--color-heading\)/);
    expect(secondary).toMatch(/(?<![-\w])color:\s*var\(--color-heading\)/);
    expect(rules.find((r) => r.selector === '.ui-button--secondary:hover')!.body).toMatch(/(?<![-\w])color:\s*var\(--color-heading\)/);
    // Light is unchanged: the heading and link roles are the same navy there. Dark: the heading role is the bright ink.
    const globals = readFileSync('app/globals.css', 'utf8');
    const block = (selector: string) => {
      const at = globals.indexOf(`${selector} {`);
      return globals.slice(at, globals.indexOf('}', at));
    };
    const value = (b: string, name: string) => new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(b)?.[1];
    const light = block(':root');
    expect(value(light, 'heading')).toBe(value(light, 'link'));
    for (const dark of [block(":root:not([data-theme='light'])"), block(":root[data-theme='dark']")]) {
      expect(value(dark, 'heading')).toBe(value(dark, 'ink'));
      expect(value(dark, 'heading')).not.toBe(value(dark, 'link'));
    }
  });

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

  it('busy: the host handler prevents the default action and never calls the caller\'s onClick', () => {
    const onClick = vi.fn();
    const host = Button({ variant: 'primary', type: 'submit', busy: true, onClick, children: 'Save' }) as ReactElement<{ onClick: (e: MouseEvent<HTMLButtonElement>) => void }>;
    const preventDefault = vi.fn();
    host.props.onClick({ preventDefault } as unknown as MouseEvent<HTMLButtonElement>);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    const idle = Button({ variant: 'primary', onClick, children: 'Save' }) as ReactElement<{ onClick: unknown }>;
    expect(idle.props.onClick).toBe(onClick);
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

  it('never prefetches: its next/link carries a literal prefetch={false}, and the prefetch prop is refused (UX-37, SRS 7.6.4)', () => {
    // The long-list lint (__tests__/lint/no-prefetch-long-lists.test.ts) reads every file a long-list page imports, and it
    // accepts only a literal prefetch={false}: Button.tsx is imported by most pages, so its one Link must carry it.
    const src = readFileSync('components/ui/Button.tsx', 'utf8');
    const links = [...src.matchAll(/<Link\b[^>]*>/g)].map(([tag]) => tag);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/\sprefetch=\{false\}/);
    const refused = (
      // @ts-expect-error -- ButtonLinkProps has no prefetch: nothing can turn prefetching back on.
      <ButtonLink variant="secondary" href="/a" prefetch>A</ButtonLink>
    );
    expect(renderToStaticMarkup(refused)).toMatch(/^<a [^>]*href="\/a"/);
  });
});
