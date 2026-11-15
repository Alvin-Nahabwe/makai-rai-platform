import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner's ruling, 15 Nov 2026 13:33: the ring at the end of each stage line is navy like the other stops, so orange
 * appears only on the one primary action. The line, its rings and the head disc all take --color-mark.
 */
const CSS = readFileSync(join(process.cwd(), 'components/project/ProjectPage.css'), 'utf8');
const rule = (selector: string) => {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at));
};

describe('S-10 stage line rings (owner 13:33)', () => {
  it('the last stop ring is drawn in --color-mark, not the action orange', () => {
    const last = rule('.stage-line__stop--last::after');
    expect(last).toMatch(/border:\s*4px solid var\(--color-mark\)/);
    expect(last).not.toMatch(/--color-action/);
  });

  it('no stop marker or line segment uses an action colour', () => {
    for (const selector of ['.stage-line__stop::before', '.stage-line__stop::after', '.stage-line__stop--head::after', '.stage-line__stop--last::before', '.stage-line__stop--last::after']) {
      expect(rule(selector), selector).not.toMatch(/--color-action/);
    }
  });
});
