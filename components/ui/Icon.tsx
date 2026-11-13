import { createElement, type ReactElement } from 'react';
import { ICONS } from '@/components/ui/icons';
import type { IconName } from '@/components/ui/types';
import './Icon.css';

export type IconProps = { name: IconName; size?: 16 | 18 | 20 | 24 };

/**
 * One icon of the kit (spec 7.5): inline SVG, stroked in currentColor at one weight, always beside a word, so it is
 * hidden from assistive technology and never focusable. The word, not the icon, names the thing.
 */
export function Icon({ name, size = 20 }: IconProps): ReactElement {
  return (
    <svg className="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {ICONS[name].map(([tag, attributes], i) => createElement(tag, { key: i, ...attributes }))}
    </svg>
  );
}
