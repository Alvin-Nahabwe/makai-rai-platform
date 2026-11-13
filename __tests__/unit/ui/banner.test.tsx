import { readFileSync } from 'node:fs';
import Link from 'next/link';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Banner, type BannerProps } from '@/components/ui/Banner';
import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { IconName } from '@/components/ui/types';
import { textOf } from '@/__tests__/helpers/markup';

/** Plan 1A Task 6: Banner, a page-wide notice (offline, archived, session, information). */

const CSS = readFileSync('components/ui/Banner.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
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
});
