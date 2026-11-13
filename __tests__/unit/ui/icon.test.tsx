import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import { ICONS } from '@/components/ui/icons';
import type { IconName } from '@/components/ui/types';

/** Plan 1A Task 3, spec 7.5: one open-licensed set, inline SVG, one stroke weight, hidden from assistive technology. */

const NAMES: readonly IconName[] = ['home', 'folder', 'flag', 'book-open', 'circle-help', 'users', 'building-2', 'user', 'log-out',
  'sun', 'moon', 'menu', 'x', 'chevron-left', 'chevron-right', 'chevron-down', 'chevrons-up-down', 'arrow-up',
  'paperclip', 'download', 'plus', 'info', 'triangle-alert', 'wifi-off', 'archive', 'clock', 'external-link', 'circle-check'];

describe('Icon', () => {
  it('Icon is hidden from assistive technology', () => expect(renderToStaticMarkup(<Icon name="home" />)).toMatch(/aria-hidden="true"[^>]*focusable="false"/));

  it('the registry holds exactly the 28 names of plan B7, each drawn', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) expect(ICONS[name].length, name).toBeGreaterThan(0);
  });

  it('every icon is stroked in currentColor at one weight, with no fill and no colour of its own', () => {
    for (const name of NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html).toMatch(/<svg class="ui-icon"[^>]*viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/);
      expect(html).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|<title|role=/i);
      expect(html.match(/stroke-width=/g)).toHaveLength(1);
    }
  });

  it('size sets the drawn size, 20 by default', () => {
    expect(renderToStaticMarkup(<Icon name="info" />)).toMatch(/width="20" height="20"/);
    for (const size of [16, 18, 20, 24] as const) expect(renderToStaticMarkup(<Icon name="info" size={size} />)).toMatch(new RegExp(`width="${size}" height="${size}"`));
  });
});
