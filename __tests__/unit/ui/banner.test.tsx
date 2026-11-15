import { existsSync, readdirSync, readFileSync } from 'node:fs';
import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Banner, type BannerProps } from '@/components/ui/Banner';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/types';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 6: Banner, a page-wide notice (offline, archived, session, information). */

/**
 * The banner's rules are a block of app/globals.css (follow-up B of plan 1A, NFR-PERF-02): from its own comment to the
 * comment that opens the block moved from shell.css, which stays the end of that file (__tests__/unit/ui/shell.test.tsx).
 */
const GLOBALS = readFileSync('app/globals.css', 'utf8');
const BLOCK_START = GLOBALS.indexOf('/* Moved from components/ui/Banner.css');
const BLOCK_END = GLOBALS.indexOf('/* Moved from components/layout/shell.css');
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const CSS = withoutComments(GLOBALS.slice(BLOCK_START, BLOCK_END));
const ICON_OF: Readonly<Record<BannerProps['kind'], IconName>> = { offline: 'wifi-off', archived: 'archive', session: 'clock', info: 'info' };

describe('Banner', () => {
  it('each kind carries its modifier and maps to its icon, hidden, in __icon', () => {
    for (const [kind, icon] of Object.entries(ICON_OF) as Array<[BannerProps['kind'], IconName]>) {
      const html = renderToStaticMarkup(<Banner kind={kind}>Sample notice.</Banner>);
      expect(html, kind).toMatch(new RegExp(`^<div class="ui-banner ui-banner--${kind}">`));
      expect(html, kind).toContain(`<span class="ui-banner__icon">${renderToStaticMarkup(<Icon name={icon} />)}</span>`);
      expect(html, kind).toMatch(/<svg [^>]*aria-hidden="true"/);
    }
  });

  it('adds no live region and no role of its own: a caller that announces it owns the region (OfflineBanner)', () => {
    const html = renderToStaticMarkup(<Banner kind="session" title="Signed out">You were signed out.</Banner>);
    expect(html).not.toMatch(/role=|aria-live/);
  });

  it('renders the title and the words as given, in __body', () => {
    const html = renderToStaticMarkup(<Banner kind="archived" title="Archived <now>">Nothing in it can be changed.</Banner>);
    expect(html).toContain('<div class="ui-banner__body"><p class="ui-banner__title">Archived &lt;now&gt;</p>Nothing in it can be changed.</div>');
    expect(textOf(html)).toBe('Archived <now>Nothing in it can be changed.');
    expect(renderToStaticMarkup(<Banner kind="info">Words.</Banner>)).not.toContain('ui-banner__title');
  });

  it('an action that is a next/link Link renders inside __action, as given', () => {
    const html = renderToStaticMarkup(<Banner kind="session" action={<Link href="/login">Sign in again</Link>}>You were signed out.</Banner>);
    expect(html).toMatch(/<div class="ui-banner__action"><a href="\/login">Sign in again<\/a><\/div><\/div>$/);
    const button = renderToStaticMarkup(<Banner kind="session" action={<ButtonLink variant="secondary" href="/login">Sign in again</ButtonLink>}>Words.</Banner>);
    expect(button).toMatch(/<div class="ui-banner__action"><a class="ui-button ui-button--secondary" href="\/login">Sign in again<\/a><\/div>/);
    expect(renderToStaticMarkup(<Banner kind="info">Words.</Banner>)).not.toContain('ui-banner__action');
  });

  it('is ordinary flow content in ink: nothing fixed or sticky, no orange and no red', () => {
    expect(CSS).not.toMatch(/position:\s*(fixed|sticky)/);
    expect(CSS).not.toMatch(/--color-overdue|--color-action/);
  });

  it('NFR-PERF-02: its rules are one block of app/globals.css, after that file\'s own rules and before the block moved from shell.css, and it has no stylesheet of its own', () => {
    expect(BLOCK_START).toBeGreaterThan(0);
    expect(BLOCK_END).toBeGreaterThan(BLOCK_START);
    // Everything between the two comments is the banner's, so no rule of the file's own follows the block: every
    // selector or at-rule that opens a `{` there, however it is laid out, is one of the five.
    expect([...CSS.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()))
      .toEqual(['.ui-banner', '.ui-banner__icon', '.ui-banner__body', '.ui-banner__title', '.ui-banner__action']);
    // And nothing before or after the block styles a banner.
    expect(withoutComments(GLOBALS.slice(0, BLOCK_START) + GLOBALS.slice(BLOCK_END))).not.toContain('ui-banner');
    // A stylesheet of its own, under any name, would be one more response on every page's first visit (the root layout
    // renders the offline banner): the component imports none, no other stylesheet styles a banner, and the old file
    // is gone and named by nothing.
    const sources = ['app', 'components', 'lib'].flatMap((root) => readdirSync(root, { recursive: true, encoding: 'utf8' }).map((f) => `${root}/${f}`))
      .filter((f) => /\.(tsx?|css)$/.test(f));
    expect(sources.length).toBeGreaterThan(100);
    expect(readFileSync('components/ui/Banner.tsx', 'utf8')).not.toMatch(/\.css['"]/);
    expect(sources.filter((f) => f.endsWith('.css') && f !== 'app/globals.css' && readFileSync(f, 'utf8').includes('ui-banner'))).toEqual([]);
    expect(existsSync('components/ui/Banner.css')).toBe(false);
    expect(sources.filter((f) => /Banner\.css/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))).toEqual([]);
  });

  it('an action that renders nothing (null, false) and an empty title leave no empty wrapper', () => {
    for (const action of [null, false, undefined]) {
      expect(renderToStaticMarkup(<Banner kind="info" action={action}>Words.</Banner>), String(action)).not.toContain('ui-banner__action');
    }
    expect(renderToStaticMarkup(<Banner kind="info" title="">Words.</Banner>)).not.toContain('ui-banner__title');
  });
});
